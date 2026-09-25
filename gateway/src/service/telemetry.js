import { prisma } from '../services/prisma.js';

export const logTelemetry = async ({ query, cacheHit, semanticScore, lexicalScore, similarityScore, shouldHit, alphaUsed, thresholdUsed, latencyMs }) => {
    await prisma.telemetryLog.create({
        data: { query, cacheHit, semanticScore, lexicalScore, similarityScore, shouldHit, alphaUsed, thresholdUsed, latencyMs }
    });
};