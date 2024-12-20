const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { PrismaClient } = require('@prisma/client');

class FAQThreadManager {
    constructor(googleApiKey) {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMessageReactions
            ],
            partials: [Partials.Message, Partials.Channel]
        });

        this.genAI = new GoogleGenerativeAI(googleApiKey);
        this.model = this.genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        this.embeddingModel = this.genAI.getGenerativeModel({ model: "embedding-001" });
        this.prisma = new PrismaClient();
        this.similarityThreshold = 0.92;
    }

    // Initialize the bot
    async initialize(discordToken) {
        this.client.on('ready', () => {
            console.log('FAQ Thread Manager is ready!');
        });

        this.client.on('messageCreate', async (message) => {
            if (message.author.bot) return;
            await this.handleMessage(message);
        });

        await this.client.login(discordToken);
    }

    // Get embedding for a question using Gemini
    async getQuestionEmbedding(text) {
        try {
            const result = await this.embeddingModel.embedContent(text);
            const embedding = result.embedding.values;
            return embedding;
        } catch (error) {
            console.error('Error getting embedding:', error);
            return null;
        }
    }

    // Calculate cosine similarity between embeddings
    calculateCosineSimilarity(embedding1, embedding2) {
        let dotProduct = 0;
        let norm1 = 0;
        let norm2 = 0;
        
        for (let i = 0; i < embedding1.length; i++) {
            dotProduct += embedding1[i] * embedding2[i];
            norm1 += embedding1[i] * embedding1[i];
            norm2 += embedding2[i] * embedding2[i];
        }
        
        return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
    }

    // Find similar existing questions in database
    async findSimilarQuestion(questionText) {
        try {
            const newQuestionEmbedding = await this.getQuestionEmbedding(questionText);
            if (!newQuestionEmbedding) return null;

            const existingQuestions = await this.prisma.question.findMany({
                include: {
                    thread: true
                }
            });

            let bestMatch = null;
            let highestSimilarity = 0;

            for (const existing of existingQuestions) {
                const similarity = this.calculateCosineSimilarity(
                    newQuestionEmbedding,
                    existing.embedding
                );

                if (similarity > this.similarityThreshold && similarity > highestSimilarity) {
                    highestSimilarity = similarity;
                    bestMatch = existing;
                }
            }

            return bestMatch;
        } catch (error) {
            console.error('Error finding similar question:', error);
            return null;
        }
    }

    // Create a new thread and store in database
    async createQuestionThread(message) {
        try {
            const findthread = 
            const thread = await message.startThread({
                name: ` ${message.content.substring(0, 50)}...`,
                autoArchiveDuration: 1440
            });

            const embedding = await this.getQuestionEmbedding(message.content);
            if (!embedding) return null;

            await this.prisma.question.create({
                data: {
                    content: message.content,
                    embedding: embedding,
                    authorId: message.author.id,
                    messageId: message.id,
                    thread: {
                        create: {
                            threadId: thread.id,
                            guildId: message.guildId,
                            channelId: message.channelId
                        }
                    }
                }
            });

            return thread;
        } catch (error) {
            console.error('Error creating thread:', error);
            return null;
        }
    }

    // Check if a message is a question using Gemini
    async isQuestion(message) {
        try {
            const prompt = "Analyze if this message is a question. Respond with only 'true' or 'false': " + message.content;
            const result = await this.model.generateContent(prompt);
            const response = result.response.text().trim().toLowerCase();
            return response === 'true';
        } catch (error) {
            console.error('Error checking if message is question:', error);
            // Fallback to simple question mark check
            return message.content.includes('?');
        }
    }

    // Check if message is relevant answer using Gemini
    async isRelevantAnswer(message, question) {
        try {
            const prompt = `Is this message a relevant answer to the question?
Question: ${question.content}
Potential Answer: ${message.content}
Respond with only 'true' or 'false'.`;
            
            const result = await this.model.generateContent(prompt);
            const response = result.response.text().trim().toLowerCase();
            return response === 'true';
        } catch (error) {
            console.error('Error checking answer relevance:', error);
            return false;
        }
    }

    // Store answer in database
    async storeAnswer(questionId, message) {
        try {
            await this.prisma.answer.create({
                data: {
                    content: message.content,
                    authorId: message.author.id,
                    messageId: message.id,
                    questionId: questionId
                }
            });
        } catch (error) {
            console.error('Error storing answer:', error);
        }
    }

    // Handle new messages
    async handleMessage(message) {
        if (await this.isQuestion(message)) {
            const similarQuestion = await this.findSimilarQuestion(message.content);
            
            if (similarQuestion) {
                const threadData = await this.prisma.thread.findUnique({
                    where: {
                        threadId: similarQuestion.thread.threadId
                    }
                });

                await message.reply({
                    content: `Similar question was already asked! Check this thread: https://discord.com/channels/${threadData.guildId}/${threadData.channelId}/${threadData.threadId}`,
                    allowedMentions: { repliedUser: false }
                });
            } else {
                const thread = await this.createQuestionThread(message);
                if (thread) {
                    await thread.send('New FAQ thread created! Awaiting answers...');
                }
            }
        } else {
            await this.processMessageAsAnswer(message);
        }
    }

    // Process potential answers
    async processMessageAsAnswer(message) {
        try {
            const recentQuestions = await this.prisma.question.findMany({
                where: {
                    createdAt: {
                        gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
                    }
                },
                include: {
                    thread: true
                }
            });

            for (const question of recentQuestions) {
                if (message.reference?.messageId === question.messageId || 
                    await this.isRelevantAnswer(message, question)) {
                    
                    const thread = await this.client.channels.fetch(question.thread.threadId);
                    await thread.send({
                        content: `Potential answer from ${message.author}:\n${message.content}`,
                        allowedMentions: { users: [] }
                    });
                    
                    await this.storeAnswer(question.id, message);
                }
            }
        } catch (error) {
            console.error('Error processing answer:', error);
        }
    }
}

module.exports = FAQThreadManager;





const manager = new FAQThreadManager(process.env.OPEN_AI);
manager.initialize(process.env.DISCORD_TOKEN);
