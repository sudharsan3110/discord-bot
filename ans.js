const { Client, GatewayIntentBits, Partials, ChannelType, AttachmentBuilder } = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { PrismaClient } = require('@prisma/client');
const { createWorker } = require('tesseract.js');
const sharp = require('sharp');

class ForumQAManager {
    constructor(googleApiKey) {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMessageReactions,
                GatewayIntentBits.DirectMessages
            ],
            partials: [Partials.Message, Partials.Channel]
        });
        
        this.genAI = new GoogleGenerativeAI(googleApiKey);
        this.model = this.genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        this.visionModel = this.genAI.getGenerativeModel({ model: "gemini-pro-vision" });
        this.prisma = new PrismaClient();
        
        // Initialize OCR worker
        this.ocrWorker = null;
        this.initOCR();
    }

    async initOCR() {
        this.ocrWorker = await createWorker('eng');
    }

    // Initialize bot and create forum if needed
    async initialize(discordToken, guildId) {
        if (!guildId) {
            console.error('Guild ID is undefined.');
            return;
        }

        this.client.on('ready', async () => {
            console.log('Forum QA Manager is ready!');
            await this.setupForum(guildId);
        });

        this.client.on('messageCreate', async (message) => {
            if (message.author.bot) return;
            await this.handleMessage(message);
        });

        await this.client.login(discordToken);
    }

    // Set up forum channel if it doesn't exist
    async setupForum(guildId) {
        try {
            console.log(`Fetching guild with ID: ${guildId}`);
            const guild = await this.client.guilds.fetch(guildId);
            if (!guild) {
                console.error('Failed to fetch guild.');
                return;
            }
            console.log(`Guild fetched: ${guild.name}`);
            const channels = guild.channels?.cache || [];
            let qaForum = channels.find(
                channel => channel.type === ChannelType.GuildForum && channel.name === 'question-forum'
            );

            if (!qaForum) {
                qaForum = await guild.channels.create({
                    name: 'question-forum',
                    type: ChannelType.GuildForum,
                    topic: 'Centralized Q&A forum',
                    availableTags: [
                        { name: 'resolved', moderated: true },
                        { name: 'pending', moderated: true },
                        { name: 'duplicate', moderated: true }
                    ]
                });
            }

            this.forumChannelId = qaForum.id;
        } catch (error) {
            console.error('Error setting up forum:', error);
        }
    }

    // Extract text from image
    async extractTextFromImage(imageUrl) {
        try {
            // Download and process image
            const imageBuffer = await fetch(imageUrl).then(res => res.buffer());
            
            // Preprocess image for better OCR
            const processedBuffer = await sharp(imageBuffer)
                .greyscale()
                .normalize()
                .sharpen()
                .toBuffer();

            // Perform OCR
            const result = await this.ocrWorker.recognize(processedBuffer);
            return result.data.text;
        } catch (error) {
            console.error('Error extracting text from image:', error);
            return null;
        }
    }

    // Get question content from message (text + images)
    async getQuestionContent(message) {
        let content = message.content;

        // Process attached images
        if (message.attachments.size > 0) {
            for (const [_, attachment] of message.attachments) {
                if (attachment.contentType?.startsWith('image/')) {
                    const imageText = await this.extractTextFromImage(attachment.url);
                    if (imageText) {
                        content += "\n[Image Content: " + imageText + "]";
                    }
                }
            }
        }

        return content;
    }

    // Find exact matching questions
    async findExactMatch(content) {
        try {
            // Clean and normalize content
            const normalizedContent = this.normalizeContent(content);
            
            // Get embedding for new question
            const contentData = await this.model.generateContent([{
                text: `Extract key concepts and terms from this text, ignoring formatting and non-essential words: ${normalizedContent}`
            }]);
            const keyTerms = contentData.response.text();

            // Search database for exact matches
            const existingQuestions = await this.prisma.question.findMany({
                where: {
                    keyTerms: keyTerms
                },
                include: {
                    thread: true
                }
            });

            return existingQuestions[0] || null;
        } catch (error) {
            console.error('Error finding exact match:', error);
            return null;
        }
    }

    // Normalize content for comparison
    normalizeContent(content) {
        return content
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/[^\w\s]/g, '')
            .trim();
    }

    // Create new forum post
    async createForumPost(message, questionContent) {
        try {
            const forum = await this.client.channels.fetch(this.forumChannelId);
            
            // Create forum post
            const thread = await forum.threads.create({
                name: questionContent.substring(0, 100),
                message: {
                    content: `**Original Question from ${message.author}:**\n${message.content}`,
                    files: [...message.attachments.values()]
                },
                appliedTags: ['pending']
            });

            // Store in database
            await this.prisma.question.create({
                data: {
                    content: questionContent,
                    keyTerms: await this.extractKeyTerms(questionContent),
                    authorId: message.author.id,
                    messageId: message.id,
                    thread: {
                        create: {
                            threadId: thread.id,
                            guildId: message.guildId,
                            channelId: this.forumChannelId
                        }
                    }
                }
            });

            return thread;
        } catch (error) {
            console.error('Error creating forum post:', error);
            return null;
        }
    }

    // Extract key terms for matching
    async extractKeyTerms(content) {
        const response = await this.model.generateContent([{
            text: `Extract and return only the key technical terms, concepts, and specific details from this text, ignoring common words and formatting: ${content}`
        }]);
        return response.response.text();
    }

    // Handle new messages
    async handleMessage(message) {
        // Only process messages in specified channels
        if (message.channel.id !== this.forumChannelId && 
            !message.channel.isThread()) return;

        const questionContent = await this.getQuestionContent(message);
        const exactMatch = await this.findExactMatch(questionContent);

        if (exactMatch) {
            // Link to existing thread
            await message.reply({
                content: `This exact question has been asked before! Check this thread: https://discord.com/channels/${message.guildId}/${this.forumChannelId}/${exactMatch.thread.threadId}`,
                allowedMentions: { repliedUser: false }
            });

            // Update thread tags
            const thread = await this.client.channels.fetch(exactMatch.thread.threadId);
            await thread.setAppliedTags([...thread.appliedTags, 'duplicate']);
        } else {
            // Create new forum post
            const thread = await this.createForumPost(message, questionContent);
            if (thread) {
                await message.reply(`I've created a forum post for your question: ${thread.url}`);
            }
        }
    }

    // Train model with new examples
    async trainModel(questions) {
        for (const question of questions) {
            const keyTerms = await this.extractKeyTerms(question.content);
            await this.prisma.question.update({
                where: { id: question.id },
                data: { keyTerms: keyTerms }
            });
        }
    }
}

module.exports = ForumQAManager;

const manager = new ForumQAManager(process.env.OPEN_AI);
manager.initialize(process.env.DISCORD_TOKEN);