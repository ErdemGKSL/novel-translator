import './config';
import { promises as fs } from 'fs'; // Import fs/promises
import path from 'path'; // Import path
import { JSDOM } from 'jsdom'; // Import JSDOM

import { Type } from '@google/genai';
import { genAI } from './genai';
import { searchKeyword, addKeywordDocument, fetchAllKeywordsAndSave, syncKeywordsFromJson } from './keywords';

// --- Constants ---
const NOVEL_BASE_URL = "https://www.lightnovelworld.com/novel/the-dark-king-16091324";
const DOMAIN = "https://www.lightnovelworld.com";
const CACHE_DIR = path.join(__dirname, '..', 'process'); // Use path.join for cross-platform compatibility
const CHAPTER_CACHE_FILE = path.join(CACHE_DIR, 'chapter-cache.json');
const PROCESSED_CHAPTERS_DIR = path.join(CACHE_DIR, 'chapters/source'); // Directory for processed text files
const TRANSLATED_CHAPTERS_DIR = path.join(CACHE_DIR, 'chapters/translated'); // Directory for translated text files
const TRANSLATION_STATE_DIR = path.join(CACHE_DIR, 'chapters/translation-state'); // Directory for temporary state files
const COLLECTION_NAME = "the-dark-king-keywords"; // Example collection name
const SOURCE_LANGUAGE = "English";
const TARGET_LANGUAGE = "Turkish"; // Example target language
const CONTEXT_WINDOW = 5; // Number of previous/future lines for context

// --- Caching Function ---
async function cacheChapterUrls(): Promise<void> {
    try {
        // Check if cache file exists
        await fs.access(CHAPTER_CACHE_FILE);
        console.log(`Chapter cache already exists at: ${CHAPTER_CACHE_FILE}. Skipping cache generation.`);
        return;
    } catch (error) {
        // Cache file doesn't exist or is inaccessible, proceed with caching
        console.log('Chapter cache not found. Fetching chapter list...');
    }

    const allChapters: { chapter: number; url: string }[] = [];
    let page = 1;
    let chaptersFoundOnPage = true;

    console.log(`Fetching chapters from ${NOVEL_BASE_URL}/chapters`);

    while (chaptersFoundOnPage) {
        const pageUrl = `${NOVEL_BASE_URL}/chapters?page=${page}`;
        console.log(`Fetching page ${page}: ${pageUrl}`);
        try {
            const response = await fetch(pageUrl);
            if (!response.ok) {
                console.warn(`Failed to fetch page ${page}. Status: ${response.status}. Assuming end of chapters.`);
                break; // Stop if a page fails to load
            }
            const html = await response.text();
            const dom = new JSDOM(html);
            const document = dom.window.document;

            const chapterLinks = document.querySelectorAll('li[data-chapterno] a');

            if (chapterLinks.length === 0) {
                console.log(`No chapters found on page ${page}. Assuming end of list.`);
                chaptersFoundOnPage = false;
            } else {
                chapterLinks.forEach(link => {
                    const li = link.closest('li');
                    const chapterNoStr = li?.getAttribute('data-chapterno');
                    const relativeUrl = link.getAttribute('href');

                    if (chapterNoStr && relativeUrl) {
                        const chapterNo = parseInt(chapterNoStr, 10);
                        const fullUrl = DOMAIN + relativeUrl;
                        allChapters.push({ chapter: chapterNo, url: fullUrl });
                    }
                });
                page++;
            }
            // Add a small delay to avoid overwhelming the server
            await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay

        } catch (error) {
            console.error(`Error fetching or processing page ${page}:`, error);
            chaptersFoundOnPage = false; // Stop on error
        }
    }

    if (allChapters.length > 0) {
        // Sort chapters by chapter number
        allChapters.sort((a, b) => a.chapter - b.chapter);

        try {
            // Ensure the process directory exists
            await fs.mkdir(CACHE_DIR, { recursive: true }); // This line creates the directory if it doesn't exist
            // Write the cache file
            await fs.writeFile(CHAPTER_CACHE_FILE, JSON.stringify(allChapters, null, 2), 'utf8');
            console.log(`Successfully cached ${allChapters.length} chapters to: ${CHAPTER_CACHE_FILE}`);
        } catch (error) {
            console.error('Error writing chapter cache file:', error);
        }
    } else {
        console.log('No chapters found to cache.');
    }
}

