const login = require('facebook-chat-api');
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
    COOKIES_FILE: 'cookies.json',
    LOGS_FILE: 'logs.txt',
    PORT: process.env.PORT || 3000,
    MAX_RETRIES: 3,
    RETRY_DELAY: 5000,
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    // Nouvelles options de connexion
    LOGIN_METHOD: process.env.LOGIN_METHOD || 'cookies', // 'cookies', 'email', 'phone'
    FB_EMAIL: process.env.FB_EMAIL || '',
    FB_PASSWORD: process.env.FB_PASSWORD || '',
    FB_PHONE: process.env.FB_PHONE || ''
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
    }

    // Logger amélioré avec niveaux
    log(level, message, data = null) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
        
        if (data) {
            console.log(logMessage, data);
        } else {
            console.log(logMessage);
        }

        // Écriture asynchrone des logs critiques
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

    // Gestion sécurisée des cookies avec validation améliorée
    async loadCookies() {
        try {
            if (!fsSync.existsSync(CONFIG.COOKIES_FILE)) {
                throw new Error(`Fichier ${CONFIG.COOKIES_FILE} manquant`);
            }

            const cookiesData = await fs.readFile(CONFIG.COOKIES_FILE, 'utf8');
            let cookies = JSON.parse(cookiesData);

            // Validation et nettoyage des cookies
            if (!Array.isArray(cookies) || cookies.length === 0) {
                throw new Error('Format de cookies invalide');
            }

            // Normaliser le format des cookies
            cookies = cookies.map(cookie => {
                // Si le cookie utilise l'ancien format (name/value)
                if (cookie.name && !cookie.key) {
                    cookie.key = cookie.name;
                }
                if (cookie.value && typeof cookie.value === 'string') {
                    // Décoder les valeurs URL encodées si nécessaire
                    try {
                        cookie.value = decodeURIComponent(cookie.value);
                    } catch (e) {
                        // Garder la valeur originale si le décodage échoue
                    }
                }

                // Normaliser le domaine
                if (cookie.domain) {
                    if (cookie.domain.startsWith('.facebook.com')) {
                        cookie.domain = 'facebook.com';
                    } else if (cookie.domain.startsWith('.messenger.com')) {
                        cookie.domain = 'messenger.com';
                    }
                }

                // Assurer que les cookies critiques sont présents
                const criticalCookies = ['datr', 'fr', 'c_user', 'xs'];
                if (criticalCookies.includes(cookie.key) || criticalCookies.includes(cookie.name)) {
                    cookie.httpOnly = true;
                    cookie.secure = true;
                }

                return cookie;
            });

            // Filtrer les cookies valides
            const validCookies = cookies.filter(cookie => {
                const key = cookie.key || cookie.name;
                return key && cookie.value && key.length > 0;
            });

            // Vérifier la présence de cookies critiques
            const criticalCookies = ['c_user', 'xs', 'datr'];
            const presentCritical = criticalCookies.filter(name => 
                validCookies.some(cookie => (cookie.key === name || cookie.name === name))
            );

            if (presentCritical.length < 2) {
                throw new Error(`Cookies critiques manquants. Présents: ${presentCritical.join(', ')}`);
            }

            this.log('info', `${validCookies.length} cookies valides chargés`);
            this.log('info', `Cookies critiques présents: ${presentCritical.join(', ')}`);
            
            return validCookies;

        } catch (error) {
            this.log('error', 'Erreur chargement cookies:', error.message);
            throw error;
        }
    }

    // Sauvegarder les cookies après connexion réussie
    async saveCookies(appState) {
        try {
            const cookiesJson = JSON.stringify(appState, null, 2);
            await fs.writeFile(CONFIG.COOKIES_FILE, cookiesJson);
            this.log('info', 'Cookies sauvegardés avec succès');
        } catch (error) {
            this.log('error', 'Erreur sauvegarde cookies:', error.message);
        }
    }

    // Chargement optimisé des commandes avec cache
    async loadCommands(force = false) {
        try {
            // Vérifier si rechargement nécessaire
            if (!force && this.commands.size > 0) {
                const commandsDir = await fs.stat(CONFIG.COMMANDS_DIR).catch(() => null);
                if (commandsDir && commandsDir.mtime <= this.commandsLastLoaded) {
                    return this.commands;
                }
            }

            // Créer le dossier si nécessaire
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
                    
                    // Supprimer du cache pour rechargement
                    delete require.cache[require.resolve(commandPath)];
                    
                    const command = require(commandPath);
                    
                    // Validation de la commande
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

    // Gestionnaire de messages optimisé
    async handleMessage(message) {
        try {
            // Ignorer ses propres messages et messages système
            if (!message.body || 
                message.senderID === this.api.getCurrentUserID() ||
                message.type !== 'message') {
                return;
            }

            const messageBody = message.body.trim();
            if (!messageBody.startsWith(CONFIG.COMMAND_PREFIX)) return;

            // Parser la commande
            const args = messageBody.slice(CONFIG.COMMAND_PREFIX.length).trim().split(/\s+/);
            const commandName = args.shift()?.toLowerCase();
            
            if (!commandName) return;

            // Recharger les commandes si nécessaire
            await this.loadCommands();

            // Vérifier l'existence de la commande
            if (!this.commands.has(commandName)) {
                await this.sendMessage(
                    `❌ Commande "${commandName}" introuvable. Tapez ${CONFIG.COMMAND_PREFIX}help pour voir les commandes disponibles.`,
                    message.threadID
                );
                return;
            }

            // Obtenir les infos utilisateur avec timeout
            const userInfo = await this.getUserInfo(message.senderID);
            const senderName = userInfo?.name || 'Utilisateur inconnu';

            // Logger la commande
            const logEntry = `[${new Date().toISOString()}] ${senderName} (${message.senderID}) - Commande: ${CONFIG.COMMAND_PREFIX}${commandName} ${args.join(' ')}\n`;
            this.writeLog(logEntry);

            this.log('info', `Exécution: ${commandName} par ${senderName}`);

            // Exécuter la commande avec timeout
            const command = this.commands.get(commandName);
            await Promise.race([
                command(args, this.api, message),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Timeout commande')), 30000)
                )
            ]);

        } catch (error) {
            this.log('error', 'Erreur handleMessage:', error.message);
            if (message.threadID) {
                await this.sendMessage(
                    `❌ Erreur lors de l'exécution: ${error.message}`,
                    message.threadID
                ).catch(() => {}); // Éviter les erreurs en cascade
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

    // Déterminer la méthode de connexion
    getLoginCredentials() {
        const method = CONFIG.LOGIN_METHOD.toLowerCase();
        
        switch (method) {
            case 'email':
                if (!CONFIG.FB_EMAIL || !CONFIG.FB_PASSWORD) {
                    throw new Error('FB_EMAIL et FB_PASSWORD requis pour la connexion par email');
                }
                return {
                    email: CONFIG.FB_EMAIL,
                    password: CONFIG.FB_PASSWORD
                };
            
            case 'phone':
                if (!CONFIG.FB_PHONE || !CONFIG.FB_PASSWORD) {
                    throw new Error('FB_PHONE et FB_PASSWORD requis pour la connexion par téléphone');
                }
                return {
                    email: CONFIG.FB_PHONE, // facebook-chat-api utilise le champ email pour le téléphone aussi
                    password: CONFIG.FB_PASSWORD
                };
            
            case 'cookies':
            default:
                return null; // Utiliser les cookies
        }
    }

    // Connexion avec multiple méthodes et gestion d'erreurs améliorée
    async connect() {
        try {
            const credentials = this.getLoginCredentials();
            let options = {};

            if (credentials) {
                // Connexion avec email/téléphone + mot de passe
                this.log('info', `Tentative de connexion avec ${CONFIG.LOGIN_METHOD}`);
                options = {
                    email: credentials.email,
                    password: credentials.password
                };
            } else {
                // Connexion avec cookies
                this.log('info', 'Tentative de connexion avec cookies');
                const cookies = await this.loadCookies();
                options = {
                    appState: cookies
                };
            }

            // Ajouter des options supplémentaires
            if (process.env.PAGE_ID) {
                options.pageID = process.env.PAGE_ID;
            }

            return new Promise((resolve, reject) => {
                login(options, (err, api) => {
                    if (err) {
                        this.log('error', 'Erreur connexion:', err.message);
                        
                        // Messages d'erreur plus explicites
                        if (err.error === 'login-approval') {
                            this.log('error', 'Approbation de connexion requise. Vérifiez votre téléphone/email.');
                        } else if (err.error === 'checkpoint') {
                            this.log('error', 'Checkpoint de sécurité détecté. Connectez-vous manuellement à Facebook.');
                        } else if (err.error === 'Wrong username/password.') {
                            this.log('error', 'Email/téléphone ou mot de passe incorrect.');
                        }
                        
                        reject(err);
                        return;
                    }

                    this.api = api;
                    
                    // Configuration optimisée de l'API
                    api.setOptions({
                        listenEvents: true,
                        logLevel: 'silent',
                        updatePresence: false,
                        selfListen: false,
                        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    });

                    // Sauvegarder les cookies après connexion réussie
                    if (credentials && api.getAppState) {
                        this.saveCookies(api.getAppState());
                    }

                    resolve(api);
                });
            });

        } catch (error) {
            throw error;
        }
    }

    // Validation des paramètres de connexion au démarrage
    validateLoginConfig() {
        const method = CONFIG.LOGIN_METHOD.toLowerCase();
        
        this.log('info', `Méthode de connexion: ${method}`);
        
        switch (method) {
            case 'email':
                if (!CONFIG.FB_EMAIL || !CONFIG.FB_PASSWORD) {
                    throw new Error('Ajoutez FB_EMAIL et FB_PASSWORD dans votre fichier .env pour la connexion par email');
                }
                this.log('info', `Email configuré: ${CONFIG.FB_EMAIL.substring(0, 3)}***`);
                break;
                
            case 'phone':
                if (!CONFIG.FB_PHONE || !CONFIG.FB_PASSWORD) {
                    throw new Error('Ajoutez FB_PHONE et FB_PASSWORD dans votre fichier .env pour la connexion par téléphone');
                }
                this.log('info', `Téléphone configuré: ${CONFIG.FB_PHONE.substring(0, 3)}***`);
                break;
                
            case 'cookies':
                if (!fsSync.existsSync(CONFIG.COOKIES_FILE)) {
                    throw new Error(`Fichier ${CONFIG.COOKIES_FILE} manquant pour la connexion par cookies`);
                }
                this.log('info', 'Fichier cookies trouvé');
                break;
                
            default:
                this.log('warn', `Méthode de connexion inconnue: ${method}. Utilisation des cookies par défaut.`);
                CONFIG.LOGIN_METHOD = 'cookies';
        }
    }

    // Démarrage avec retry automatique
    async start() {
        try {
            // Valider la configuration
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
                
                this.retryCount = 0; // Reset sur succès
                return;

            } catch (error) {
                this.retryCount++;
                this.log('error', `Échec connexion (${this.retryCount}/${CONFIG.MAX_RETRIES}):`, error.message);
                
                // Suggérer une solution basée sur l'erreur
                if (error.error === 'login-approval' || error.error === 'checkpoint') {
                    this.log('info', '💡 Solution suggérée: Essayez de changer LOGIN_METHOD dans votre .env');
                }
                
                if (this.retryCount < CONFIG.MAX_RETRIES) {
                    this.log('info', `Nouvelle tentative dans ${CONFIG.RETRY_DELAY/1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
                } else {
                    this.log('error', 'Nombre maximum de tentatives atteint');
                    this.log('info', '💡 Vérifiez votre configuration dans le fichier .env');
                    process.exit(1);
                }
            }
        }
    }

    // Écoute des messages avec gestion d'erreurs
    startListening() {
        this.api.listenMqtt((err, message) => {
            if (err) {
                this.log('error', 'Erreur écoute MQTT:', err.message);
                
                // Redémarrage automatique en cas d'erreur critique
                if (err.error === 'Connection closed.') {
                    this.log('info', 'Reconnexion automatique...');
                    setTimeout(() => this.start(), 5000);
                }
                return;
            }

            this.handleMessage(message);
        });

        this.log('info', '🤖 Bot démarré et en écoute...');
        this.log('info', `💬 Préfixe: ${CONFIG.COMMAND_PREFIX}`);
        this.log('info', `🔐 Méthode de connexion: ${CONFIG.LOGIN_METHOD}`);
    }

    // Serveur HTTP pour le monitoring
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
                memory: process.memoryUsage()
            };
            
            res.end(JSON.stringify(status, null, 2));
        });

        this.server.listen(CONFIG.PORT, () => {
            this.log('info', `🌐 Serveur HTTP sur port ${CONFIG.PORT}`);
        });

        // Gestion des erreurs serveur
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

// Initialisation et démarrage
const bot = new FacebookBot();

// Gestion des signaux système
process.on('SIGINT', () => bot.shutdown());
process.on('SIGTERM', () => bot.shutdown());

// Gestion des erreurs non catchées
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
    bot.log('error', 'Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    bot.log('error', 'Uncaught Exception:', error.message);
    bot.shutdown();
});

// Démarrage du bot
bot.start().catch((error) => {
    console.error('Erreur fatale au démarrage:', error);
    process.exit(1);
});
