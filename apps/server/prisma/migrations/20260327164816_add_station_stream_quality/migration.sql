-- Add stream quality to stations
ALTER TABLE "stations"
    ADD COLUMN "streamQuality" TEXT NOT NULL DEFAULT 'HIGH';