// --- Chapter Processing Function ---
async function fetchAndProcessChapter(chapter: { chapter: number; url: string }, outputDir: string): Promise<void> {
    const outputFilePath = path.join(outputDir, `chapter_${chapter.chapter}.txt`);
    console.log(`Processing Chapter ${chapter.chapter}: ${chapter.url}`);

    try {
        // Check if the processed file already exists
        await fs.access(outputFilePath);
        console.log(`Chapter ${chapter.chapter} already processed. Skipping.`);
        return;
    } catch (error) {
        // File doesn't exist, proceed with fetching and processing
    }

    try {
        const response = await fetch(chapter.url);
        if (!response.ok) {
            console.error(`Failed to fetch Chapter ${chapter.chapter}. Status: ${response.status}`);
            return; // Skip this chapter on fetch error
        }
        const html = await response.text();
        const dom = new JSDOM(html);
        const document = dom.window.document;

        const chapterContainer = document.getElementById('chapter-container');
        if (!chapterContainer) {
            console.error(`Could not find #chapter-container for Chapter ${chapter.chapter}`);
            return; // Skip if container not found
        }

        // Remove potential ad divs before extracting text
        chapterContainer.querySelectorAll('div.vnad-in').forEach(adDiv => adDiv.remove());

        // Extract text from paragraph tags
        const paragraphs = Array.from(chapterContainer.querySelectorAll('p'));
        const chapterText = paragraphs
            .map(p => p.textContent?.trim()) // Get text content and trim whitespace
            .filter(text => text) // Filter out empty paragraphs
            .join('\n\n'); // Join paragraphs with double newlines

        if (!chapterText) {
            console.warn(`No text content found in paragraphs for Chapter ${chapter.chapter}`);
            return;
        }

        // Write the extracted text to the output file
        await fs.writeFile(outputFilePath, chapterText, 'utf8');
        console.log(`Successfully processed and saved Chapter ${chapter.chapter} to ${outputFilePath}`);

    } catch (error) {
        console.error(`Error processing Chapter ${chapter.chapter}:`, error);
    }
}

