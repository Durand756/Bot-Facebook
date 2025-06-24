const login = require('fca-unofficial'); // Remplacé fb-chat-api par fca-unofficial
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
    // Options de connexion adaptées à fca-unofficial
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

    // Logger amélioré
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

    // Chargement de l'appstate optimisé pour fca-unofficial
    async loadAppState() {
        try {
            if (!fsSync.existsSync(CONFIG.APPSTATE_FILE)) {
                throw new Error(`Fichier ${CONFIG.APPSTATE_FILE} manquant`);
            }

            const appStateData = await fs.readFile(CONFIG.APPSTATE_FILE, 'utf8');
            let appState = JSON.parse(appStateData);

            // Validation de l'appstate
            if (!Array.isArray(appState) || appState.length === 0) {
                throw new Error('Format appstate invalide');
            }

            // Vérifier les cookies critiques pour fca-unofficial
            const criticalCookies = ['c_user', 'xs', 'datr', 'fr', 'sb'];
            const presentCritical = criticalCookies.filter(name => 
                appState.some(cookie => cookie.key === name || cookie.name === name)
            );

            if (presentCritical.length < 3) {
                throw new Error(`Cookies critiques manquants. Présents: ${presentCritical.join(', ')}`);
            }

            this.log('info', `AppState chargé avec ${appState.length} cookies`);
            this.log('info', `Cookies critiques: ${presentCritical.join(', ')}`);
            
            return appState;

        } catch (error) {
            this.log('error', 'Erreur chargement appstate:', error.message);
            throw error;
        }
    }

    // Sauvegarder l'appstate
    async saveAppState(appState) {
        try {
            const appStateJson = JSON.stringify(appState, null, 2);
            await fs.writeFile(CONFIG.APPSTATE_FILE, appStateJson);
            this.log('info', 'AppState sauvegardé avec succès');
        } catch (error) {
            this.log('error', 'Erreur sauvegarde appstate:', error.message);
        }
    }

    // Chargement des commandes
    async loadCommands(force = false) {
        try {
            if (!force && this.commands.size > 0) {
                const commandsDir = await fs.stat(CONFIG.COMMANDS_DIR).catch(() => null);
                if (commandsDir && commandsDir.mtime <= this.commandsLastLoaded) {
                    return this.commands;
                }
            }

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
                    } else {
                        this.log('warn', `Commande invalide ignorée: ${commandName}`);
                    }
                } catch (error) {
                    this.log('error', `Erreur chargement ${file}:`, error.message);
                }
            }

            this.commandsLastLoaded = Date.now();
            this.log('info', `${loadedCount} commande(s) chargée(s)`);
            return this.commands;

        } catch (error) {
            this.log('error', 'Erreur chargement commandes:', error.message);
            return this.commands;
        }
    }

    // Gestionnaire de messages optimisé pour fca-unofficial
    async handleMessage(event) {
        try {
            // Vérifier le type d'événement
            if (event.type !== 'message') return;
            
            // Ignorer ses propres messages et messages vides
            if (!event.body || 
                event.senderID === this.api.getCurrentUserID() ||
                event.isGroup === false && event.senderID === event.threadID) {
                return;
            }

            const messageBody = event.body.trim();
            if (!messageBody.startsWith(CONFIG.COMMAND_PREFIX)) return;

            // Parser la commande
            const args = messageBody.slice(CONFIG.COMMAND_PREFIX.length).trim().split(/\s+/);
            const commandName = args.shift()?.toLowerCase();
            
            if (!commandName) return;

            // Marquer comme lu (avec gestion d'erreur améliorée)
            try {
                await this.markAsRead(event.threadID);
            } catch (error) {
                this.log('warn', 'Erreur markAsRead:', error.message);
            }

            // Recharger les commandes si nécessaire
            await this.loadCommands();

            // Vérifier l'existence de la commande
            if (!this.commands.has(commandName)) {
                await this.sendMessage(
                    `❌ Commande "${commandName}" introuvable. Tapez ${CONFIG.COMMAND_PREFIX}help pour voir les commandes disponibles.`,
                    event.threadID
                );
                return;
            }

            // Obtenir les infos utilisateur
            const userInfo = await this.getUserInfo(event.senderID);
            const senderName = userInfo?.name || 'Utilisateur inconnu';

            // Logger la commande
            const logEntry = `[${new Date().toISOString()}] ${senderName} (${event.senderID}) - Commande: ${CONFIG.COMMAND_PREFIX}${commandName} ${args.join(' ')}\n`;
            this.writeLog(logEntry);

            this.log('info', `Exécution: ${commandName} par ${senderName}`);

            // Exécuter la commande avec timeout
            const command = this.commands.get(commandName);
            await Promise.race([
                command(args, this.api, event),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Timeout commande')), 30000)
                )
            ]);

        } catch (error) {
            this.log('error', 'Erreur handleMessage:', error.message);
            if (event.threadID) {
                await this.sendMessage(
                    `❌ Erreur lors de l'exécution: ${error.message}`,
                    event.threadID
                ).catch(() => {});
            }
        }
    }

    // Wrapper pour markAsRead avec Promise
    async markAsRead(threadID) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout markAsRead')), 5000);
            
            this.api.markAsRead(threadID, (err) => {
                clearTimeout(timeout);
                if (err) reject(err);
                else resolve();
            });
        });
    }

    // Wrapper sécurisé pour getUserInfo
    async getUserInfo(userID) {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(null), 5000);
            
            this.api.getUserInfo(userID, (err, ret) => {
                clearTimeout(timeout);
                if (err || !ret || !ret[userID]) {
                    resolve(null);
                } else {
                    resolve(ret[userID]);
                }
            });
        });
    }

    // Wrapper sécurisé pour sendMessage
    async sendMessage(message, threadID) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout envoi message')), 10000);
            
            this.api.sendMessage(message, threadID, (err, messageInfo) => {
                clearTimeout(timeout);
                if (err) reject(err);
                else resolve(messageInfo);
            });
        });
    }

    // Connexion optimisée pour fca-unofficial
    async connect() {
        try {
            let loginCredentials = {};

            if (CONFIG.LOGIN_METHOD === 'credentials' && CONFIG.FB_EMAIL && CONFIG.FB_PASSWORD) {
                this.log('info', 'Tentative de connexion avec email/mot de passe');
                loginCredentials = {
                    email: CONFIG.FB_EMAIL,
                    password: CONFIG.FB_PASSWORD
                };
            } else {
                this.log('info', 'Tentative de connexion avec appstate');
                const appState = await this.loadAppState();
                loginCredentials = {
                    appState: appState
                };
            }

            // Options de connexion optimisées pour fca-unofficial
            const loginOptions = {
                listenEvents: true,
                logLevel: 'silent',
                updatePresence: false,
                selfListen: false,
                forceLogin: true,
                autoMarkDelivery: false,
                autoMarkRead: false,
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            };

            if (CONFIG.PAGE_ID) {
                loginOptions.pageID = CONFIG.PAGE_ID;
            }

            return new Promise((resolve, reject) => {
                login(loginCredentials, loginOptions, (err, api) => {
                    if (err) {
                        this.log('error', 'Erreur connexion:', err.message || err.error);
                        
                        // Messages d'erreur spécifiques pour fca-unofficial
                        if (err.error === 'login-approval') {
                            this.log('error', 'Approbation de connexion requise - Vérifiez votre email/SMS');
                        } else if (err.error === 'checkpoint') {
                            this.log('error', 'Checkpoint de sécurité détecté - Connexion via navigateur requise');
                        } else if (err.error === 'Wrong username/password.') {
                            this.log('error', 'Email ou mot de passe incorrect');
                        }
                        
                        reject(err);
                        return;
                    }

                    this.api = api;
                    
                    // Configuration de l'API pour fca-unofficial
                    api.setOptions({
                        listenEvents: true,
                        logLevel: 'silent',
                        updatePresence: false,
                        selfListen: false,
                        forceLogin: true,
                        autoMarkDelivery: false,
                        autoMarkRead: false
                    });

                    // Sauvegarder l'appstate après connexion réussie
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

    // Validation de la configuration
    validateLoginConfig() {
        if (CONFIG.LOGIN_METHOD === 'credentials') {
            if (!CONFIG.FB_EMAIL || !CONFIG.FB_PASSWORD) {
                throw new Error('FB_EMAIL et FB_PASSWORD requis pour LOGIN_METHOD=credentials');
            }
            this.log('info', `Email configuré: ${CONFIG.FB_EMAIL.substring(0, 3)}***`);
        } else {
            if (!fsSync.existsSync(CONFIG.APPSTATE_FILE)) {
                throw new Error(`Fichier ${CONFIG.APPSTATE_FILE} manquant pour LOGIN_METHOD=appstate`);
            }
            this.log('info', 'Fichier appstate trouvé');
        }
    }

    // Démarrage avec retry
    async start() {
        try {
            this.validateLoginConfig();
        } catch (error) {
            this.log('error', 'Configuration invalide:', error.message);
            process.exit(1);
        }

        while (this.retryCount < CONFIG.MAX_RETRIES && !this.isShuttingDown) {
            try {
                this.log('info', `Tentative de connexion ${this.retryCount + 1}/${CONFIG.MAX_RETRIES}`);
                
                await this.connect();
                this.log('info', '✅ Connexion réussie avec fca-unofficial!');
                
                // Charger les commandes
                await this.loadCommands(true);
                
                // Démarrer l'écoute
                this.startListening();
                
                // Démarrer le serveur HTTP
                this.startHttpServer();
                
                this.retryCount = 0;
                return;

            } catch (error) {
                this.retryCount++;
                this.log('error', `Échec connexion (${this.retryCount}/${CONFIG.MAX_RETRIES}):`, error.message);
                
                if (this.retryCount < CONFIG.MAX_RETRIES) {
                    this.log('info', `Nouvelle tentative dans ${CONFIG.RETRY_DELAY/1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
                } else {
                    this.log('error', 'Nombre maximum de tentatives atteint');
                    process.exit(1);
                }
            }
        }
    }

    // Écoute des messages optimisée pour fca-unofficial
    startListening() {
        try {
            // fca-unofficial utilise la méthode listen standard
            this.stopListening = this.api.listen((err, event) => {
                if (err) {
                    this.log('error', 'Erreur écoute:', err.message);
                    
                    // Gestion des erreurs spécifiques à fca-unofficial
                    if (err.error === 'Connection closed.' || err.message.includes('Connection closed')) {
                        this.log('info', 'Connexion fermée - Reconnexion automatique...');
                        setTimeout(() => this.start(), 5000);
                    } else if (err.message && err.message.includes('Not logged in')) {
                        this.log('error', 'Session expirée - Redémarrage requis');
                        setTimeout(() => this.start(), 3000);
                    }
                    return;
                }

                // Traiter l'événement
                this.handleMessage(event);
            });

            this.log('info', '🤖 Bot démarré avec fca-unofficial et en écoute...');
            this.log('info', `💬 Préfixe: ${CONFIG.COMMAND_PREFIX}`);
            this.log('info', `🔐 Méthode: ${CONFIG.LOGIN_METHOD}`);
            
        } catch (error) {
            this.log('error', 'Erreur startListening:', error.message);
            setTimeout(() => this.start(), 5000);
        }
    }

    // Serveur HTTP pour monitoring
    startHttpServer() {
        this.server = http.createServer((req, res) => {
            res.writeHead(200, { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            
            const status = {
                status: 'Bot Facebook Messenger actif (fca-unofficial)',
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                commands: this.commands.size,
                retryCount: this.retryCount,
                loginMethod: CONFIG.LOGIN_METHOD,
                memory: process.memoryUsage(),
                api_connected: this.api ? true : false,
                library: 'fca-unofficial'
            };
            
            res.end(JSON.stringify(status, null, 2));
        });

        this.server.listen(CONFIG.PORT, () => {
            this.log('info', `🌐 Serveur HTTP sur port ${CONFIG.PORT}`);
        });

        this.server.on('error', (error) => {
            this.log('error', 'Erreur serveur HTTP:', error.message);
        });
    }

    // Arrêt propre
    async shutdown() {
        if (this.isShuttingDown) return;
        
        this.isShuttingDown = true;
        this.log('info', '🛑 Arrêt du bot...');

        try {
            if (this.stopListening) {
                this.stopListening();
            }
            
            if (this.server) {
                this.server.close();
            }
            
            if (this.api) {
                this.api.logout?.();
            }
            
        } catch (error) {
            this.log('error', 'Erreur lors de l\'arrêt:', error.message);
        }

        process.exit(0);
    }
}

// Initialisation
const bot = new FacebookBot();

// Gestion des signaux
process.on('SIGINT', () => bot.shutdown());
process.on('SIGTERM', () => bot.shutdown());

// Gestion des erreurs
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
    bot.log('error', 'Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    bot.log('error', 'Uncaught Exception:', error.message);
    bot.shutdown();
});

// Démarrage
bot.start().catch((error) => {
    console.error('Erreur fatale au démarrage:', error);
    process.exit(1);
});
