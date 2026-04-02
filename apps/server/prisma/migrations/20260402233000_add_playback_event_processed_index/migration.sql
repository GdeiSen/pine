-- Speeds up playback outbox scans for unprocessed events.
CREATE INDEX IF NOT EXISTS "playback_events_processedAt_createdAt_idx"
ON "playback_events" ("processedAt", "createdAt");
