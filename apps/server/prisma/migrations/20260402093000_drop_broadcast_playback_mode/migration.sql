-- Collapse station playback mode to DIRECT-only.
-- PostgreSQL enum values cannot be dropped directly in a portable way, so we recreate the enum type.
UPDATE "stations"
SET "playbackMode" = 'DIRECT'
WHERE "playbackMode"::text <> 'DIRECT';

ALTER TYPE "station_playback_mode" RENAME TO "station_playback_mode_old";

CREATE TYPE "station_playback_mode" AS ENUM ('DIRECT');

ALTER TABLE "stations"
ALTER COLUMN "playbackMode" TYPE "station_playback_mode"
USING ("playbackMode"::text::"station_playback_mode");

DROP TYPE "station_playback_mode_old";
