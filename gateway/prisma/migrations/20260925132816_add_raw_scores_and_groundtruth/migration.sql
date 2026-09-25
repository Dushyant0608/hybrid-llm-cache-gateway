-- AlterTable
ALTER TABLE "telemetry_logs" ADD COLUMN     "lexicalScore" DOUBLE PRECISION,
ADD COLUMN     "semanticScore" DOUBLE PRECISION,
ADD COLUMN     "shouldHit" BOOLEAN;
