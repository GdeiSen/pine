-- Set default crossfade duration to 3 seconds and station access mode to PRIVATE
ALTER TABLE "stations"
    ALTER COLUMN "accessMode" SET DEFAULT 'PRIVATE';

ALTER TABLE "stations"
    ALTER COLUMN "crossfadeDuration" SET DEFAULT 3;

UPDATE "stations"
SET "crossfadeDuration" = 3
WHERE "crossfadeDuration" = 0;
