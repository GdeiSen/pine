"use client";

import { useEffect, useState } from "react";
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

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";
const AUDIO_DEBUG_ENABLED =
  process.env.NEXT_PUBLIC_AUDIO_DEBUG === "1" ||
  process.env.NEXT_PUBLIC_AUDIO_DEBUG === "true";

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
  } | null;
  currentQueueType: "USER" | "SYSTEM" | null;
  currentPosition: number;
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
  onToggleLoop: () => void;
  onToggleShuffle: () => void;
}

export function TrackInfo({
  track,
  currentQueueType,
  currentPosition,
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
  onToggleLoop,
  onToggleShuffle,
}: TrackInfoProps) {
  const coverUrl = track?.hasCover
    ? `${API_URL}/tracks/${track.id}/cover`
    : null;
  const [resolvedCoverUrl, setResolvedCoverUrl] = useState<string | null>(null);

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
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [coverUrl, track?.id]);

  const isActive = isPlaying && !isPaused;
  const LoopIcon = loopMode === "track" ? Repeat1 : Repeat;
  const playbackModeLabel =
    currentQueueType === "USER" ? "CUSTOM QUEUE" : "AUTO PLAY";
  const showTransportBanner =
    audioConnectionState !== "playing" &&
    audioConnectionState !== "paused" &&
    audioConnectionState !== "idle";
  const transportLabel = (() => {
    if (audioConnectionState === "blocked") return "Playback blocked"
    if (audioConnectionState === "buffering") return "Buffering"
    if (audioConnectionState === "reconnecting") return "Reconnecting"
    if (audioConnectionState === "connecting") return "Connecting"
    return "Playing"
  })();

  return (
    <div className="p-6 flex flex-col gap-5">
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
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -5 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="flex gap-8 items-center mb-4"
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
          <div className="flex-1 min-w-0">
            <p
              className="text-2xl font-bold text-[--text-primary] truncate leading-tight"
              style={{ letterSpacing: "-0.5px" }}
            >
              {track?.title ?? "Nothing playing"}
            </p>
            <p className="text-sm text-[--text-secondary] mt-0.5 truncate">
              {track?.artist ?? "—"}
            </p>
            {(track?.album || track?.year) && (
              <p className="text-xs text-[--text-muted] mt-0.5 truncate">
                {[track.album, track.year].filter(Boolean).join(" · ")}
              </p>
            )}
            {track?.genre && (
              <p className="text-xs text-[--text-muted] mt-1 truncate">
                {track.genre}
              </p>
            )}
            {/*{track && (
              <p className="mt-2 ml-0 pl-0 text-xs font-semibold uppercase tracking-[0.08em] text-[--color-accent]">
                {playbackModeLabel}
              </p>
            )}*/}
          </div>
        </motion.div>
      </AnimatePresence>

      {showTransportBanner || audioNeedsRestart ? (
        <div className="py-3 flex flex-col items-center justify-center gap-3">
          {showTransportBanner && (
            <div className="w-full max-w-[640px] rounded-2xl border border-[--border] bg-[--bg-subtle] px-3 py-2 flex items-center gap-2">
              <Loader2 size={14} className="text-[--text-muted] animate-spin" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-[--text-primary] truncate">
                  {transportLabel}
                </p>
                <p className="text-[11px] text-[--text-muted] truncate">
                  {audioConnectionMessage ??
                    "The player is handling the current stream state."}
                </p>
              </div>
            </div>
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
                Звук был заблокирован браузером. Нажмите кнопку, чтобы
                перезапустить воспроизведение.
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          {/* Ruler progress bar */}
          <RulerProgressBar
            currentPosition={currentPosition}
            isPaused={isPaused}
            duration={track?.duration ?? 0}
            onSeek={onSeek}
            interactive={progressInteractive}
          />

          {/* Controls */}
          {canControl && (
            <div className="w-full max-w-[640px] mx-auto">
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
                  className="flex items-center justify-center w-10 h-10 rounded-xl text-[--text-secondary] hover:text-[--text-primary] transition-colors"
                  whileHover={{ scale: 1.08 }}
                  whileTap={{ scale: 0.92 }}
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
                  className="flex items-center justify-center w-10 h-10 rounded-xl text-[--text-secondary] hover:text-[--text-primary] transition-colors"
                  whileHover={{ scale: 1.08 }}
                  whileTap={{ scale: 0.92 }}
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
        </>
      )}
    </div>
  );
}
