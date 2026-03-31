"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { RulerProgressBar } from "@/components/station/ruler-progress";
import {
  SkipBack,
  SkipForward,
  Play,
  Pause,
  Shuffle,
  Repeat,
  Repeat1,
  Music2,
  RotateCw,
  Loader2,
} from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";
const AUDIO_DEBUG_ENABLED =
  process.env.NEXT_PUBLIC_AUDIO_DEBUG === "1" ||
  process.env.NEXT_PUBLIC_AUDIO_DEBUG === "true";
const LOADING_OVERLAY_DELAY_MS = 280;
const LOADING_OVERLAY_MIN_VISIBLE_MS = 380;
const LONG_LOADING_NOTICE_MS = 3200;
const SOFT_LAYOUT_TRANSITION = {
  type: "spring" as const,
  stiffness: 125,
  damping: 24,
  mass: 0.95,
};
const SOFT_FADE_TRANSITION = {
  duration: 0.36,
  ease: [0.19, 1, 0.22, 1] as const,
};
const SOFT_FADE_FAST_TRANSITION = {
  duration: 0.28,
  ease: [0.19, 1, 0.22, 1] as const,
};

type LoopMode = "none" | "track" | "queue";

interface TrackInfoProps {
  track: {
    id: string;
    title: string | null;
    artist: string | null;
    album: string | null;
    year: number | null;
    genre: string | null;
    duration: number;
    hasCover: boolean;
    quality: string;
    filename?: string | null;
    bitrate?: number | null;
  } | null;
  currentPosition: number;
  displayDuration?: number;
  nextTrackHint?: string | null;
  isPaused: boolean;
  isPlaying: boolean;
  listenerCount: number;
  stationName: string;
  stationCode: string;
  canControl: boolean;
  audioNeedsRestart: boolean;
  audioConnectionState:
    | "idle"
    | "connecting"
    | "buffering"
    | "reconnecting"
    | "playing"
    | "paused"
    | "blocked";
  audioConnectionMessage: string | null;
  audioDiagnostics: {
    driftMs: number | null;
    targetPosition: number | null;
    actualPosition: number | null;
    syncType: string | null;
    rttMs: number | null;
    updatedAt: number;
  } | null;
  loopMode: LoopMode;
  shuffleEnabled: boolean;
  onPlayPause: () => void;
  onRestartAudio: () => void;
  onSkip: () => void;
  onPrev: () => void;
  onSeek: (position: number) => void;
  progressInteractive?: boolean;
  transportControlsEnabled?: boolean;
  onToggleLoop: () => void;
  onToggleShuffle: () => void;
}