// --- Translation Function ---
async function translateChapter(chapterNumber: number, sourceFilePath: string): Promise<void> {
    const translatedFilePath = path.join(TRANSLATED_CHAPTERS_DIR, `chapter_${chapterNumber}.txt`);
    const stateFilePath = path.join(TRANSLATION_STATE_DIR, `chapter_${chapterNumber}.json`); // Path for the state file
    const MAX_RETRIES = 2; // Maximum number of retries for a single line
    const RETRY_DELAY_MS = 5000; // Delay between retries
    let consecutiveFailures = 0; // Counter for consecutive translation failures

    console.log(`--- Translating Chapter ${chapterNumber} ---`);

    // Ensure state directory exists
    try {
        await fs.mkdir(TRANSLATION_STATE_DIR, { recursive: true });
    } catch (dirError) {
        console.error(`Failed to create translation state directory: ${TRANSLATION_STATE_DIR}`, dirError);
    }

    // Check if final translated file already exists
    try {
        await fs.access(translatedFilePath);
        console.log(`Chapter ${chapterNumber} already fully translated. Skipping.`);
        try {
            await fs.unlink(stateFilePath);
            console.log(`Cleaned up existing state file for chapter ${chapterNumber}.`);
        } catch (unlinkError) {
            if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
                console.warn(`Could not delete state file ${stateFilePath}:`, unlinkError);
            }
        }
        return; // Skip if final translation exists
    } catch (error) {
        // Final translated file doesn't exist, proceed
    }

    let translatedLines: string[] = [];
    let startIndex = 0;
    const previousLinesBuffer: { from: string; to: string }[] = [];
    const skipRegex = /^[ …\r\*]+$/; // Regex to match lines containing only spaces, ellipses, carriage returns, or asterisks
    let sourceLines: string[] = [];

    try {
        const sourceContent = await fs.readFile(sourceFilePath, 'utf8');
        sourceLines = sourceContent.split(/\r?\n/);

        if (sourceLines.length === 0) {
            console.log(`Chapter ${chapterNumber} source file is empty. Skipping translation.`);
            await fs.writeFile(translatedFilePath, '', 'utf8'); // Create empty translated file
            return;
        }

        try {
            const stateData = await fs.readFile(stateFilePath, 'utf8');
            translatedLines = JSON.parse(stateData);
            startIndex = translatedLines.length;
            console.log(`Resuming translation for chapter ${chapterNumber} from line ${startIndex + 1}`);

            const bufferStartIndex = Math.max(0, startIndex - CONTEXT_WINDOW);
            for (let j = bufferStartIndex; j < startIndex; j++) {
                if (j < sourceLines.length) {
                    const originalLine = sourceLines[j];
                    const sourceLineTrimmed = originalLine.trim();
                    const translatedLine = translatedLines[j];

                    if (sourceLineTrimmed && !skipRegex.test(originalLine)) {
                        previousLinesBuffer.push({ from: sourceLineTrimmed, to: translatedLine });
                        if (previousLinesBuffer.length > CONTEXT_WINDOW) {
                            previousLinesBuffer.shift();
                        }
                    }
                } else {
                    console.warn(`Source line index ${j} out of bounds while reconstructing buffer for chapter ${chapterNumber}.`);
                }
            }
            console.log(`Reconstructed previous lines buffer with ${previousLinesBuffer.length} entries.`);
        } catch (stateReadError) {
            if ((stateReadError as NodeJS.ErrnoException).code === 'ENOENT') {
                console.log(`No existing translation state found for chapter ${chapterNumber}. Starting fresh.`);
            } else if (stateReadError instanceof SyntaxError) {
                console.error(`Error parsing state file ${stateFilePath}. Starting fresh. Error:`, stateReadError);
            } else {
                console.error(`Error reading state file ${stateFilePath}. Starting fresh. Error:`, stateReadError);
            }
            translatedLines = [];
            startIndex = 0;
            previousLinesBuffer.length = 0;
        }

        for (let i = startIndex; i < sourceLines.length; i++) {
            const originalLine = sourceLines[i];
            let currentTranslatedLine = "";

            if (skipRegex.test(originalLine)) {
                currentTranslatedLine = originalLine;
                console.log(`Skipping line ${i + 1} (matches regex) of Chapter ${chapterNumber}`);
            } else {
                const currentLine = originalLine.trim();
                if (!currentLine) {
                    currentTranslatedLine = '';
                } else {
                    const futureLines = sourceLines.slice(i + 1, i + 1 + CONTEXT_WINDOW)
                        .map(line => line.trim())
                        .filter(line => line && !skipRegex.test(line));

                    console.log(`Translating line ${i + 1}/${sourceLines.length} of Chapter ${chapterNumber}`);

                    let success = false;
                    let attempts = 0;
                    while (attempts < MAX_RETRIES && !success) {
                        try {
                            const result = await generateTranslatedLine(
                                COLLECTION_NAME,
                                SOURCE_LANGUAGE,
                                TARGET_LANGUAGE,
                                previousLinesBuffer,
                                currentLine,
                                futureLines
                            );

                            currentTranslatedLine = result.translatedLine;

                            if (result.newKeywords && result.newKeywords.length > 0) {
                                console.log(`Adding ${result.newKeywords.length} new keywords for Chapter ${chapterNumber}, Line ${i + 1}`);
                                for (const keyword of result.newKeywords) {
                                    try {
                                        if (keyword.from.trim()) {
                                            await addKeywordDocument(COLLECTION_NAME, keyword);
                                        } else {
                                            console.warn(`Skipping empty 'from' keyword:`, keyword);
                                        }
                                    } catch (kwError) {
                                        console.error(`Failed to add keyword "${keyword.from}": "${keyword.to}"`, kwError);
                                    }
                                }
                            }

                            previousLinesBuffer.push({ from: currentLine, to: result.translatedLine });
                            if (previousLinesBuffer.length > CONTEXT_WINDOW) {
                                previousLinesBuffer.shift();
                            }
                            success = true;
                            consecutiveFailures = 0; // Reset counter on successful translation
                        } catch (lineError) {
                            attempts++;
                            console.error(`Error translating line ${i + 1} of Chapter ${chapterNumber} (Attempt ${attempts}/${MAX_RETRIES}):`, lineError);
                            if (attempts >= MAX_RETRIES) {
                                console.error(`Max retries reached for line ${i + 1}. Marking as untranslated.`);
                                currentTranslatedLine = `NOT TRANSLATED: ${currentLine}`;
                                consecutiveFailures++; // Increment counter on final failure

                                if (consecutiveFailures >= 5) {
                                    console.error(`ERROR: 5 consecutive translation failures detected. Exiting process.`);
                                    process.exit(1); // Exit if 5 consecutive failures occur
                                }
                            } else {
                                console.log(`Retrying in ${RETRY_DELAY_MS / 1000} seconds...`);
                                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                            }
                        }
                    }
                    if (success || attempts >= MAX_RETRIES) {
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                }
            }

            translatedLines.push(currentTranslatedLine);
            try {
                await fs.writeFile(stateFilePath, JSON.stringify(translatedLines, null, 2), 'utf8');
            } catch (stateWriteError) {
                console.error(`Failed to save translation state to ${stateFilePath} after line ${i + 1}:`, stateWriteError);
            }
        }

        const translatedContent = translatedLines.join('\n');
        await fs.writeFile(translatedFilePath, translatedContent, 'utf8');
        console.log(`Successfully translated and saved Chapter ${chapterNumber} to ${translatedFilePath}`);

        try {
            await fs.unlink(stateFilePath);
            console.log(`Successfully deleted state file ${stateFilePath}`);
        } catch (unlinkError) {
            if ((unlinkError as NodeJS.ErrnoException).code === 'ENOENT') {
                console.log(`State file ${stateFilePath} was already deleted or never created.`);
            } else {
                console.error(`Failed to delete state file ${stateFilePath}:`, unlinkError);
            }
        }
    } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') {
            console.warn(`Source file ${sourceFilePath} not found for translation. Skipping Chapter ${chapterNumber}.`);
        } else {
            console.error(`Failed to read source file ${sourceFilePath} or write translated file:`, readError);
        }
    }
}

