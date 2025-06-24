const login = require('@xaviabot/fca-unofficial'); // Package qui fonctionne
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
require('dotenv').config();

// Configuration avec validation
const CONFIG = {
    COMMAND_PREFIX: process.env.COMMAND_PREFIX || '/',
    COMMANDS_DIR: path.join(__dirname, 'Commandes'),
    APPSTATE_FILE: 'appstate.json',
    LOGS_FILE: 'logs.txt',
    PORT: process.env.PORT || 3000,
    MAX_RETRIES: 3,
    RETRY_DELAY: 5000,
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    LOGIN_METHOD: process.env.LOGIN_METHOD || 'appstate',
    FB_EMAIL: process.env.FB_EMAIL || '',
    FB_PASSWORD: process.env.FB_PASSWORD || '',
    PAGE_ID: process.env.PAGE_ID || null
};

class FacebookBot extends EventEmitter {
    constructor() {
        super();
        this.api = null;
        this.commands = new Map();
        this.retryCount = 0;
        this.isShuttingDown = false;
        this.server = null;
        this.commandsLastLoaded = 0;
        this.stopListening = null;
    }

    log(level, message, data = null) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
        
        if (data) {
            console.log(logMessage, data);
        } else {
            console.log(logMessage);
        }

        if (['error', 'warn'].includes(level)) {
            this.writeLog(`${logMessage}${data ? ` - Data: ${JSON.stringify(data)}` : ''}\n`);
        }
    }

    async writeLog(logEntry) {
        try {
            await fs.appendFile(CONFIG.LOGS_FILE, logEntry);
        } catch (error) {
            console.error('Erreur écriture log:', error.message);
        }
    }

    async loadAppState() {
        try {
            if (!fsSync.existsSync(CONFIG.APPSTATE_FILE)) {
                throw new Error(`Fichier ${CONFIG.APPSTATE_FILE} manquant`);
            }

            const appStateData = await fs.readFile(CONFIG.APPSTATE_FILE, 'utf8');
            let appState = JSON.parse(appStateData);

            if (!Array.isArray(appState) || appState.length === 0) {
                throw new Error('Format appstate invalide');
            }

            const criticalCookies = ['c_user', 'xs', 'datr', 'fr'];
            const presentCritical = criticalCookies.filter(name => 
                appState.some(cookie => cookie.key === name || cookie.name === name)
            );

            if (presentCritical.length < 2) {
                throw new Error(`Cookies critiques manquants. Présents: ${presentCritical.join(', ')}`);
            }

            this.log('info', `AppState chargé avec ${appState.length} cookies`);
            return appState;

        } catch (error) {
            this.log('error', 'Erreur chargement appstate:', error.message);
            throw error;
        }
    }

    async saveAppState(appState) {
        try {
            const appStateJson = JSON.stringify(appState, null, 2);
            await fs.writeFile(CONFIG.APPSTATE_FILE, appStateJson);
            this.log('info', 'AppState sauvegardé avec succès');
        } catch (error) {
            this.log('error', 'Erreur sauvegarde appstate:', error.message);
        }
    }

    async loadCommands(force = false) {
        try {
            if (!fsSync.existsSync(CONFIG.COMMANDS_DIR)) {
                await fs.mkdir(CONFIG.COMMANDS_DIR, { recursive: true });
                this.log('info', 'Dossier Commandes/ créé');
                return this.commands;
            }

            const commandFiles = await fs.readdir(CONFIG.COMMANDS_DIR);
            const jsFiles = commandFiles.filter(file => file.endsWith('.js'));
            
            this.commands.clear();
            let loadedCount = 0;

            for (const file of jsFiles) {
                try {
                    const commandName = path.basename(file, '.js');
                    const commandPath = path.join(CONFIG.COMMANDS_DIR, file);
                    
                    delete require.cache[require.resolve(commandPath)];
                    const command = require(commandPath);
                    
                    if (typeof command === 'function') {
                        this.commands.set(commandName, command);
                        loadedCount++;
                        this.log('info', `Commande chargée: ${commandName}`);
                    }
                } catch (error) {
                    this.log('error', `Erreur chargement ${file}:`, error.message);
                }
            }

            this.log('info', `${loadedCount} commande(s) chargée(s)`);
            return this.commands;

        } catch (error) {
            this.log('error', 'Erreur chargement commandes:', error.message);
            return this.commands;
        }
    }

    async handleMessage(event) {
        try {
            if (event.type !== 'message' || !event.body) return;
            
            if (event.senderID === this.api.getCurrentUserID()) return;

            const messageBody = event.body.trim();
            if (!messageBody.startsWith(CONFIG.COMMAND_PREFIX)) return;

            const [commandName, ...args] = messageBody.slice(CONFIG.COMMAND_PREFIX.length).trim().split(/\s+/);
            if (!commandName) return;

            await this.loadCommands();

            if (!this.commands.has(commandName.toLowerCase())) {
                await this.sendMessage(
                    `❌ Commande "${commandName}" introuvable.`,
                    event.threadID
                );
                return;
            }

            this.log('info', `Exécution: ${commandName}`);

            const command = this.commands.get(commandName.toLowerCase());
            await command(args, this.api, event);

        } catch (error) {
            this.log('error', 'Erreur handleMessage:', error.message);
            if (event.threadID) {
                await this.sendMessage(
                    `❌ Erreur: ${error.message}`,
                    event.threadID
                ).catch(() => {});
            }
        }
    }

    async sendMessage(message, threadID) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);
            
            this.api.sendMessage(message, threadID, (err, info) => {
                clearTimeout(timeout);
                if (err) reject(err);
                else resolve(info);
            });
        });
    }

    async connect() {
        try {
            let credentials = {};

            if (CONFIG.LOGIN_METHOD === 'credentials' && CONFIG.FB_EMAIL && CONFIG.FB_PASSWORD) {
                credentials = {
                    email: CONFIG.FB_EMAIL,
                    password: CONFIG.FB_PASSWORD
                };
            } else {
                const appState = await this.loadAppState();
                credentials = { appState };
            }

            const options = {
                listenEvents: true,
                logLevel: 'silent',
                selfListen: false,
                updatePresence: false
            };

            return new Promise((resolve, reject) => {
                login(credentials, options, (err, api) => {
                    if (err) {
                        this.log('error', 'Erreur connexion:', err.message);
                        reject(err);
                        return;
                    }

                    this.api = api;
                    
                    // Sauvegarder appstate si connexion par credentials
                    if (CONFIG.LOGIN_METHOD === 'credentials' && api.getAppState) {
                        this.saveAppState(api.getAppState());
                    }

                    resolve(api);
                });
            });

        } catch (error) {
            throw error;
        }
    }

    async start() {
        while (this.retryCount < CONFIG.MAX_RETRIES && !this.isShuttingDown) {
            try {
                this.log('info', `Connexion ${this.retryCount + 1}/${CONFIG.MAX_RETRIES}`);
                
                await this.connect();
                this.log('info', '✅ Connexion réussie!');
                
                await this.loadCommands(true);
                this.startListening();
                this.startHttpServer();
                
                this.retryCount = 0;
                return;

            } catch (error) {
                this.retryCount++;
                this.log('error', `Échec ${this.retryCount}:`, error.message);
                
                if (this.retryCount < CONFIG.MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY));
                } else {
                    process.exit(1);
                }
            }
        }
    }

    startListening() {
        try {
            this.stopListening = this.api.listen((err, event) => {
                if (err) {
                    this.log('error', 'Erreur écoute:', err.message);
                    if (err.message.includes('Connection closed')) {
                        setTimeout(() => this.start(), 5000);
                    }
                    return;
                }
                this.handleMessage(event);
            });

            this.log('info', '🤖 Bot en écoute...');
            this.log('info', `💬 Préfixe: ${CONFIG.COMMAND_PREFIX}`);
            
        } catch (error) {
            this.log('error', 'Erreur startListening:', error.message);
            setTimeout(() => this.start(), 5000);
        }
    }

    startHttpServer() {
        this.server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'Bot Facebook actif',
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                commands: this.commands.size,
                library: '@xaviabot/fca-unofficial'
            }, null, 2));
        });

        this.server.listen(CONFIG.PORT, () => {
            this.log('info', `🌐 Serveur sur port ${CONFIG.PORT}`);
        });
    }

    async shutdown() {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        this.log('info', '🛑 Arrêt du bot...');

        try {
            if (this.stopListening) this.stopListening();
            if (this.server) this.server.close();
            if (this.api) this.api.logout?.();
        } catch (error) {
            this.log('error', 'Erreur arrêt:', error.message);
        }

        process.exit(0);
    }
}

// Initialisation
const bot = new FacebookBot();

process.on('SIGINT', () => bot.shutdown());
process.on('SIGTERM', () => bot.shutdown());

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
    bot.log('error', 'Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    bot.log('error', 'Uncaught Exception:', error.message);
    bot.shutdown();
});

bot.start().catch((error) => {
    console.error('Erreur fatale:', error);
    process.exit(1);
});
