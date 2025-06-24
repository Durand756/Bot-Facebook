/**
 * Commande GPT - Intégration avec OpenAI
 * Usage: /gpt [votre question]
 */

const axios = require('axios');
require('dotenv').config();

module.exports = async (args, api, message) => {
    // Vérifier si une question est fournie
    if (args.length === 0) {
        api.sendMessage(
            '❓ Veuillez poser une question.\n💡 Usage: /gpt Votre question ici',
            message.threadID
        );
        return;
    }
    
    // Vérifier la clé API
    if (!process.env.OPENAI_API_KEY) {
        api.sendMessage(
            '❌ Clé API OpenAI manquante. Configurez OPENAI_API_KEY dans le fichier .env',
            message.threadID
        );
        return;
    }
    
    const question = args.join(' ');
    
    try {
        // Envoyer un message de chargement
        const loadingMsg = await new Promise((resolve, reject) => {
            api.sendMessage('🤔 GPT réfléchit...', message.threadID, (err, info) => {
                if (err) reject(err);
                else resolve(info);
            });
        });
        
        // Préparer la requête à OpenAI
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-3.5-turbo', // Vous pouvez changer pour 'gpt-4' si vous avez accès
                messages: [
                    {
                        role: 'system',
                        content: 'Tu es un assistant intelligent et utile. Réponds de manière concise et claire en français.'
                    },
                    {
                        role: 'user',
                        content: question
                    }
                ],
                max_tokens: 1000,
                temperature: 0.7
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000 // 30 secondes de timeout
            }
        );
        
        // Extraire la réponse
        const gptResponse = response.data.choices[0].message.content.trim();
        
        // Envoyer la réponse (diviser si trop longue)
        if (gptResponse.length > 2000) {
            // Diviser en chunks pour éviter les limites de Facebook
            const chunks = gptResponse.match(/.{1,1500}(\s|$)/g) || [gptResponse];
            
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i].trim();
                const prefix = i === 0 ? '🤖 GPT répond:\n\n' : '📄 Suite:\n\n';
                
                await new Promise((resolve, reject) => {
                    api.sendMessage(prefix + chunk, message.threadID, (err) => {
                        if (err) reject(err);
                        else setTimeout(resolve, 1000); // Délai entre les messages
                    });
                });
            }
        } else {
            api.sendMessage(`🤖 GPT répond:\n\n${gptResponse}`, message.threadID);
        }
        
        // Supprimer le message de chargement
        api.unsendMessage(loadingMsg.messageID);
        
    } catch (error) {
        console.error('Erreur GPT:', error.response?.data || error.message);
        
        let errorMessage = '❌ Erreur lors de la communication avec GPT.';
        
        if (error.response?.status === 401) {
            errorMessage = '🔑 Clé API OpenAI invalide.';
        } else if (error.response?.status === 429) {
            errorMessage = '⏰ Limite de taux atteinte. Réessayez dans quelques minutes.';
        } else if (error.response?.status === 400) {
            errorMessage = '📝 Requête invalide. Vérifiez votre question.';
        } else if (error.code === 'ECONNABORTED') {
            errorMessage = '⏱️ Délai d\'attente dépassé. Réessayez avec une question plus courte.';
        }
        
        api.sendMessage(errorMessage, message.threadID);
    }
};

// Métadonnées de la commande
module.exports.info = {
    name: 'gpt',
    description: 'Pose une question à GPT (OpenAI)',
    usage: '/gpt [votre question]',
    category: 'IA',
    examples: [
        '/gpt Qui est Albert Einstein ?',
        '/gpt Écris-moi un poème sur la nature',
        '/gpt Comment fonctionne la photosynthèse ?'
    ]
};
