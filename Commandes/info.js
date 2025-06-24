/**
 * Commande Info - Affiche les informations du bot
 * Usage: /info
 */

const fs = require('fs');
const path = require('path');

module.exports = async (args, api, message) => {
    try {
        // Informations du bot
        const startTime = Date.now();
        const uptime = process.uptime();
        const memoryUsage = process.memoryUsage();
        
        // Compter les commandes disponibles
        const COMMANDS_DIR = path.join(__dirname);
        const commandFiles = fs.readdirSync(COMMANDS_DIR).filter(file => file.endsWith('.js'));
        
        // Formater l'uptime
        const days = Math.floor(uptime / 86400);
        const hours = Math.floor((uptime % 86400) / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);
        
        const uptimeString = `${days}j ${hours}h ${minutes}m ${seconds}s`;
        
        // Formater l'usage mémoire
        const memoryInMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
        
        // Obtenir les informations de l'utilisateur
        let userInfo = 'Utilisateur inconnu';
        try {
            const user = await new Promise((resolve, reject) => {
                api.getUserInfo(message.senderID, (err, ret) => {
                    if (err) reject(err);
                    else resolve(ret[message.senderID]);
                });
            });
            userInfo = user ? user.name : 'Utilisateur inconnu';
        } catch (error) {
            console.error('Erreur lors de la récupération des infos utilisateur:', error);
        }
        
        // Créer le message d'information
        const infoMessage = `🤖 **INFORMATIONS DU BOT**
        
📊 **Statistiques:**
• Uptime: ${uptimeString}
• Mémoire: ${memoryInMB} MB
• Commandes: ${commandFiles.length}
• Node.js: ${process.version}

👤 **Utilisateur:**
• Nom: ${userInfo}
• ID: ${message.senderID}

🔧 **Configuration:**
• Préfixe: ${process.env.COMMAND_PREFIX || '/'}
• Environnement: ${process.env.NODE_ENV || 'development'}
• OpenAI: ${process.env.OPENAI_API_KEY ? '✅ Configuré' : '❌ Non configuré'}

📅 **Temps:**
• Démarrage: ${new Date(Date.now() - uptime * 1000).toLocaleString('fr-FR')}
• Actuel: ${new Date().toLocaleString('fr-FR')}

🏷️ **Version:**
• Bot: v1.0.0
• Développé pour Facebook Messenger

💡 **Utilisation:**
Tapez \`/help\` pour voir toutes les commandes disponibles.`;

        // Calculer le temps de réponse
        const responseTime = Date.now() - startTime;
        
        api.sendMessage(infoMessage, message.threadID, () => {
            api.sendMessage(
                `⚡ Temps de traitement: ${responseTime}ms`,
                message.threadID
            );
        });
        
    } catch (error) {
        console.error('Erreur commande info:', error);
        api.sendMessage('❌ Erreur lors de la récupération des informations.', message.threadID);
    }
};

// Métadonnées de la commande
module.exports.info = {
    name: 'info',
    description: 'Affiche les informations et statistiques du bot',
    usage: '/info',
    category: 'Utilitaires'
};
