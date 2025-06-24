/**
 * Commande Help - Affiche la liste des commandes disponibles
 * Usage: /help [commande]
 */

const fs = require('fs');
const path = require('path');

module.exports = async (args, api, message) => {
    const COMMANDS_DIR = path.join(__dirname);
    const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '/';
    
    try {
        // Si une commande spécifique est demandée
        if (args.length > 0) {
            const requestedCommand = args[0].toLowerCase();
            const commandPath = path.join(COMMANDS_DIR, `${requestedCommand}.js`);
            
            if (fs.existsSync(commandPath)) {
                try {
                    delete require.cache[require.resolve(commandPath)];
                    const command = require(commandPath);
                    
                    if (command.info) {
                        let helpText = `📋 **${command.info.name.toUpperCase()}**\n\n`;
                        helpText += `📝 **Description:** ${command.info.description}\n`;
                        helpText += `💡 **Usage:** ${command.info.usage}\n`;
                        
                        if (command.info.category) {
                            helpText += `📂 **Catégorie:** ${command.info.category}\n`;
                        }
                        
                        if (command.info.examples && command.info.examples.length > 0) {
                            helpText += `\n🌟 **Exemples:**\n`;
                            command.info.examples.forEach(example => {
                                helpText += `• ${example}\n`;
                            });
                        }
                        
                        api.sendMessage(helpText, message.threadID);
                    } else {
                        api.sendMessage(
                            `ℹ️ Commande "${requestedCommand}" trouvée mais aucune information détaillée disponible.`,
                            message.threadID
                        );
                    }
                } catch (error) {
                    api.sendMessage(
                        `❌ Erreur lors du chargement des informations pour "${requestedCommand}".`,
                        message.threadID
                    );
                }
            } else {
                api.sendMessage(
                    `❌ Commande "${requestedCommand}" introuvable.`,
                    message.threadID
                );
            }
            return;
        }
        
        // Afficher toutes les commandes disponibles
        const commandFiles = fs.readdirSync(COMMANDS_DIR).filter(file => file.endsWith('.js'));
        
        if (commandFiles.length === 0) {
            api.sendMessage('❌ Aucune commande disponible.', message.threadID);
            return;
        }
        
        let helpMessage = '🤖 **COMMANDES DISPONIBLES**\n\n';
        
        // Organiser les commandes par catégorie
        const categories = {};
        const commandsWithoutCategory = [];
        
        for (const file of commandFiles) {
            try {
                const commandName = path.basename(file, '.js');
                const commandPath = path.join(COMMANDS_DIR, file);
                
                // Charger la commande pour obtenir ses métadonnées
                delete require.cache[require.resolve(commandPath)];
                const command = require(commandPath);
                
                const commandInfo = {
                    name: commandName,
                    description: command.info?.description || 'Aucune description',
                    usage: command.info?.usage || `${COMMAND_PREFIX}${commandName}`,
                    category: command.info?.category || null
                };
                
                if (commandInfo.category) {
                    if (!categories[commandInfo.category]) {
                        categories[commandInfo.category] = [];
                    }
                    categories[commandInfo.category].push(commandInfo);
                } else {
                    commandsWithoutCategory.push(commandInfo);
                }
                
            } catch (error) {
                console.error(`Erreur lors du chargement de ${file}:`, error);
            }
        }
        
        // Afficher les commandes par catégorie
        for (const [categoryName, commands] of Object.entries(categories)) {
            helpMessage += `📂 **${categoryName.toUpperCase()}**\n`;
            
            commands.forEach(cmd => {
                helpMessage += `• ${cmd.usage}\n`;
                helpMessage += `  └ ${cmd.description}\n`;
            });
            
            helpMessage += '\n';
        }
        
        // Afficher les commandes sans catégorie
        if (commandsWithoutCategory.length > 0) {
            helpMessage += '📋 **AUTRES COMMANDES**\n';
            
            commandsWithoutCategory.forEach(cmd => {
                helpMessage += `• ${cmd.usage}\n`;
                helpMessage += `  └ ${cmd.description}\n`;
            });
            
            helpMessage += '\n';
        }
        
        helpMessage += `💡 **Astuce:** Tapez \`${COMMAND_PREFIX}help [commande]\` pour plus de détails sur une commande spécifique.\n`;
        helpMessage += `🔧 **Préfixe:** ${COMMAND_PREFIX}\n`;
        helpMessage += `📊 **Total:** ${commandFiles.length} commande(s) disponible(s)`;
        
        // Diviser le message si trop long
        if (helpMessage.length > 2000) {
            const chunks = helpMessage.match(/.{1,1800}(\n|$)/g) || [helpMessage];
            
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i].trim();
                
                await new Promise((resolve, reject) => {
                    api.sendMessage(chunk, message.threadID, (err) => {
                        if (err) reject(err);
                        else setTimeout(resolve, 1000);
                    });
                });
            }
        } else {
            api.sendMessage(helpMessage, message.threadID);
        }
        
    } catch (error) {
        console.error('Erreur commande help:', error);
        api.sendMessage('❌ Erreur lors de l\'affichage de l\'aide.', message.threadID);
    }
};

// Métadonnées de la commande
module.exports.info = {
    name: 'help',
    description: 'Affiche la liste des commandes disponibles',
    usage: '/help [commande]',
    category: 'Utilitaires',
    examples: [
        '/help',
        '/help gpt',
        '/help ping'
    ]
};
