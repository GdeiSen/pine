-- CreateEnum
CREATE TYPE "station_access_mode" AS ENUM ('PUBLIC', 'PRIVATE');

CREATE TYPE "member_role" AS ENUM ('GUEST', 'LISTENER', 'DJ', 'MODERATOR', 'ADMIN', 'OWNER');

CREATE TYPE "queue_type" AS ENUM ('USER', 'SYSTEM');

CREATE TYPE "queue_item_status" AS ENUM ('PENDING', 'PLAYING', 'PLAYED', 'SKIPPED');

CREATE TYPE "track_quality" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'LOSSLESS');

CREATE TYPE "stream_quality" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

CREATE TYPE "track_status" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'ERROR');

CREATE TYPE "chat_message_type" AS ENUM ('TEXT', 'SYSTEM', 'TRACK_ADDED', 'USER_JOINED', 'USER_LEFT');

CREATE TYPE "system_queue_mode" AS ENUM ('SEQUENTIAL', 'SHUFFLE', 'SMART_SHUFFLE');

CREATE TYPE "playback_loop_mode" AS ENUM ('NONE', 'TRACK', 'QUEUE');

CREATE TYPE "playback_command_type" AS ENUM ('PLAY', 'PAUSE', 'SEEK', 'SKIP', 'SET_LOOP', 'SET_SHUFFLE', 'QUEUE_ADD', 'QUEUE_REMOVE', 'QUEUE_REORDER');

CREATE TYPE "playback_command_status" AS ENUM ('PENDING', 'PROCESSING', 'ACKED', 'REJECTED', 'EXPIRED');

CREATE TYPE "playback_event_type" AS ENUM ('STATE_SNAPSHOT', 'STATE_CHANGED', 'TRACK_CHANGED', 'COMMAND_RECEIVED', 'COMMAND_APPLIED', 'COMMAND_REJECTED', 'QUEUE_UPDATED', 'SYNC_TICK', 'DRIFT_CORRECTED', 'HEARTBEAT');

CREATE TYPE "track_asset_kind" AS ENUM ('ORIGINAL', 'TRANSCODE_LOW', 'TRANSCODE_MEDIUM', 'TRANSCODE_HIGH', 'COVER_WEBP', 'WAVEFORM_JSON');

-- Alter existing station and track columns to enums
ALTER TABLE "stations"
    ALTER COLUMN "accessMode" DROP DEFAULT,
    ALTER COLUMN "systemQueueMode" DROP DEFAULT,
    ALTER COLUMN "streamQuality" DROP DEFAULT;

ALTER TABLE "stations"
    ALTER COLUMN "accessMode" TYPE "station_access_mode" USING (
        CASE UPPER("accessMode")
            WHEN 'PUBLIC' THEN 'PUBLIC'::"station_access_mode"
            ELSE 'PRIVATE'::"station_access_mode"
        END
    ),
    ALTER COLUMN "systemQueueMode" TYPE "system_queue_mode" USING (
        CASE UPPER("systemQueueMode")
            WHEN 'SHUFFLE' THEN 'SHUFFLE'::"system_queue_mode"
            WHEN 'SMART_SHUFFLE' THEN 'SMART_SHUFFLE'::"system_queue_mode"
            ELSE 'SEQUENTIAL'::"system_queue_mode"
        END
    ),
    ALTER COLUMN "streamQuality" TYPE "stream_quality" USING (
        CASE UPPER(COALESCE("streamQuality", 'HIGH'))
            WHEN 'LOW' THEN 'LOW'::"stream_quality"
            WHEN 'MEDIUM' THEN 'MEDIUM'::"stream_quality"
            ELSE 'HIGH'::"stream_quality"
        END
    );

ALTER TABLE "stations"
    ALTER COLUMN "accessMode" SET DEFAULT 'PRIVATE',
    ALTER COLUMN "systemQueueMode" SET DEFAULT 'SEQUENTIAL',
    ALTER COLUMN "streamQuality" SET DEFAULT 'HIGH';

ALTER TABLE "tracks"
    ALTER COLUMN "quality" DROP DEFAULT,
    ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "tracks"
    ALTER COLUMN "quality" TYPE "track_quality" USING (
        CASE UPPER(COALESCE("quality", 'MEDIUM'))
            WHEN 'LOW' THEN 'LOW'::"track_quality"
            WHEN 'HIGH' THEN 'HIGH'::"track_quality"
            WHEN 'LOSSLESS' THEN 'LOSSLESS'::"track_quality"
            ELSE 'MEDIUM'::"track_quality"
        END
    ),
    ALTER COLUMN "status" TYPE "track_status" USING (
        CASE UPPER(COALESCE("status", 'PROCESSING'))
            WHEN 'UPLOADING' THEN 'UPLOADING'::"track_status"
            WHEN 'READY' THEN 'READY'::"track_status"
            WHEN 'ERROR' THEN 'ERROR'::"track_status"
            ELSE 'PROCESSING'::"track_status"
        END
    );

