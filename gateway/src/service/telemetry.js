import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const logTelemetry = async ({ query, cacheHit, similarityScore, alphaUsed, thresholdUsed, latencyMs }) => {
    await prisma.telemetryLog.create({
        data: { query, cacheHit, similarityScore, alphaUsed, thresholdUsed, latencyMs }
    });
};