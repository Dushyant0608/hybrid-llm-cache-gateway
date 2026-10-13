/*
  Warnings:

  - You are about to drop the column `alphaUsed` on the `telemetry_logs` table. All the data in the column will be lost.
  - You are about to drop the column `lexicalScore` on the `telemetry_logs` table. All the data in the column will be lost.
  - You are about to drop the column `similarityScore` on the `telemetry_logs` table. All the data in the column will be lost.
  - You are about to drop the column `thresholdUsed` on the `telemetry_logs` table. All the data in the column will be lost.
  - Added the required column `decisionPath` to the `telemetry_logs` table without a default value. This is not possible if the table is not empty.
  - Added the required column `lowCutoffUsed` to the `telemetry_logs` table without a default value. This is not possible if the table is not empty.
  - Added the required column `nliThresholdUsed` to the `telemetry_logs` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "telemetry_logs" DROP COLUMN "alphaUsed",
DROP COLUMN "lexicalScore",
DROP COLUMN "similarityScore",
DROP COLUMN "thresholdUsed",
ADD COLUMN     "decisionPath" TEXT NOT NULL,
ADD COLUMN     "lowCutoffUsed" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "nliContradictionScore" DOUBLE PRECISION,
ADD COLUMN     "nliEntailmentScore" DOUBLE PRECISION,
ADD COLUMN     "nliThresholdUsed" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "verifierLatencyMs" INTEGER;
