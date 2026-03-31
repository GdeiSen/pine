-- AlterTable
ALTER TABLE "stations"
ADD COLUMN "previewVideoKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