async function generateTranslatedLine(
    collectionName: string,
    sourceLanguage: string,
    targetLanguage: string,
    previousLines: { from: string, to: string }[], // last 5 lines
    currentLine: string,
    futureLines: string[]
): Promise<{ translatedLine: string; newKeywords: { from: string; to: string }[] }> {
    console.log(`Generating translation for line: "${currentLine}"`);

    const existingKeywords = await searchKeyword(collectionName, currentLine, 20);

    const prompt = `
You will be translating a novel line by line.

Translate the "Current Line" from ${sourceLanguage} to ${targetLanguage}.
Maintain consistency with the "Previous Lines" translations and consider the "Future Lines" for context.
Use the "Existing Keywords" for consistent translation of specific terms or names.
Dont forget existing keywords are not absolutely correct, just use them as a reference for consistency.
Identify any new recurring terms or names in the "Current Line" that should be translated consistently in the future and list them as "New Keywords".

Dont forget that you are translating a novel, in turkish when you are saying statements, you can make them in past-like tense.
For example, dont say 'Ancak, kalbi biraz rahatladı, en azından bir yol düşünmeye devam etmek için zamanı var.' instead say 'Ancak, kalbi biraz rahatladı, en azından bir yol düşünmeye devam etmek için zamanı vardı.'.
You don't have to do it in every sentence, if it is not necessary, just do it in some sentences.

You are a professional translator, so please make sure to use the correct grammar and punctuation in your translations.
Also be aware that you are translating a novel, so the style should be consistent of source language's novel style. Because source language might have original novel writing style.

If existing keywords, has enough keywords, you don't have to add new keywords. For example if Sorcerer is already in existing keywords, you dont have to add Sorcerer Book to new keyword, you can add book if it is has a keyword value, for this case you shouldn't add any keyword because book is a normal word not a keyword.

Source Language: ${sourceLanguage}
Target Language: ${targetLanguage}

Existing Keywords:
${existingKeywords.map(kw => `- ${kw.from}: ${kw.to}`).join('\n') || 'None'}

Previous Lines (Source -> Target):
${previousLines.map(line => `- ${line.from} -> ${line.to}`).join('\n') || 'None'}

Current Line (to be translated):
${currentLine}

Future Lines (for context):
${futureLines.map(line => `- ${line}`).join('\n') || 'None'}

Respond ONLY with a valid JSON object matching this schema:
{
  "type": "object",
  "properties": {
    "translatedLine": { "type": "string" },
    "newKeywords": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "from": { "type": "string" },
          "to": { "type": "string" }
        },
        "required": ["from", "to"]
      }
    }
  },
  "required": ["translatedLine", "newKeywords"]
}
If no new keywords are identified, provide an empty array for "newKeywords". Do not include any other text or explanations outside the JSON object.
`;

    const result = await genAI.models.generateContent({
        model: "models/gemini-2.5-flash-preview-04-17",
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    translatedLine: { type: Type.STRING },
                    newKeywords: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                from: { type: Type.STRING },
                                to: { type: Type.STRING }
                            },
                            required: ['from', 'to']
                        }
                    }
                },
                required: ['translatedLine', 'newKeywords']
            },
            thinkingConfig: {
                includeThoughts: true
            }
        }
    });

    if (!result || !result.text) {
        console.error("Received empty or null response from AI.");
        throw new Error("Received empty response from AI");
    }

    const responseText = result.text;

    try {
        const parsedResult = JSON.parse(responseText);
        if (
            typeof parsedResult === 'object' &&
            parsedResult !== null &&
            typeof parsedResult.translatedLine === 'string' &&
            Array.isArray(parsedResult.newKeywords) &&
            parsedResult.newKeywords.every((kw: any) =>
                typeof kw === 'object' && kw !== null && typeof kw.from === 'string' && typeof kw.to === 'string'
            )
        ) {
            return parsedResult;
        } else {
            console.error("Invalid JSON structure received:", parsedResult);
            throw new Error("Received invalid JSON structure from AI");
        }
    } catch (error) {
        console.error("Failed to parse JSON response:", responseText, error);
        throw new Error(`Failed to parse JSON response from AI. Response text: ${responseText}`);
    }
}

