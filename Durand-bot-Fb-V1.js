const login = require('facebook-chat-api'); // Package principal facebook-chat-api
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

    // Normalisation et validation de l'appstate
    normalizeAppState(appState) {
        if (!Array.isArray(appState)) {
            throw new Error('AppState doit être un tableau');
        }

        return appState.map(cookie => {
            // Normaliser la structure du cookie
            const normalizedCookie = {
                key: cookie.key || cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path || '/',
                hostOnly: cookie.hostOnly || false,
                creation: cookie.creation || new Date().toISOString(),
                lastAccessed: cookie.lastAccessed || new Date().toISOString()
            };

            // Correction spécifique pour les domaines Facebook
            if (normalizedCookie.domain) {
                // Normaliser les domaines Facebook
                if (normalizedCookie.domain === '.facebook.com' || 
                    normalizedCookie.domain === 'facebook.com' ||
                    normalizedCookie.domain === 'www.facebook.com') {
                    normalizedCookie.domain = '.facebook.com';
                }
                // Ajouter des cookies pour messenger.com si nécessaire
                if (normalizedCookie.domain === '.facebook.com') {
                    // Certains cookies doivent être dupliqués pour messenger.com
                    const messengerCompatible = ['datr', 'fr', 'sb', 'c_user', 'xs'];
                    if (messengerCompatible.includes(normalizedCookie.key)) {
                        // Créer une copie pour messenger.com
                        const messengerCookie = {
                            ...normalizedCookie,
                            domain: '.messenger.com'
                        };
                        return [normalizedCookie, messengerCookie];
                    }
                }
            }

            return normalizedCookie;
        }).flat(); // Aplatir le tableau pour inclure les cookies dupliqués
    }

    // Chargement de l'appstate avec correction
    async loadAppState() {
        try {
            if (!fsSync.existsSync(CONFIG.APPSTATE_FILE)) {
                throw new Error(`Fichier ${CONFIG.APPSTATE_FILE} manquant`);
            }

            const appStateData = await fs.readFile(CONFIG.APPSTATE_FILE, 'utf8');
            let appState = JSON.parse(appStateData);

            // Normaliser l'appstate
            appState = this.normalizeAppState(appState);

            // Validation de l'appstate
            if (!Array.isArray(appState) || appState.length === 0) {
                throw new Error('Format appstate invalide après normalisation');
            }

            // Vérifier les cookies critiques
            const criticalCookies = ['c_user', 'xs', 'datr', 'fr'];
            const presentCritical = criticalCookies.filter(name => 
                appState.some(cookie => (cookie.key === name || cookie.name === name))
            );

            if (presentCritical.length < 2) {
                throw new Error(`Cookies critiques manquants. Présents: ${presentCritical.join(', ')}`);
            }

            this.log('info', `AppState normalisé avec ${appState.length} cookies`);
            this.log('info', `Cookies critiques: ${presentCritical.join(', ')}`);
            
            // Sauvegarder l'appstate normalisé
            await this.saveAppState(appState);
            
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

    // Gestionnaire de messages
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

            // Marquer comme lu
            this.api.markAsRead(event.threadID, (err) => {
                if (err) this.log('warn', 'Erreur markAsRead:', err.message);
            });

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

            // Exécuter la commande
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

    // Connexion avec options améliorées
    async connect() {
        try {
            let loginOptions = {};

            if (CONFIG.LOGIN_METHOD === 'credentials' && CONFIG.FB_EMAIL && CONFIG.FB_PASSWORD) {
                this.log('info', 'Tentative de connexion avec email/mot de passe');
                loginOptions = {
                    email: CONFIG.FB_EMAIL,
                    password: CONFIG.FB_PASSWORD
                };
            } else {
                this.log('info', 'Tentative de connexion avec appstate');
                const appState = await this.loadAppState();
                loginOptions = {
                    appState: appState
                };
            }

            // Options de connexion optimisées pour éviter les erreurs de domaine
            const connectionOptions = {
                listenEvents: true,
                logLevel: 'silent',
                updatePresence: false,
                selfListen: false,
                forceLogin: true,
                autoMarkDelivery: false,
                autoMarkRead: false,
                listenTyping: false,
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                // Options spécifiques pour éviter les conflits de cookies
                online: false,
                emitReady: false
            };

            if (CONFIG.PAGE_ID) {
                connectionOptions.pageID = CONFIG.PAGE_ID;
            }

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Timeout de connexion (60s)'));
                }, 60000);

                login(loginOptions, connectionOptions, (err, api) => {
                    clearTimeout(timeout);
                    
                    if (err) {
                        this.log('error', 'Erreur connexion:', err.message || err.error);
                        
                        // Messages d'erreur spécifiques
                        if (err.error === 'login-approval') {
                            this.log('error', 'Approbation de connexion requise');
                        } else if (err.error === 'checkpoint') {
                            this.log('error', 'Checkpoint de sécurité détecté');
                        } else if (err.message && err.message.includes('Cookie not in this host\'s domain')) {
                            this.log('error', 'Erreur de domaine de cookies - tentative de correction');
                            // Essayer de nettoyer et recréer l'appstate
                            this.cleanAppState().then(() => {
                                reject(new Error('AppState nettoyé, veuillez relancer'));
                            }).catch(() => {
                                reject(err);
                            });
                            return;
                        }
                        
                        reject(err);
                        return;
                    }

                    this.api = api;
                    
                    // Configuration de l'API
                    api.setOptions({
                        listenEvents: true,
                        logLevel: 'silent',
                        updatePresence: false,
                        selfListen: false,
                        forceLogin: true,
                        autoMarkDelivery: false,
                        autoMarkRead: false,
                        online: false
                    });

                    // Sauvegarder l'appstate après connexion réussie
                    if (api.getAppState) {
                        const newAppState = this.normalizeAppState(api.getAppState());
                        this.saveAppState(newAppState);
                    }

                    resolve(api);
                });
            });

        } catch (error) {
            throw error;
        }
    }

    // Nettoyage de l'appstate en cas d'erreur de cookies
    async cleanAppState() {
        try {
            this.log('info', 'Nettoyage de l\'appstate...');
            
            if (fsSync.existsSync(CONFIG.APPSTATE_FILE)) {
                const backupFile = `${CONFIG.APPSTATE_FILE}.backup.${Date.now()}`;
                await fs.copyFile(CONFIG.APPSTATE_FILE, backupFile);
                this.log('info', `Sauvegarde créée: ${backupFile}`);
                
                // Supprimer l'appstate corrompu
                await fs.unlink(CONFIG.APPSTATE_FILE);
                this.log('info', 'AppState corrompu supprimé');
            }
        } catch (error) {
            this.log('error', 'Erreur nettoyage appstate:', error.message);
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

    // Démarrage avec retry amélioré
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
                this.log('info', '✅ Connexion réussie!');
                
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
                    
                    // Dernière tentative de nettoyage avant abandon
                    if (error.message.includes('Cookie') || error.message.includes('domain')) {
                        this.log('info', 'Tentative de nettoyage final de l\'appstate...');
                        await this.cleanAppState();
                        this.log('error', 'Veuillez vous reconnecter à Facebook et générer un nouvel appstate');
                    }
                    
                    process.exit(1);
                }
            }
        }
    }

    // Écoute des messages avec gestion d'erreurs améliorée
    startListening() {
        try {
            // Utiliser listen ou listenMqtt selon la disponibilité
            const listenMethod = this.api.listenMqtt || this.api.listen;
            
            this.stopListening = listenMethod.call(this.api, (err, event) => {
                if (err) {
                    this.log('error', 'Erreur écoute:', err.message);
                    
                    // Gestion spécifique des erreurs
                    if (err.message && err.message.includes('successful_results')) {
                        this.log('warn', 'Erreur successful_results détectée - redémarrage écoute');
                        setTimeout(() => {
                            if (!this.isShuttingDown) {
                                this.log('info', 'Redémarrage de l\'écoute...');
                                this.startListening();
                            }
                        }, 3000);
                        return;
                    }
                    
                    // Erreurs de connexion
                    if (err.error === 'Connection closed.' || 
                        err.message.includes('Connection closed') ||
                        err.message.includes('ECONNRESET')) {
                        this.log('info', 'Connexion fermée - reconnexion automatique...');
                        setTimeout(() => {
                            if (!this.isShuttingDown) {
                                this.start();
                            }
                        }, 5000);
                        return;
                    }

                    // Erreurs de cookies/domaine
                    if (err.message.includes('Cookie') || err.message.includes('domain')) {
                        this.log('error', 'Erreur de cookies détectée pendant l\'écoute');
                        this.cleanAppState().then(() => {
                            this.log('error', 'AppState nettoyé - redémarrage requis');
                            process.exit(1);
                        });
                        return;
                    }
                    
                    return;
                }

                // Traiter l'événement
                if (event) {
                    this.handleMessage(event);
                }
            });

            this.log('info', '🤖 Bot démarré et en écoute...');
            this.log('info', `💬 Préfixe: ${CONFIG.COMMAND_PREFIX}`);
            this.log('info', `🔐 Méthode: ${CONFIG.LOGIN_METHOD}`);
            
        } catch (error) {
            this.log('error', 'Erreur startListening:', error.message);
            setTimeout(() => {
                if (!this.isShuttingDown) {
                    this.start();
                }
            }, 5000);
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
                status: 'Bot Facebook Messenger actif',
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                commands: this.commands.size,
                retryCount: this.retryCount,
                loginMethod: CONFIG.LOGIN_METHOD,
                memory: process.memoryUsage(),
                api_connected: this.api ? true : false
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
