import { prisma } from '../service/prisma.js';

export const logTelemetry = async (data) => {
    await prisma.telemetryLog.create({ data });
};
