
import { GoogleGenAI } from "@google/genai"; // Corrected package name

// Access your API key as an environment variable (see "Set up your API key" above)
export const genAI = new GoogleGenAI({
    apiKey: process.env.GOOGLE_API_KEY || ""
});