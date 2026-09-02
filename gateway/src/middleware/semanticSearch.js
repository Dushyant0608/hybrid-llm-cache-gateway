import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const semanticSearch = async (embedding) => {
    const vec = `[${embedding.join(',')}]`;

    const rows = await prisma.$queryRaw`
        SELECT query , response , 1 - (embedding <=> ${vec}::vector)  AS score 
        FROM cached_responses
        ORDER BY embedding <=> ${vec}::vector
        LIMIT 1
    `;

    if (!rows.length) return null;

    const row = rows[0];
    return {
        query: row.query,
        response: row.response,
        score: parseFloat(row.score),
    };
};

export const storeSemantic = async (query, embedding, response) => {
    const vec = `[${embedding.join(',')}]`;

    await prisma.$executeRaw`
        INSERT INTO cached_responses (id, query, embedding, response, "createdAt")
        VALUES (gen_random_uuid(), ${query}, ${vec}::vector, ${response}, now())
    `;

};