import { prisma } from '../service/prisma.js';

export const logTelemetry = async ({ query, cacheHit, similarityScore, alphaUsed, thresholdUsed, latencyMs }) => {
    await prisma.telemetryLog.create({
        data: { query, cacheHit, similarityScore, alphaUsed, thresholdUsed, latencyMs }
    });
};