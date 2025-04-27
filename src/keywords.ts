import { IncludeEnum } from "chromadb";
import { promises as fs } from 'fs'; // Import fs promises
import path from 'path'; // Import path
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
 * Fetches all keyword documents from the specified collection, sorts them,
 * and saves them to a JSON file in the process/keywords directory.
 * @param collectionName The name of the ChromaDB collection.
 */
export const fetchAllKeywordsAndSave = async (collectionName: string): Promise<void> => {
    try {
        const collection = await getCollection(collectionName);
        const allDocs = await collection.get({ include: [IncludeEnum.Metadatas] });
        const allKeywords = allDocs.metadatas
            .map(meta => meta as unknown as Keyword)
            .filter(kw => kw && typeof kw.from === 'string' && typeof kw.to === 'string'); // Basic validation

        // Sort keywords alphabetically by 'from' for consistency
        allKeywords.sort((a, b) => a.from.localeCompare(b.from));

        const keywordsDir = path.join(__dirname, '..', 'process', 'keywords');
        const jsonFilePath = path.join(keywordsDir, `${collectionName}.json`);

        // Ensure the directory exists
        await fs.mkdir(keywordsDir, { recursive: true });

        // Write the JSON file
        await fs.writeFile(jsonFilePath, JSON.stringify(allKeywords, null, 2), 'utf8');
    } catch (error) {
        console.error(`Failed to fetch keywords or write JSON backup for ${collectionName}:`, error);
        // Decide if this error should halt the process or just be logged
        // Re-throwing might be appropriate if the initial keyword state is critical
        // throw error;
    }
};

/**
 * Adds a keyword document to the specified ChromaDB collection and updates the JSON backup.
 * The embedding is generated based on the 'from' property, which is also used as the ID.
 * The entire keyword object is stored as metadata.
 * Uses models/text-embedding-004 for embedding.
 * After adding, fetches all keywords and saves them to process/keywords/COLLECTION_NAME.json.
 * @param collectionName The name of the ChromaDB collection.
 * @param keyword The keyword object ({ from: string, to: string }) to add.
 * @param skipSave Optional flag to skip saving the JSON backup after adding (default: false).
 */
export const addKeywordDocument = async (
    collectionName: string,
    keyword: Keyword,
    skipSave: boolean = false // Add skipSave parameter
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

    let addedSuccessfully = false;
    const keywordId = keyword.from.toLowerCase().trim(); // Normalize ID
    try {
        // Add the document to the collection
        await collection.add({
            ids: [keywordId], // Use normalized 'from' as the ID
            embeddings: [embedding],
            metadatas: [keyword as any] // Store the original keyword object as metadata
        });
        addedSuccessfully = true;
        console.log(`Keyword document added/updated in ${collectionName} with ID: ${keywordId}`);
    } catch (error: any) {
         // Handle potential duplicate ID errors or other issues gracefully
        if (error.message?.includes('ID already exists')) {
            console.warn(`Keyword with ID ${keywordId} already exists in ${collectionName}. Skipping addition.`);
            // Optionally, you could implement an update logic here if needed
        } else {
            console.error(`Failed to add keyword ${keywordId} to ${collectionName}:`, error);
            // Decide if you want to throw the error or just log it
            // throw error;
        }
    }

    // If added successfully and skipSave is false, fetch all keywords and save to JSON
    if (addedSuccessfully && !skipSave) {
        // Call the extracted function
        await fetchAllKeywordsAndSave(collectionName);
    }
};

/**
 * Synchronizes the ChromaDB collection with the keywords stored in the JSON backup file.
 * It reads the JSON backup, fetches current keywords from the DB,
 * and adds any keywords from the JSON that are missing in the DB or updates existing
 * keywords if their 'to' value has changed.
 * Uses upsert for efficiency.
 * @param collectionName The name of the ChromaDB collection.
 */
