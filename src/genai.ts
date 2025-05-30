import { GoogleGenAI } from "@google/genai";

// Parse API keys from environment variable (comma-separated)
export const apiKeys = (process.env.GOOGLE_API_KEYS || "").split(",").filter(key => key.trim().length > 0);

if (apiKeys.length === 0) {
  console.warn("No API keys provided in GOOGLE_API_KEYS environment variable. Falling back to GOOGLE_API_KEY.");
  
  // Fallback to the single API key if available
  if (process.env.GOOGLE_API_KEY) {
    apiKeys.push(process.env.GOOGLE_API_KEY);
  } else {
    throw new Error("No API keys available. Set either GOOGLE_API_KEYS or GOOGLE_API_KEY in your environment.");
  }
}

// Create client instances for each key
export const clients = apiKeys.map(apiKey => new GoogleGenAI({ apiKey }));

// Track which client to use next for each operation type
const clientIndices: Record<string, number> = {
  "translation": 0,
  "embedding": 0
};

/**
 * Gets the next client for a specific operation type with round-robin rotation
 * @param operationType - The type of operation, e.g., "translation" or "embedding"
 * @returns A GoogleGenAI client instance
 */
export function getNextClient(operationType: string = "default"): GoogleGenAI {
  // Initialize the index if it doesn't exist
  if (!(operationType in clientIndices)) {
    clientIndices[operationType] = 0;
  }
  
  const index = clientIndices[operationType];
  
  // Update the index for next time (rotate)
  clientIndices[operationType] = (index + 1) % clients.length;
  
  console.log(`Using API key ${index + 1}/${clients.length} for ${operationType} operation`);
  return clients[index];
}

// Keep the original genAI export for backward compatibility
export const genAI = clients[0];