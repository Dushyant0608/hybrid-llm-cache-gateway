-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "cached_responses" (
    "id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "embedding" vector(384) NOT NULL,
    "response" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "lastHitAt" TIMESTAMP(3),

    CONSTRAINT "cached_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telemetry_logs" (
    "id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "cacheHit" BOOLEAN NOT NULL,
    "similarityScore" DOUBLE PRECISION,
    "alphaUsed" DOUBLE PRECISION NOT NULL,
    "thresholdUsed" DOUBLE PRECISION NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telemetry_logs_pkey" PRIMARY KEY ("id")
);
