import { IncludeEnum } from "chromadb";
import { getCollection } from "./chromadb";
import { genAI } from "./genai";

/**
 * Represents a keyword mapping.
 */
interface Keyword {
    from: string;
    to: string;
}

/**
 * Adds a keyword document to the specified ChromaDB collection.
 * The embedding is generated based on the 'from' property, which is also used as the ID.
 * The entire keyword object is stored as metadata.
 * Uses models/text-embedding-004 for embedding.
 * @param collectionName The name of the ChromaDB collection.
 * @param keyword The keyword object ({ from: string, to: string }) to add.
 */
export const addKeywordDocument = async (
    collectionName: string,
    keyword: Keyword
) => {
    const collection = await getCollection(collectionName);

    // Use the 'from' property for embedding content
    const contentString = keyword.from;

    // Generate embedding
    const result = await genAI.models.embedContent({
        model: "models/text-embedding-004",
        contents: [contentString] // Use embedContent for single string
    });

    const embedding = result.embeddings?.[0].values;

    if (!embedding) {
        throw new Error("Failed to generate embedding");
    }

    try {
        // Add the document to the collection
        await collection.add({
            ids: [keyword.from.toLowerCase().trim()], // Use 'from' as the ID
            embeddings: [embedding],
            metadatas: [keyword as any] // Store the original keyword object as metadata
        });
    } catch {}

    console.log(`Keyword document added to ${collectionName} with ID: ${keyword.from}`);
};

/**
 * Searches for keywords in the specified ChromaDB collection based on a query string.
 * Generates an embedding for the query and finds the nearest neighbors.
 * Uses models/text-embedding-004 for embedding.
 * @param collectionName The name of the ChromaDB collection.
 * @param query The search query string.
 * @param nResults The maximum number of results to return (default: 5).
 * @returns A promise that resolves to an array of keyword objects (metadata) found.
 */
export const searchKeyword = async (
    collectionName: string,
    query: string,
    nResults: number = 5
): Promise<Keyword[]> => {
    const collection = await getCollection(collectionName);

    // Generate embedding for the query
    const result = await genAI.models.embedContent({
        model: "models/text-embedding-004",
        contents: [query]
    });

    const queryEmbedding = result.embeddings?.[0].values;

    if (!queryEmbedding) {
        throw new Error("Failed to generate query embedding");
    }

    // Query the collection
    const results = await collection.query({
        queryEmbeddings: [queryEmbedding],
        nResults: nResults,
        include: [IncludeEnum.Metadatas]
    });

    const keywords = results.metadatas?.[0]?.map(meta => meta as unknown as Keyword) ?? [];
    return keywords;
};