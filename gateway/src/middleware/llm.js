import Groq from 'groq-sdk';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const sys = { role: 'system', content: 'Answer in plain text only. Never call tools or functions.' };

export const callLLM = async (query) => {
    for (let i = 0; i < 3; i++) {
        try {
            const r = await groq.chat.completions.create({
                model: 'openai/gpt-oss-20b',
                messages: [sys, { role: 'user', content: query }]
            });
            return r.choices[0].message.content;
        } catch (e) {
            if (i === 2) throw e;
        }
    }
};