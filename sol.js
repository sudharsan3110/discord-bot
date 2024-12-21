const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { PrismaClient } = require("@prisma/client");

class FAQThreadManager {
  constructor(googleApiKey) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Message, Partials.Channel],
    });

    this.genAI = new GoogleGenerativeAI(googleApiKey);
    this.model = this.genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    this.embeddingModel = this.genAI.getGenerativeModel({
      model: "embedding-001",
    });
    this.prisma = new PrismaClient();
    this.similarityThreshold = 0.45;
    this.confidenceScores = {
      HIGH: 0.65,
      MEDIUM: 0.45,
      LOW: 0.35,
    };
  }

  // Initialize the bot
  async initialize(discordToken) {
    this.client.on("ready", () => {
      console.log("FAQ Thread Manager is ready!");
    });

    this.client.on("messageCreate", async (message) => {
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
      console.error("Error getting embedding:", error);
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

  // Add confidence level check
  getConfidenceLevel(similarity) {
    if (similarity >= this.confidenceScores.HIGH) return "HIGH";
    if (similarity >= this.confidenceScores.MEDIUM) return "MEDIUM";
    if (similarity >= this.confidenceScores.LOW) return "LOW";
    return "NONE";
  }

  // Enhance similarity calculation with weighted features
  async findSimilarQuestion(questionText) {
    try {
      const existingQuestions = await this.prisma.question.findMany({
        include: {
          thread: true,
        },
      });

      console.log(`Found ${existingQuestions.length} existing questions`);

      const matches = await Promise.all(
        existingQuestions.map(async (existing) => {
          // Use Gemini's semantic understanding directly
          const semanticPrompt = `
            Compare if these two questions are asking about the same thing.
            Consider them similar if they're seeking the same information, even if phrased differently.
            Rate from 0 to 1, where:
            1 = asking about exactly the same thing
            0 = completely different topics
            
            Question 1: "${questionText}"
            Question 2: "${existing.content}"

            Examples of similar questions (score 0.9+):
            - "what is an array" ≈ "can someone explain arrays"
            - "how to create array" ≈ "help me make an array"
            - "need help with arrays" ≈ "confused about arrays how do they work"

            Return only a number between 0 and 1.
          `;

          const result = await this.model.generateContent(semanticPrompt);
          const similarity = parseFloat(result.response.text().trim());

          console.log("\n=== Comparing Questions ===");
          console.log("New:", questionText);
          console.log("Existing:", existing.content);
          console.log("Similarity:", similarity.toFixed(3));

          return {
            ...existing,
            similarity,
            confidenceLevel: this.getConfidenceLevel(similarity),
          };
        })
      );

      const bestMatch = matches
        .filter((m) => m.similarity > this.similarityThreshold)
        .sort((a, b) => b.similarity - a.similarity)[0];

      return bestMatch;
    } catch (error) {
      console.error("Error finding similar question:", error);
      return null;
    }
  }

  // Create a new thread and store in database
  async createQuestionThread(message) {
    try {
      const thread = await message.startThread({
        name: `FAQ: ${message.content.substring(0, 50)}...`,
        autoArchiveDuration: 1440,
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
              channelId: message.channelId,
            },
          },
        },
      });

      return thread;
    } catch (error) {
      console.error("Error creating thread:", error);
      return null;
    }
  }

  // Enhance question detection
  async isQuestion(message) {
    try {
      const text = message.content.toLowerCase().trim();

      // Basic question indicators
      const hasQuestionMark = text.includes("?");

      // Question words anywhere in the sentence
      const questionWords = [
        "what",
        "how",
        "why",
        "when",
        "where",
        "who",
        "which",
        "whose",
        "whom",
        "is",
        "are",
        "can",
        "could",
        "should",
        "would",
        "will",
        "do",
        "does",
        "did",
        "anyone",
        "anybody",
        "help",
        "explain",
        "tell",
        "wonder",
      ];

      // Check for question words anywhere in the text
      const hasQuestionWord = questionWords.some((word) => text.includes(word));

      // Common question patterns
      const questionPatterns = [
        /can (you|someone|anybody)/i,
        /could (you|someone|anybody)/i,
        /please help/i,
        /need help/i,
        /any idea/i,
        /anyone know/i,
        /wondering (if|how|what|why)/i,
        /trying to/i,
        /help me/i,
        /explain/i,
      ];

      const matchesQuestionPattern = questionPatterns.some((pattern) =>
        pattern.test(text)
      );

      // Quick return if obvious question indicators are present
      if (hasQuestionMark || matchesQuestionPattern) {
        return true;
      }

      // If has question word, double check with AI
      if (hasQuestionWord) {
        const prompt = `Analyze if this is a question or request for information, even if informal. Context: "${text}" Respond with only 'true' or 'false'.`;
        const result = await this.model.generateContent(prompt);
        return result.response.text().trim().toLowerCase() === "true";
      }

      // For everything else, use AI with more context
      const prompt = `
        Analyze if this message is a question or request for information, even if:
        - It's informally written
        - Doesn't use proper grammar
        - Doesn't have question marks
        - Question words are in unusual positions
        
        Message: "${text}"
        Respond with only 'true' or 'false'.
      `;

      const result = await this.model.generateContent(prompt);
      return result.response.text().trim().toLowerCase() === "true";
    } catch (error) {
      console.error("Error checking if message is question:", error);
      // Fallback to basic detection
      return (
        message.content.includes("?") ||
        /^(what|how|why|when|where|who)/i.test(message.content.trim())
      );
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
      return response === "true";
    } catch (error) {
      console.error("Error checking answer relevance:", error);
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
          questionId: questionId,
        },
      });
    } catch (error) {
      console.error("Error storing answer:", error);
    }
  }

  // Handle new messages
  async handleMessage(message) {
    try {
      if (await this.isQuestion(message)) {
        console.log("\n=== New Question Detected ===");
        console.log("Question:", message.content);

        const similarQuestion = await this.findSimilarQuestion(message.content);

        if (similarQuestion && similarQuestion.thread) {
          console.log("=== Similar Question Found ===");
          console.log(
            "Similarity Score:",
            similarQuestion.similarity.toFixed(3)
          );
          console.log("Existing Question:", similarQuestion.content);

          const threadData = await this.prisma.thread.findUnique({
            where: {
              threadId: similarQuestion.thread.threadId,
            },
          });

          if (threadData) {
            await message.reply({
              content: `Similar question was already asked! Check this thread: https://discord.com/channels/${threadData.guildId}/${threadData.channelId}/${threadData.threadId}`,
              allowedMentions: { repliedUser: false },
            });
          } else {
            console.log(
              "Thread data not found for:",
              similarQuestion.thread.threadId
            );
            // Create new thread if existing thread not found
            const thread = await this.createQuestionThread(message);
            if (thread) {
              await thread.send("New FAQ thread created! Awaiting answers...");
            }
          }
        } else {
          console.log("No similar question found, creating new thread");
          const thread = await this.createQuestionThread(message);
          if (thread) {
            await thread.send("New FAQ thread created! Awaiting answers...");
          }
        }
      } else {
        await this.processMessageAsAnswer(message);
      }
    } catch (error) {
      console.error("Error handling message:", error);
    }
  }

  // Process potential answers
  async processMessageAsAnswer(message) {
    try {
      const recentQuestions = await this.prisma.question.findMany({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
        },
        include: {
          thread: true,
        },
      });

      for (const question of recentQuestions) {
        if (
          message.reference?.messageId === question.messageId ||
          (await this.isRelevantAnswer(message, question))
        ) {
          const thread = await this.client.channels.fetch(
            question.thread.threadId
          );
          await thread.send({
            content: `Potential answer from ${message.author}:\n${message.content}`,
            allowedMentions: { users: [] },
          });

          await this.storeAnswer(question.id, message);
        }
      }
    } catch (error) {
      console.error("Error processing answer:", error);
    }
  }
}

module.exports = FAQThreadManager;

// Database schema (prisma/schema.prisma):
/*
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model Question {
    id          Int      @id @default(autoincrement())
    content     String
    embedding   Float[]
    authorId    String
    messageId   String   @unique
    createdAt   DateTime @default(now())
    thread      Thread   @relation(fields: [threadId], references: [id])
    threadId    Int
    answers     Answer[]
}

model Thread {
    id          Int      @id @default(autoincrement())
    threadId    String   @unique
    guildId     String
    channelId   String
    createdAt   DateTime @default(now())
    question    Question?
}

model Answer {
    id          Int      @id @default(autoincrement())
    content     String
    authorId    String
    messageId   String   @unique
    createdAt   DateTime @default(now())
    question    Question @relation(fields: [questionId], references: [id])
    questionId  Int
}
*/

const manager = new FAQThreadManager(process.env.OPEN_AI);
manager.initialize(process.env.DISCORD_TOKEN);