ALTER TABLE "tracks"
    ALTER COLUMN "quality" SET DEFAULT 'MEDIUM',
    ALTER COLUMN "status" SET DEFAULT 'PROCESSING';

ALTER TABLE "queue_items"
    ALTER COLUMN "queueType" DROP DEFAULT,
    ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "queue_items"
    ALTER COLUMN "queueType" TYPE "queue_type" USING (
        CASE UPPER(COALESCE("queueType", 'USER'))
            WHEN 'SYSTEM' THEN 'SYSTEM'::"queue_type"
            ELSE 'USER'::"queue_type"
        END
    ),
    ALTER COLUMN "status" TYPE "queue_item_status" USING (
        CASE UPPER(COALESCE("status", 'PENDING'))
            WHEN 'PLAYING' THEN 'PLAYING'::"queue_item_status"
            WHEN 'PLAYED' THEN 'PLAYED'::"queue_item_status"
            WHEN 'SKIPPED' THEN 'SKIPPED'::"queue_item_status"
            ELSE 'PENDING'::"queue_item_status"
        END
    );

ALTER TABLE "queue_items"
    ALTER COLUMN "queueType" SET DEFAULT 'USER',
    ALTER COLUMN "status" SET DEFAULT 'PENDING';

ALTER TABLE "station_members"
    ALTER COLUMN "role" DROP DEFAULT;

ALTER TABLE "station_members"
    ALTER COLUMN "role" TYPE "member_role" USING (
        CASE UPPER(COALESCE("role", 'GUEST'))
            WHEN 'LISTENER' THEN 'LISTENER'::"member_role"
            WHEN 'DJ' THEN 'DJ'::"member_role"
            WHEN 'MODERATOR' THEN 'MODERATOR'::"member_role"
            WHEN 'ADMIN' THEN 'ADMIN'::"member_role"
            WHEN 'OWNER' THEN 'OWNER'::"member_role"
            ELSE 'GUEST'::"member_role"
        END
    );

ALTER TABLE "station_members"
    ALTER COLUMN "role" SET DEFAULT 'GUEST';

ALTER TABLE "chat_messages"
    ALTER COLUMN "type" DROP DEFAULT;

ALTER TABLE "chat_messages"
    ALTER COLUMN "type" TYPE "chat_message_type" USING (
        CASE UPPER(COALESCE("type", 'TEXT'))
            WHEN 'SYSTEM' THEN 'SYSTEM'::"chat_message_type"
            WHEN 'TRACK_ADDED' THEN 'TRACK_ADDED'::"chat_message_type"
            WHEN 'USER_JOINED' THEN 'USER_JOINED'::"chat_message_type"
            WHEN 'USER_LEFT' THEN 'USER_LEFT'::"chat_message_type"
            ELSE 'TEXT'::"chat_message_type"
        END
    );

ALTER TABLE "chat_messages"
    ALTER COLUMN "type" SET DEFAULT 'TEXT';

-- Add missing / stronger foreign keys
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stations_currentTrackId_fkey') THEN
        ALTER TABLE "stations"
            ADD CONSTRAINT "stations_currentTrackId_fkey" FOREIGN KEY ("currentTrackId") REFERENCES "tracks" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stations_activePlaylistId_fkey') THEN
        ALTER TABLE "stations"
            ADD CONSTRAINT "stations_activePlaylistId_fkey" FOREIGN KEY ("activePlaylistId") REFERENCES "playlists" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tracks_stationId_fkey') THEN
        ALTER TABLE "tracks"
            ADD CONSTRAINT "tracks_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'playlist_tracks_addedById_fkey') THEN
        ALTER TABLE "playlist_tracks"
            ADD CONSTRAINT "playlist_tracks_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'station_invites_createdById_fkey') THEN
        ALTER TABLE "station_invites"
            ADD CONSTRAINT "station_invites_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_logs_userId_fkey') THEN
        ALTER TABLE "activity_logs"
            ADD CONSTRAINT "activity_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- Add useful indexes for station, queue, and history lookups
CREATE INDEX "stations_ownerId_idx" ON "stations" ("ownerId");
CREATE INDEX "stations_accessMode_isLive_idx" ON "stations" ("accessMode", "isLive");
CREATE INDEX "stations_currentTrackId_idx" ON "stations" ("currentTrackId");
CREATE INDEX "stations_activePlaylistId_idx" ON "stations" ("activePlaylistId");

