-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_stations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "coverImage" TEXT,
    "ownerId" TEXT NOT NULL,
    "accessMode" TEXT NOT NULL DEFAULT 'CODE_ONLY',
    "passwordHash" TEXT,
    "isLive" BOOLEAN NOT NULL DEFAULT false,
    "currentTrackId" TEXT,
    "currentPosition" REAL NOT NULL DEFAULT 0,
    "trackStartedAt" DATETIME,
    "isPaused" BOOLEAN NOT NULL DEFAULT false,
    "pausedPosition" REAL NOT NULL DEFAULT 0,
    "activePlaylistId" TEXT,
    "systemQueueMode" TEXT NOT NULL DEFAULT 'SEQUENTIAL',
    "crossfadeDuration" INTEGER NOT NULL DEFAULT 0,
    "streamQuality" TEXT NOT NULL DEFAULT 'HIGH',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "stations_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_stations" ("accessMode", "activePlaylistId", "code", "coverImage", "createdAt", "crossfadeDuration", "currentPosition", "currentTrackId", "description", "id", "isLive", "isPaused", "name", "ownerId", "passwordHash", "pausedPosition", "systemQueueMode", "trackStartedAt", "updatedAt") SELECT "accessMode", "activePlaylistId", "code", "coverImage", "createdAt", "crossfadeDuration", "currentPosition", "currentTrackId", "description", "id", "isLive", "isPaused", "name", "ownerId", "passwordHash", "pausedPosition", "systemQueueMode", "trackStartedAt", "updatedAt" FROM "stations";
DROP TABLE "stations";
ALTER TABLE "new_stations" RENAME TO "stations";
CREATE UNIQUE INDEX "stations_code_key" ON "stations"("code");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