export function TrackInfo({
  track,
  currentPosition,
  displayDuration,
  nextTrackHint = null,
  isPlaying,
  isPaused,
  listenerCount,
  stationName,
  stationCode,
  canControl,
  audioNeedsRestart,
  audioConnectionState,
  audioConnectionMessage,
  audioDiagnostics,
  loopMode,
  shuffleEnabled,
  onPlayPause,
  onRestartAudio,
  onSkip,
  onPrev,
  onSeek,
  progressInteractive = true,
  transportControlsEnabled = true,
  onToggleLoop,
  onToggleShuffle,
}: TrackInfoProps) {
  const coverUrl = track?.hasCover
    ? `${API_URL}/tracks/${track.id}/cover`
    : null;
  const [resolvedCoverUrl, setResolvedCoverUrl] = useState<string | null>(null);
  const [showLoadingOverlay, setShowLoadingOverlay] = useState(false);
  const [showSlowLoadingNotice, setShowSlowLoadingNotice] = useState(false);
  const loadingVisibleSinceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!coverUrl) {
      setResolvedCoverUrl(null);
      return;
    }

    const controller = new AbortController();
    let objectUrl: string | null = null;

    const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    fetch(coverUrl, {
      method: "GET",
      credentials: "include",
      headers,
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error(`cover ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setResolvedCoverUrl(objectUrl);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setResolvedCoverUrl(coverUrl);
      });

    return () => {
      controller.abort();
      if (objectUrl) {
        const staleObjectUrl = objectUrl;
        window.setTimeout(() => URL.revokeObjectURL(staleObjectUrl), 1500);
      }
    };
  }, [coverUrl, track?.id]);

  const isActive = isPlaying && !isPaused;
  const timelineDuration =
    typeof displayDuration === "number" &&
    Number.isFinite(displayDuration) &&
    displayDuration > 0
      ? displayDuration
      : (track?.duration ?? 0);
  const LoopIcon = loopMode === "track" ? Repeat1 : Repeat;
  const showTransportBanner =
    audioConnectionState !== "playing" &&
    audioConnectionState !== "paused" &&
    audioConnectionState !== "idle";
  const isLoadingState =
    audioConnectionState === "connecting" ||
    audioConnectionState === "buffering" ||
    audioConnectionState === "reconnecting";
  const slowLoadingDescription = (() => {
    if (audioConnectionState === "connecting") {
      return "Connecting to the source and requesting a fresh audio stream.";
    }
    if (audioConnectionState === "buffering") {
      return "Buffering audio to keep playback smooth.";
    }
    if (audioConnectionState === "reconnecting") {
      return "Restoring the stream connection.";
    }
    return "Checking player state and preparing playback.";
  })();
  const trackExtension = (() => {
    const name = track?.filename?.trim();
    if (!name) return null;
    const dotIndex = name.lastIndexOf(".");
    if (dotIndex < 0 || dotIndex === name.length - 1) return null;
    return name.slice(dotIndex + 1).toUpperCase();
  })();
  const trackBitrateLabel =
    typeof track?.bitrate === "number" && Number.isFinite(track.bitrate)
      ? `${Math.max(1, Math.round(track.bitrate))} kbps`
      : null;
  const leftMeta = [trackExtension, trackBitrateLabel]
    .filter(Boolean)
    .join(" · ");
  const albumYearLabel = [track?.album, track?.year].filter(Boolean).join(" · ");
  const genreLabel = track?.genre?.trim() ?? "";
  const hasAlbumYear = albumYearLabel.length > 0;
  const hasGenre = genreLabel.length > 0;

  useEffect(() => {
    let showTimer: number | null = null;
    let hideTimer: number | null = null;
    const shouldShowLoading = showTransportBanner && isLoadingState;

    if (shouldShowLoading) {
      if (!showLoadingOverlay) {
        showTimer = window.setTimeout(() => {
          loadingVisibleSinceRef.current = Date.now();
          setShowLoadingOverlay(true);
        }, LOADING_OVERLAY_DELAY_MS);
      }
    } else if (showLoadingOverlay) {
      const visibleSince = loadingVisibleSinceRef.current ?? Date.now();
      const elapsedMs = Date.now() - visibleSince;
      const remainingMs = Math.max(0, LOADING_OVERLAY_MIN_VISIBLE_MS - elapsedMs);

      hideTimer = window.setTimeout(() => {
        loadingVisibleSinceRef.current = null;
        setShowLoadingOverlay(false);
      }, remainingMs);
    } else {
      loadingVisibleSinceRef.current = null;
    }

    return () => {
      if (showTimer !== null) window.clearTimeout(showTimer);
      if (hideTimer !== null) window.clearTimeout(hideTimer);
    };
  }, [isLoadingState, showLoadingOverlay, showTransportBanner]);

  useEffect(() => {
    if (!showLoadingOverlay || !showTransportBanner || !isLoadingState) {
      setShowSlowLoadingNotice(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setShowSlowLoadingNotice(true);
    }, LONG_LOADING_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [isLoadingState, showLoadingOverlay, showTransportBanner, track?.id]);

  return (
    <motion.div
      layout
      transition={{ layout: SOFT_LAYOUT_TRANSITION }}
      className="p-6 flex flex-col gap-5"
    >
      {/* Station meta row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{
              backgroundColor: isActive ? "#22c55e" : "var(--text-muted)",
              boxShadow: isActive ? "0 0 5px #22c55e80" : "none",
            }}
          />
          <span className="text-xs font-semibold text-[--text-secondary] uppercase tracking-widest">
            {stationName}
          </span>
          <span className="text-xs text-[--text-muted] font-mono bg-[--bg-inset] px-1.5 py-0.5 rounded-md">
            #{stationCode}
          </span>
        </div>
        <span className="text-xs text-[--text-muted]">
          {listenerCount} listening
        </span>
      </div>

      {/* Cover + track info */}
      <AnimatePresence mode="wait">
        <motion.div
          key={track?.id ?? "empty"}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={SOFT_FADE_TRANSITION}
          className="flex gap-8 items-center mb-2 min-h-[120px]"
        >
          {/* Cover */}
          <div
            className={`w-[72px] h-[72px] rounded-2xl overflow-hidden flex-shrink-0 ${
              coverUrl ? "bg-[--bg-subtle]" : "bg-gray-500/20"
            }`}
          >
            {coverUrl ? (
              <img
                src={resolvedCoverUrl ?? coverUrl}
                alt=""
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <Music2 size={24} className="text-[--text-muted]" />
              </div>
            )}
          </div>

          {/* Text */}
          <div className="flex-1 min-w-0 min-h-[108px] flex flex-col justify-center">
            <p
              className="text-2xl font-bold text-[--text-primary] truncate leading-tight"
              style={{ letterSpacing: "-0.5px" }}
            >
              {track?.title ?? "Nothing playing"}
            </p>
            <p className="text-sm text-[--text-secondary] mt-0.5 truncate">
              {track?.artist ?? "—"}
            </p>
            <p
              className={`text-xs text-[--text-muted] mt-0.5 truncate transition-opacity duration-200 ${
                hasAlbumYear ? "opacity-100" : "opacity-0"
              }`}
            >
              {hasAlbumYear ? albumYearLabel : "\u00A0"}
            </p>
            <p
              className={`text-xs text-[--text-muted] mt-1 truncate transition-opacity duration-200 ${
                hasGenre ? "opacity-100" : "opacity-0"
              }`}
            >
              {hasGenre ? genreLabel : "\u00A0"}
            </p>
          </div>
        </motion.div>
      </AnimatePresence>

      <AnimatePresence mode="wait" initial={false}>
        {showLoadingOverlay || audioNeedsRestart ? (
          <motion.div
            key="transport-status"
            className="py-3 flex flex-col items-center justify-center gap-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={SOFT_FADE_FAST_TRANSITION}
          >
            {showLoadingOverlay && (
              <motion.div
                layout
                transition={{ layout: SOFT_LAYOUT_TRANSITION }}
                className="w-full max-w-[640px] min-h-[68px] flex flex-col items-center justify-center gap-3"
              >
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={SOFT_FADE_FAST_TRANSITION}
                >
                  <Loader2 size={18} className="text-[--text-muted] animate-spin" />
                </motion.div>

                <AnimatePresence mode="popLayout">
                  {showSlowLoadingNotice && (
                    <motion.div
                      layout
                      key="slow-loading-note"
                      className="text-center max-w-[540px] px-2"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={SOFT_FADE_FAST_TRANSITION}
                    >
                      <p className="text-xs font-medium text-[--text-primary]">
                        Loading is taking longer than expected
                      </p>
                      <p className="text-[11px] text-[--text-muted] mt-1">
                        {slowLoadingDescription}
                      </p>
                      {audioConnectionMessage &&
                      audioConnectionMessage !== slowLoadingDescription ? (
                        <p className="text-[11px] text-[--text-muted] mt-1">
                          {audioConnectionMessage}
                        </p>
                      ) : null}
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}
            {AUDIO_DEBUG_ENABLED && audioDiagnostics && (
              <p className="text-[10px] font-mono text-[--text-muted] text-center">
                drift {audioDiagnostics.driftMs ?? "n/a"}ms
                {" · "}
                target {audioDiagnostics.targetPosition?.toFixed(2) ?? "n/a"}
                {" · "}
                actual {audioDiagnostics.actualPosition?.toFixed(2) ?? "n/a"}
                {" · "}
                sync {audioDiagnostics.syncType ?? "n/a"}
              </p>
            )}
            {audioNeedsRestart && (
              <>
                <button
                  type="button"
                  onClick={onRestartAudio}
                  className="w-14 h-14 rounded-full flex items-center justify-center text-white"
                  style={{ background: "#E8440F" }}
                >
                  <RotateCw size={20} />
                </button>
                <p className="text-xs text-[--text-muted] text-center">
                  Audio playback was blocked by the browser. Tap the button to
                  restart playback.
                </p>
              </>
            )}
          </motion.div>
        ) : (
          <motion.div
            key="transport-controls"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={SOFT_FADE_FAST_TRANSITION}
          >
            {/* Ruler progress bar */}
            <RulerProgressBar
              currentPosition={currentPosition}
              isPaused={isPaused}
              duration={timelineDuration}
              nextTrackHint={nextTrackHint}
              leftMeta={leftMeta || null}
              onSeek={onSeek}
              interactive={progressInteractive}
            />

            {/* Controls */}
            {canControl && (
              <div className="w-full max-w-[640px] mx-auto mt-4">
                <div className="flex items-center justify-between">
                  {/* Shuffle */}
                  <motion.button
                    onClick={onToggleShuffle}
                    className="flex items-center justify-center w-9 h-9 rounded-xl transition-colors"
                    style={{
                      color: shuffleEnabled
                        ? "var(--color-accent)"
                        : "var(--text-muted)",
                    }}
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                  >
                    <Shuffle size={16} />
                    {shuffleEnabled && (
                      <motion.div
                        className="absolute w-1 h-1 rounded-full mt-5"
                        style={{ background: "var(--color-accent)" }}
                        layoutId="shuffle-dot"
                      />
                    )}
                  </motion.button>

                  {/* Prev */}
                  <motion.button
                    onClick={onPrev}
                    disabled={!transportControlsEnabled}
                    className="flex items-center justify-center w-10 h-10 rounded-xl transition-colors disabled:cursor-not-allowed"
                    style={{
                      color: transportControlsEnabled
                        ? "var(--text-primary)"
                        : "var(--text-muted)",
                      opacity: transportControlsEnabled ? 1 : 0.45,
                    }}
                    whileHover={transportControlsEnabled ? { scale: 1.08 } : undefined}
                    whileTap={transportControlsEnabled ? { scale: 0.92 } : undefined}
                  >
                    <SkipBack size={20} fill="currentColor" />
                  </motion.button>

                  {/* Play / Pause — main button */}
                  <motion.button
                    onClick={onPlayPause}
                    className="flex items-center justify-center w-14 h-14 rounded-full text-white"
                    style={{
                      background: "var(--color-accent)",
                      boxShadow: isActive
                        ? "0 6px 24px rgba(0,0,0,0.22)"
                        : "0 2px 12px rgba(0,0,0,0.12)",
                    }}
                    whileHover={{ scale: 1.06 }}
                    whileTap={{ scale: 0.93 }}
                    transition={{ type: "spring", stiffness: 400, damping: 20 }}
                  >
                    <AnimatePresence mode="wait">
                      {isActive ? (
                        <motion.div
                          key="pause"
                          initial={{ scale: 0.5, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0.5, opacity: 0 }}
                          transition={{ duration: 0.1 }}
                          style={{ color: "var(--bg)" }}
                        >
                          <Pause size={22} fill="currentColor" />
                        </motion.div>
                      ) : (
                        <motion.div
                          key="play"
                          initial={{ scale: 0.5, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0.5, opacity: 0 }}
                          transition={{ duration: 0.1 }}
                          style={{ color: "var(--bg)" }}
                        >
                          <Play size={22} fill="currentColor" />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.button>

                  {/* Next */}
                  <motion.button
                    onClick={onSkip}
                    disabled={!transportControlsEnabled}
                    className="flex items-center justify-center w-10 h-10 rounded-xl transition-colors disabled:cursor-not-allowed"
                    style={{
                      color: transportControlsEnabled
                        ? "var(--text-primary)"
                        : "var(--text-muted)",
                      opacity: transportControlsEnabled ? 1 : 0.45,
                    }}
                    whileHover={transportControlsEnabled ? { scale: 1.08 } : undefined}
                    whileTap={transportControlsEnabled ? { scale: 0.92 } : undefined}
                  >
                    <SkipForward size={20} fill="currentColor" />
                  </motion.button>

                  {/* Loop */}
                  <motion.button
                    onClick={onToggleLoop}
                    className="flex items-center justify-center w-9 h-9 rounded-xl relative transition-colors"
                    style={{
                      color:
                        loopMode !== "none"
                          ? "var(--color-accent)"
                          : "var(--text-muted)",
                    }}
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                    title={
                      loopMode === "none"
                        ? "No loop"
                        : loopMode === "track"
                          ? "Loop track"
                          : "Loop queue"
                    }
                  >
                    <LoopIcon size={16} />
                    {loopMode !== "none" && (
                      <motion.div
                        className="absolute bottom-1 w-1 h-1 rounded-full"
                        style={{ background: "var(--color-accent)" }}
                      />
                    )}
                  </motion.button>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
