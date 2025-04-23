import { ChromaClient } from "chromadb";
import { genAI } from "./genai";

let chromaClient: ChromaClient | null = null;

export const getChromaClient = () => {
    if (!chromaClient) {
        chromaClient = new ChromaClient();
    }
    return chromaClient;
};

export const getCollection = async (collectionName: string) => {
    const client = getChromaClient();
    const collection = await client.getOrCreateCollection({
        name: collectionName
    });
    return collection;
}

/**
 * Using models/text-embedding-004 to get the embedding of the text
 * @param collectionName The name of the ChromaDB collection.
 * @param document The document object to add. Can be any object.
 * @param idKey The key within the document object whose string value should be used as the ID.
 */
export const addDocument = async <DocType extends Record<K, string>, K extends keyof DocType>(
    collectionName: string,
    document: DocType,
    idKey: K
) => {
    const collection = await getCollection(collectionName);

    // Stringify the document content for embedding
    const contentString = JSON.stringify(document);

    // Generate embedding
    const result = await genAI.models.embedContent({
        model: "models/text-embedding-004",
        contents: [
            contentString
        ]
    });
    
    const embedding = result.embeddings?.[0].values;

    if (!embedding) {
        throw new Error("Failed to generate embedding");
    }

    // Add the document to the collection
    await collection.add({
        ids: [document[idKey]],
        embeddings: [embedding],
        metadatas: [document] // Store the original document as metadata
    });

    console.log(`Document added to ${collectionName} with ID: ${document[idKey]}`);
};

/**
 * Finds documents in a collection similar to the input object based on embeddings.
 * @param collectionName The name of the ChromaDB collection.
 * @param inputObject The object to find similar documents for.
 * @param nResults The number of similar documents to return. Defaults to 5.
 * @returns The query results from ChromaDB.
 */
export const findSimilarDocuments = async (
    collectionName: string,
    inputObject: object,
    nResults: number = 5
) => {
    const collection = await getCollection(collectionName);

    // Stringify the input object for embedding
    const contentString = JSON.stringify(inputObject);

    // Generate embedding for the input object
    const result = await genAI.models.embedContent({
        model: "models/text-embedding-004",
        contents: [
            contentString
        ]
    });
    const embedding = result.embeddings?.[0].values;

    if (!embedding) {
        throw new Error("Failed to generate embedding for query object");
    }

    // Query the collection
    const results = await collection.query({
        queryEmbeddings: [embedding],
        nResults: nResults,
        // You can optionally include metadatas or documents in the results
        // include: ["metadatas", "documents"] 
    });

    console.log(`Found ${results.ids?.[0]?.length ?? 0} similar documents in ${collectionName}.`);
    return results;
};

/**
 * Finds documents in a collection similar to the input query string based on embeddings.
 * @param collectionName The name of the ChromaDB collection.
 * @param queryString The string to find similar documents for.
 * @param nResults The number of similar documents to return. Defaults to 5.
 * @returns The query results from ChromaDB.
 */
export const findDocumentsByString = async (
    collectionName: string,
    queryString: string,
    nResults: number = 5
) => {
    const collection = await getCollection(collectionName);

    // Generate embedding for the query string
    const result = await genAI.models.embedContent({
        model: "models/text-embedding-004",
        contents: [
            queryString
        ]
    });
    const embedding = result.embeddings?.[0].values;

    if (!embedding) {
        throw new Error("Failed to generate embedding for query string");
    }

    // Query the collection
    const results = await collection.query({
        queryEmbeddings: [embedding],
        nResults: nResults,
        // You can optionally include metadatas or documents in the results
        // include: ["metadatas", "documents"]
    });

    console.log(`Found ${results.ids?.[0]?.length ?? 0} similar documents in ${collectionName} for query: "${queryString}".`);
    return results;
};