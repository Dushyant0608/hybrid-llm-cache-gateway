import { get, set, getConfig } from '../service/redis.js';
import { checkExactMatch, storeExact } from './exactMatch.js';
import { searchSemantic, storeSemantic } from './semanticSearch.js';
import { hybridScore } from './hybridScorer.js';
import { logTelemetry } from '../service/telemetry.js';
import { getEmbedding } from './embedder.js';
import { callGemini } from './gemini.js';

export const cacheMiddleware = async (req, res, next) => {
    const { query } = req.body;
    if (!query) return next();

    const start = Date.now();
    const { alpha, threshold } = await getConfig();

    const exact = await checkExactMatch(query);
    if (exact) {
        await logTelemetry({ query, cacheHit: true, similarityScore: null, alphaUsed: alpha, thresholdUsed: threshold, latencyMs: Date.now() - start });
        return res.json({ response: exact, source: 'exact' });
    }

    const embedding = await getEmbedding(query);
    const candidate = await searchSemantic(embedding);

    if (candidate) {
        const score = await hybridScore(query, candidate, alpha);
        if (score >= threshold) {
            await logTelemetry({ query, cacheHit: true, similarityScore: score, alphaUsed: alpha, thresholdUsed: threshold, latencyMs: Date.now() - start });
            return res.json({ response: candidate.response, source: 'semantic' });
        }
    }

    const response = await callGemini(query);
    await storeExact(query, response);
    await storeSemantic(query, embedding, response);
    await logTelemetry({ query, cacheHit: false, similarityScore: candidate?.score ?? null, alphaUsed: alpha, thresholdUsed: threshold, latencyMs: Date.now() - start });

    return res.json({ response, source: 'llm' });
};