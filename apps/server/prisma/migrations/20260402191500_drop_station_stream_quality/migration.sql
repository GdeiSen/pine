-- Remove legacy station-level stream quality controls.
ALTER TABLE "stations"
DROP COLUMN IF EXISTS "streamQuality";

DROP TYPE IF EXISTS "stream_quality";
