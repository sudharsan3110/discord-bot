require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const tf = require('@tensorflow/tfjs');
const use = require('@tensorflow-models/universal-sentence-encoder');

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// MongoDB Schema
const faqSchema = new mongoose.Schema({
    serverId: String,
    channelId: String,
    question: String,
    answer: String,
    questionEmbedding: [Number],
    questionMessageId: String,
    answerMessageId: String,
    createdAt: { type: Date, default: Date.now }
});

const FAQ = mongoose.model('FAQ', faqSchema);

// Global variable to store the USE model
let model;

// Connect to MongoDB and load the USE model
async function initialize() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to MongoDB');
        model = await use.load();
        console.log('Loaded Universal Sentence Encoder model');
    } catch (error) {
        console.error('Initialization error:', error);
    }
}

// Helper function to get embeddings
async function getEmbedding(text) {
    const embedding = await model.embed(text);
    return Array.from(await embedding.data());
}

// Helper function to calculate cosine similarity
function cosineSimilarity(a, b) {
    const dotProduct = a.reduce((sum, value, i) => sum + value * b[i], 0);
    const magnitudeA = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
    const magnitudeB = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0));
    return dotProduct / (magnitudeA * magnitudeB);
}

// Find similar questions
async function findSimilarQuestions(questionEmbedding, serverId, threshold = 0.8) {
    const faqs = await FAQ.find({ serverId });
    
    const similarities = await Promise.all(faqs.map(async (faq) => {
        const similarity = cosineSimilarity(questionEmbedding, faq.questionEmbedding);
        return {
            id: faq._id,
            question: faq.question,
            answer: faq.answer,
            similarity: similarity
        };
    }));

    return similarities
        .filter(faq => faq.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity);
}

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    
    const prefix = '!faq';
    if (!message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    try {
        switch (command) {
            case 'search':
                const searchQuery = args.join(' ');
                if (!searchQuery) {
                    await message.reply('Please provide a question to search for.');
                    return;
                }

                const questionEmbedding = await getEmbedding(searchQuery);
                const similarQuestions = await findSimilarQuestions(questionEmbedding, message.guild.id);

                if (similarQuestions.length > 0) {
                    const embed = new EmbedBuilder()
                        .setTitle('Similar Questions Found')
                        .setColor('#0099ff');

                    similarQuestions.slice(0, 3).forEach((faq, index) => {
                        embed.addFields({
                            name: `Match #${index + 1} (${(faq.similarity * 100).toFixed(1)}% similar)`,
                            value: `Q: ${faq.question}\nA: ${faq.answer}`,
                            inline: false
                        });
                    });

                    await message.reply({ embeds: [embed] });
                } else {
                    await message.reply('No similar questions found. You can mark a Q&A pair using `!faq mark`.');
                }
                break;

            case 'mark':
                const [questionMsgId, answerMsgId] = args;
                if (!questionMsgId || !answerMsgId) {
                    await message.reply('Please provide both question and answer message IDs.');
                    return;
                }

                const questionMsg = await message.channel.messages.fetch(questionMsgId);
                const answerMsg = await message.channel.messages.fetch(answerMsgId);

                const embedding = await getEmbedding(questionMsg.content);

                const newFAQ = new FAQ({
                    serverId: message.guild.id,
                    channelId: message.channel.id,
                    question: questionMsg.content,
                    answer: answerMsg.content,
                    questionEmbedding: embedding,
                    questionMessageId: questionMsgId,
                    answerMessageId: answerMsgId
                });

                await newFAQ.save();

                const confirmEmbed = new EmbedBuilder()
                    .setTitle('New FAQ Added')
                    .setColor('#00ff00')
                    .setTimestamp()
                    .addFields(
                        { name: 'Question', value: questionMsg.content, inline: false },
                        { name: 'Answer', value: answerMsg.content, inline: false }
                    );

                await message.reply({ embeds: [confirmEmbed] });
                break;

            case 'list':
                const faqs = await FAQ.find({ serverId: message.guild.id })
                    .sort({ createdAt: -1 })
                    .limit(10);

                if (faqs.length > 0) {
                    const listEmbed = new EmbedBuilder()
                        .setTitle('Server FAQs')
                        .setColor('#0099ff');

                    faqs.forEach((faq, index) => {
                        const questionPreview = faq.question.length > 100 
                            ? faq.question.substring(0, 100) + '...' 
                            : faq.question;
                        const answerPreview = faq.answer.length > 200 
                            ? faq.answer.substring(0, 200) + '...' 
                            : faq.answer;

                        listEmbed.addFields({
                            name: `${index + 1}. ${questionPreview}`,
                            value: answerPreview,
                            inline: false
                        });
                    });

                    await message.reply({ embeds: [listEmbed] });
                } else {
                    await message.reply('No FAQs found in this server.');
                }
                break;

            case 'help':
                const helpEmbed = new EmbedBuilder()
                    .setTitle('FAQ Bot Help')
                    .setDescription('Available commands:')
                    .setColor('#0099ff')
                    .addFields(
                        { 
                            name: '!faq search <question>', 
                            value: 'Search for similar questions in the FAQ database',
                            inline: false 
                        },
                        { 
                            name: '!faq mark <question_msg_id> <answer_msg_id>', 
                            value: 'Mark a Q&A pair as FAQ',
                            inline: false 
                        },
                        { 
                            name: '!faq list', 
                            value: 'List all FAQs in the server',
                            inline: false 
                        },
                        { 
                            name: '!faq help', 
                            value: 'Show this help message',
                            inline: false 
                        }
                    );

                await message.reply({ embeds: [helpEmbed] });
                break;
        }
    } catch (error) {
        console.error('Error:', error);
        await message.reply('An error occurred while processing your request.');
    }
});

// Create a .env file with:
// DISCORD_TOKEN=your_discord_bot_token
// MONGODB_URI=your_mongodb_connection_string

// Initialize and start the bot
initialize().then(() => {
    client.login(process.env.DISCORD_TOKEN);
}).catch(console.error);