export const syncKeywordsFromJson = async (collectionName: string): Promise<void> => {
    console.log(`Starting keyword synchronization for collection: ${collectionName}`);
    try {
        // 1. Fetch current keywords from DB and store in a map for easy lookup
        const collection = await getCollection(collectionName);
        const currentDocs = await collection.get({ include: [IncludeEnum.Metadatas] });
        const currentKeywordsMap = new Map<string, Keyword>();
        currentDocs.ids.forEach((id, index) => {
            const metadata = currentDocs.metadatas?.[index] as unknown as Keyword;
            if (metadata && typeof metadata.from === 'string' && typeof metadata.to === 'string') {
                currentKeywordsMap.set(id.toLowerCase().trim(), metadata); // Use normalized ID as key
            }
        });
        console.log(`Found ${currentKeywordsMap.size} keywords currently in the database.`);

        // 2. Read JSON backup
        const keywordsDir = path.join(__dirname, '..', 'process', 'keywords');
        const jsonFilePath = path.join(keywordsDir, `${collectionName}.json`);
        let keywordsFromJson: Keyword[] = [];
        try {
            const jsonData = await fs.readFile(jsonFilePath, 'utf8');
            keywordsFromJson = JSON.parse(jsonData);
            console.log(`Read ${keywordsFromJson.length} keywords from JSON backup: ${jsonFilePath}`);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                console.warn(`JSON backup file not found: ${jsonFilePath}. Cannot sync.`);
                return; // Exit if no backup file exists
            } else {
                console.error(`Failed to read or parse JSON backup file ${jsonFilePath}:`, error);
                throw error; // Re-throw other errors
            }
        }

        // 3. Identify keywords to add or update (upsert)
        const keywordsToUpsert: Keyword[] = [];
        for (const keywordJson of keywordsFromJson) {
            // Basic validation for keyword structure from JSON
            if (!keywordJson || typeof keywordJson.from !== 'string' || typeof keywordJson.to !== 'string') {
                console.warn('Skipping invalid keyword entry from JSON:', keywordJson);
                continue;
            }
            const keywordIdJson = keywordJson.from.toLowerCase().trim(); // Normalize ID from JSON
            const keywordDb = currentKeywordsMap.get(keywordIdJson);

            // Add if missing OR if 'to' value is different
            if (!keywordDb || keywordDb.to !== keywordJson.to) {
                keywordsToUpsert.push(keywordJson);
            }
        }

        // 4. Perform upsert if needed
        if (keywordsToUpsert.length > 0) {
            console.log(`Found ${keywordsToUpsert.length} keywords to add or update in the database. Processing upsert...`);

            // Prepare data for bulk upsert
            const ids: string[] = [];
            const metadatas: any[] = [];
            const embeddings: number[][] = []; // Array to hold generated embeddings

            console.log(`Generating embeddings for ${keywordsToUpsert.length} keywords...`);
            for (const kw of keywordsToUpsert) {
                const keywordId = kw.from.toLowerCase().trim();
                try {
                    // Generate embedding for each keyword individually
                    const result = await genAI.models.embedContent({
                        model: "models/text-embedding-004",
                        contents: kw.from // Use 'from' for embedding content
                    });
                    const embedding = result.embeddings?.[0].values;

                    if (!embedding) {
                        console.warn(`Failed to generate embedding for keyword ID: ${keywordId}. Skipping this keyword.`);
                        continue; // Skip this keyword if embedding fails
                    }

                    // Add data for successful embedding generation
                    ids.push(keywordId);
                    metadatas.push(kw);
                    embeddings.push(embedding);

                } catch (embedError) {
                    console.error(`Error generating embedding for keyword ID: ${keywordId}:`, embedError);
                    // Optionally decide whether to stop the whole sync or just skip this keyword
                    // For now, we skip the keyword by continuing the loop
                    continue;
                }
            }
            console.log(`Embeddings generated. Proceeding with upsert for ${ids.length} keywords.`);


            // Check if there are any valid keywords left to upsert
            if (ids.length === 0) {
                 console.log("No valid keywords with embeddings to upsert after generation process.");
                 // No need to call fetchAllKeywordsAndSave if nothing was actually upserted
                 console.log(`Keyword synchronization finished for collection: ${collectionName}`);
                 return;
            }


            try {
                // Upsert the documents with generated embeddings
                await collection.upsert({
                    ids: ids,
                    embeddings: embeddings,
                    metadatas: metadatas
                });
                console.log(`Successfully upserted ${ids.length} keywords.`);

                // 5. Save the consolidated list back to JSON *once* after successful upsert
                await fetchAllKeywordsAndSave(collectionName);
                console.log(`Updated JSON backup file after synchronization.`);

            } catch (upsertError) {
                 console.error(`Failed during bulk upsert operation for ${collectionName}:`, upsertError);
                 // Decide how to handle bulk upsert errors
                 throw upsertError; // Re-throw to indicate sync failure
            }

        } else {
            console.log('Database is already in sync with the JSON backup.');
        }

    } catch (error) {
        console.error(`Failed to synchronize keywords for ${collectionName}:`, error);
        // Decide how to handle top-level errors during sync
        // throw error;
    }
    console.log(`Keyword synchronization finished for collection: ${collectionName}`);
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
    nResults?: number
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