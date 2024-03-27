'use strict';
import { ChatOllama } from "@langchain/community/chat_models/ollama";
import { OllamaEmbeddings } from "@langchain/community/embeddings/ollama";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RedisVectorStore } from "@langchain/redis";
import { } from 'dotenv/config';
import { createStuffDocumentsChain } from "langchain/chains/combine_documents";
import { TextLoader } from "langchain/document_loaders/fs/text";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { createClient } from "redis";

async function main() {
    // 连接 Redis Stack
    const client = createClient({
        url: "redis://localhost:6379", // Default value
    });
    await client.connect();

    try {
        // 选择 embedding 模型
        const embeddings = new OllamaEmbeddings({
            model: "qwen",
            maxConcurrency: 5,
        });
        
        // 指定 redis 存储配置
        const redisAddOptions = {
            redisClient: client,
            indexName: "docs",
        }

        // 矢量存储
        const vectorStore = new RedisVectorStore(embeddings, redisAddOptions);

        await vectorStore.dropIndex(true) // 删除索引

        // 校验索引是否存在，避免多次 embedding
        let hasIndex = await vectorStore.checkIndexExists();
        if (!hasIndex) {
            // 加载本地知识库
            const loader = new TextLoader("docs/RAG.txt");
            const docs = await loader.load();

            // 拆分文本
            const splitter = new RecursiveCharacterTextSplitter({
                chunkSize: 256,
                chunkOverlap: 0,
            });
            const splitDocs = await splitter.splitDocuments(docs);

            // 转为向量存入矢量数据库
            await vectorStore.addDocuments(splitDocs);
        }

        // 定义 prompt
        const prompt =
            ChatPromptTemplate.fromTemplate(`根据下面的上下文（context）内容回答问题。如果没在上下文（context）里找到答案，就回答不知道，不要试图编造答案。答案最多3句话，保持答案简洁。
        {context}
        问题: {question}`);

        // 连接问答模型
        const chatModel = new ChatOllama({
            baseUrl: "http://localhost:11434", // Default value
            model: "qwen",
            max_token: 80000,
            // topP: 0.5,
            temperature: 0
        });

        // 定义 chain
        const documentChain = await createStuffDocumentsChain({
            llm: chatModel,
            prompt,
            outputParser: new StringOutputParser(),
        });

        // 在矢量数据库里匹配相似的 Document
        const question = "RAG 是什么?";
        const retriever = vectorStore.asRetriever({ k: 6, searchType: "similarity" });
        const retrievedDocs = await retriever.getRelevantDocuments(question);
        // console.log(retrievedDocs);

        // 塞入模型提问
        const result = await documentChain.invoke({
            question,
            context: retrievedDocs,
        });
        console.log(result); // RAG 是检索增强生成（Retrieval Augmented Generation，RAG）的简称。
    } catch (error) {
        console.log(error);
    } finally {
        await client.disconnect();
    }
}

main()