CREATE INDEX "playlists_stationId_sortOrder_idx" ON "playlists" ("stationId", "sortOrder");
CREATE INDEX "tracks_stationId_createdAt_idx" ON "tracks" ("stationId", "createdAt");
CREATE INDEX "tracks_uploadedById_createdAt_idx" ON "tracks" ("uploadedById", "createdAt");
CREATE INDEX "tracks_stationId_status_idx" ON "tracks" ("stationId", "status");

CREATE INDEX "playlist_tracks_playlistId_sortOrder_idx" ON "playlist_tracks" ("playlistId", "sortOrder");
CREATE INDEX "playlist_tracks_trackId_idx" ON "playlist_tracks" ("trackId");
CREATE INDEX "playlist_tracks_addedById_idx" ON "playlist_tracks" ("addedById");

CREATE INDEX "queue_items_stationId_queueType_status_position_idx" ON "queue_items" ("stationId", "queueType", "status", "position");
CREATE INDEX "queue_items_stationId_status_playedAt_idx" ON "queue_items" ("stationId", "status", "playedAt");
CREATE INDEX "queue_items_trackId_idx" ON "queue_items" ("trackId");
CREATE INDEX "queue_items_addedById_idx" ON "queue_items" ("addedById");
CREATE UNIQUE INDEX "queue_items_stationId_queueType_pending_position_key"
    ON "queue_items" ("stationId", "queueType", "position")
    WHERE "status" = 'PENDING';

CREATE INDEX "station_members_userId_idx" ON "station_members" ("userId");
CREATE INDEX "chat_messages_stationId_createdAt_idx" ON "chat_messages" ("stationId", "createdAt");
CREATE INDEX "station_invites_stationId_createdAt_idx" ON "station_invites" ("stationId", "createdAt");
CREATE INDEX "station_invites_createdById_idx" ON "station_invites" ("createdById");
CREATE INDEX "listen_sessions_stationId_connectedAt_idx" ON "listen_sessions" ("stationId", "connectedAt");
CREATE INDEX "listen_sessions_userId_connectedAt_idx" ON "listen_sessions" ("userId", "connectedAt");
CREATE INDEX "activity_logs_stationId_createdAt_idx" ON "activity_logs" ("stationId", "createdAt");
CREATE INDEX "activity_logs_userId_createdAt_idx" ON "activity_logs" ("userId", "createdAt");

-- New storage, playback state, command, and event tables
CREATE TABLE "track_assets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "trackId" TEXT NOT NULL,
    "kind" "track_asset_kind" NOT NULL,
    "objectKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "codec" TEXT,
    "bitrate" INTEGER,
    "sampleRate" INTEGER,
    "channels" INTEGER,
    "duration" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "track_assets_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "tracks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "playback_states" (
    "stationId" TEXT NOT NULL PRIMARY KEY,
    "currentTrackId" TEXT,
    "currentQueueItemId" TEXT,
    "currentQueueType" "queue_type",
    "currentPosition" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currentTrackDuration" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "trackStartedAt" TIMESTAMP(3),
    "isPaused" BOOLEAN NOT NULL DEFAULT true,
    "pausedPosition" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "loopMode" "playback_loop_mode" NOT NULL DEFAULT 'NONE',
    "shuffleEnabled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "playback_states_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "playback_commands" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stationId" TEXT NOT NULL,
    "type" "playback_command_type" NOT NULL,
    "payload" JSONB,
    "status" "playback_command_status" NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT,
    "correlationId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "playback_commands_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "playback_commands_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "playback_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stationId" TEXT NOT NULL,
    "type" "playback_event_type" NOT NULL,
    "payload" JSONB,
    "commandId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "playback_events_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "playback_events_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "playback_commands" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "track_assets_objectKey_key" ON "track_assets" ("objectKey");
CREATE UNIQUE INDEX "track_assets_trackId_kind_key" ON "track_assets" ("trackId", "kind");
CREATE INDEX "track_assets_trackId_idx" ON "track_assets" ("trackId");

CREATE INDEX "playback_commands_stationId_status_createdAt_idx" ON "playback_commands" ("stationId", "status", "createdAt");
CREATE INDEX "playback_commands_createdById_createdAt_idx" ON "playback_commands" ("createdById", "createdAt");
CREATE INDEX "playback_commands_correlationId_idx" ON "playback_commands" ("correlationId");

CREATE INDEX "playback_events_stationId_createdAt_idx" ON "playback_events" ("stationId", "createdAt");
CREATE INDEX "playback_events_commandId_idx" ON "playback_events" ("commandId");