// --- Main Execution ---
async function main() {
    try {
        // Ensure the output directories exist first
        try {
            await fs.mkdir(CACHE_DIR, { recursive: true }); // Ensure base cache dir exists
            await fs.mkdir(PROCESSED_CHAPTERS_DIR, { recursive: true });
            await fs.mkdir(TRANSLATED_CHAPTERS_DIR, { recursive: true });
            await fs.mkdir(TRANSLATION_STATE_DIR, { recursive: true }); // Ensure state dir exists
            console.log(`Ensured output directories exist.`);
        } catch (error) {
            console.error(`Failed to create output directories:`, error);
            process.exit(1);
        }

        // Fetch and save all existing keywords initially
        console.log("Performing initial keyword backup...");
        await syncKeywordsFromJson(COLLECTION_NAME);
        await fetchAllKeywordsAndSave(COLLECTION_NAME);
        console.log("Initial keyword backup complete.");

        // Step 1: Cache Chapter URLs if not already cached
        await cacheChapterUrls();

        // Step 2: Read cache
        console.log("Reading chapter cache...");
        let chapters: { chapter: number; url: string }[] = [];
        try {
            const cacheData = await fs.readFile(CHAPTER_CACHE_FILE, 'utf8');
            chapters = JSON.parse(cacheData);
            console.log(`Found ${chapters.length} chapters in cache.`);
        } catch (error) {
            console.error(`Failed to read or parse chapter cache file: ${CHAPTER_CACHE_FILE}`, error);
            process.exit(1);
        }

        if (chapters.length === 0) {
            console.log("No chapters found in cache to process.");
            return;
        }

        // Step 3: Process and Translate each chapter sequentially
        console.log("Starting chapter processing and translation...");
        for (const chapter of chapters) {
            const sourceFilePath = path.join(PROCESSED_CHAPTERS_DIR, `chapter_${chapter.chapter}.txt`);

            await fetchAndProcessChapter(chapter, PROCESSED_CHAPTERS_DIR);

            try {
                await fs.access(sourceFilePath);
                await translateChapter(chapter.chapter, sourceFilePath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    console.warn(`Source file for chapter ${chapter.chapter} was not created or is inaccessible. Skipping translation.`);
                } else {
                    console.error(`Error accessing source file ${sourceFilePath} before translation:`, error);
                }
            }
        }

        console.log("Processing and translation finished.");
    } catch (error) {
        console.error('An error occurred during the main process:', error);
        process.exit(1);
    }
}

main();