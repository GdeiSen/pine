-- Remove legacy per-track transcode path columns.
-- Track variants are now represented only via track_assets.
ALTER TABLE "tracks"
DROP COLUMN IF EXISTS "highPath",
DROP COLUMN IF EXISTS "mediumPath",
DROP COLUMN IF EXISTS "lowPath";
