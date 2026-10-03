import Groq from 'groq-sdk';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export const callGemini = async (query) => {
    const result = await groq.chat.completions.create({
        model: 'openai/gpt-oss-20b',
        messages: [{ role: 'user', content: query }]
    });
    return result.choices[0].message.content;
};