-- CreateEnum
CREATE TYPE "station_playback_mode" AS ENUM ('DIRECT');

-- AlterTable
ALTER TABLE "stations" ADD COLUMN "playbackMode" "station_playback_mode" NOT NULL DEFAULT 'DIRECT';
