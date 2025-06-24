/**
 * Commande Ping - Test de réactivité du bot
 * Usage: /ping
 */

module.exports = async (args, api, message) => {
    const startTime = Date.now();
    
    try {
        // Envoyer le message de réponse
        await new Promise((resolve, reject) => {
            api.sendMessage('🏓 Pong!', message.threadID, (err, info) => {
                if (err) reject(err);
                else resolve(info);
            });
        });
        
        const endTime = Date.now();
        const responseTime = endTime - startTime;
        
        // Envoyer le temps de réponse
        api.sendMessage(
            `⚡ Temps de réponse: ${responseTime}ms`,
            message.threadID
        );
        
    } catch (error) {
        console.error('Erreur commande ping:', error);
        api.sendMessage('❌ Erreur lors du ping', message.threadID);
    }
};

// Métadonnées de la commande
module.exports.info = {
    name: 'ping',
    description: 'Teste la réactivité du bot',
    usage: '/ping',
    category: 'Utilitaires'
};
