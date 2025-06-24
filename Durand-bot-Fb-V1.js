const login = require('facebook-chat-api');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Configuration
const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '/';
const COMMANDS_DIR = path.join(__dirname, 'Commandes');

// Logger utility
function logMessage(message, senderName, senderId, command) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${senderName} (${senderId}) - Commande: ${command}\n`;
    
    fs.appendFile('logs.txt', logEntry, (err) => {
        if (err) console.error('Erreur lors de l\'écriture du log:', err);
    });
}

// Fonction pour charger dynamiquement les commandes
function loadCommands() {
    const commands = {};
    
    if (!fs.existsSync(COMMANDS_DIR)) {
        fs.mkdirSync(COMMANDS_DIR, { recursive: true });
        console.log('Dossier Commandes/ créé');
        return commands;
    }
    
    const commandFiles = fs.readdirSync(COMMANDS_DIR).filter(file => file.endsWith('.js'));
    
    for (const file of commandFiles) {
        try {
            const commandName = path.basename(file, '.js');
            const commandPath = path.join(COMMANDS_DIR, file);
            
            // Supprimer du cache pour permettre le rechargement à chaud
            delete require.cache[require.resolve(commandPath)];
            
            const command = require(commandPath);
            commands[commandName] = command;
            
            console.log(`✅ Commande chargée: ${commandName}`);
        } catch (error) {
            console.error(`❌ Erreur lors du chargement de ${file}:`, error.message);
        }
    }
    
    return commands;
}

// Fonction pour traiter les messages
async function handleMessage(api, message) {
    // Ignorer ses propres messages
    if (message.senderID === api.getCurrentUserID()) return;
    
    const messageBody = message.body;
    if (!messageBody || !messageBody.startsWith(COMMAND_PREFIX)) return;
    
    // Parser la commande
    const args = messageBody.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
    const commandName = args.shift().toLowerCase();
    
    // Charger les commandes (permet le rechargement à chaud)
    const commands = loadCommands();
    
    // Vérifier si la commande existe
    if (!commands[commandName]) {
        api.sendMessage(
            `❌ Commande "${commandName}" introuvable. Tapez ${COMMAND_PREFIX}help pour voir les commandes disponibles.`,
            message.threadID
        );
        return;
    }
    
    try {
        // Obtenir les informations de l'utilisateur
        const userInfo = await new Promise((resolve, reject) => {
            api.getUserInfo(message.senderID, (err, ret) => {
                if (err) reject(err);
                else resolve(ret[message.senderID]);
            });
        });
        
        const senderName = userInfo ? userInfo.name : 'Utilisateur inconnu';
        
        // Logger la commande
        logMessage(message, senderName, message.senderID, `${COMMAND_PREFIX}${commandName} ${args.join(' ')}`);
        
        console.log(`🔧 Exécution: ${commandName} par ${senderName} (${message.senderID})`);
        
        // Exécuter la commande
        await commands[commandName](args, api, message);
        
    } catch (error) {
        console.error(`❌ Erreur lors de l'exécution de ${commandName}:`, error);
        api.sendMessage(
            `❌ Erreur lors de l'exécution de la commande: ${error.message}`,
            message.threadID
        );
    }
}

// Fonction principale pour démarrer le bot
async function startBot() {
    try {
        // Charger les cookies
        if (!fs.existsSync('cookies.json')) {
            console.error('❌ Fichier cookies.json manquant!');
            console.log('📝 Créez un fichier cookies.json avec vos cookies Facebook.');
            console.log('💡 Vous pouvez utiliser cookies.json.example comme modèle.');
            process.exit(1);
        }
        
        const cookies = JSON.parse(fs.readFileSync('cookies.json', 'utf8'));
        
        // Se connecter à Facebook
        console.log('🔄 Connexion à Facebook...');
        
        login({ appState: cookies }, (err, api) => {
            if (err) {
                console.error('❌ Erreur de connexion:', err);
                return;
            }
            
            console.log('✅ Connexion réussie!');
            
            // Configuration de l'API
            api.setOptions({
                listenEvents: true,
                logLevel: 'silent',
                updatePresence: true
            });
            
            // Charger les commandes au démarrage
            const commands = loadCommands();
            console.log(`📚 ${Object.keys(commands).length} commande(s) chargée(s)`);
            
            // Écouter les messages
            api.listenMqtt((err, message) => {
                if (err) {
                    console.error('❌ Erreur d\'écoute:', err);
                    return;
                }
                
                if (message.type === 'message') {
                    handleMessage(api, message);
                }
            });
            
            console.log('🤖 Bot démarré et en écoute...');
            console.log(`💬 Préfixe de commande: ${COMMAND_PREFIX}`);
            console.log(`📁 Dossier des commandes: ${COMMANDS_DIR}`);
        });
        
    } catch (error) {
        console.error('❌ Erreur fatale:', error);
        process.exit(1);
    }
}

// Gestion des signaux pour arrêt propre
process.on('SIGINT', () => {
    console.log('\n🛑 Arrêt du bot...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Arrêt du bot (SIGTERM)...');
    process.exit(0);
});

// Démarrer le bot
startBot();

// Serveur HTTP minimal pour Render
const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'Bot Facebook Messenger actif',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    }));
});

server.listen(PORT, () => {
    console.log(`🌐 Serveur HTTP démarré sur le port ${PORT} (pour Render)`);
});
