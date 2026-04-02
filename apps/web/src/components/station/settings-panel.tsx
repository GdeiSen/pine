"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, Lock, Hash, Globe2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import api from "@/lib/api";

type AccessMode = "PUBLIC" | "PRIVATE";
type StreamQuality = "LOW" | "MEDIUM" | "HIGH";
type PlaybackMode = "DIRECT";

interface StationSettingsInfo {
  id: string;
  code: string;
  name: string;
  description: string | null;
  coverImage?: string | null;
  accessMode: string;
  isPasswordProtected: boolean;
  crossfadeDuration: number;
  streamQuality: StreamQuality;
  playbackMode: PlaybackMode;
}

interface SettingsPanelProps {
  station: StationSettingsInfo;
  onBack: () => void;
  onSaved: (patch: Partial<StationSettingsInfo>) => void;
}

const ACCESS_OPTIONS: Array<{
  value: AccessMode;
  label: string;
  hint: string;
  icon: ReactNode;
}> = [
  {
    value: "PRIVATE",
    label: "Private",
    hint: "Hidden from map, direct code only",
    icon: <Hash size={16} />,
  },
  {
    value: "PUBLIC",
    label: "Public",
    hint: "Visible in discovery",
    icon: <Globe2 size={16} />,
  },
];

const QUALITY_OPTIONS: Array<{
  value: StreamQuality;
  label: string;
  hint: string;
  icon: ReactNode;
}> = [
  {
    value: "LOW",
    label: "LOW",
    hint: "Data saver",
    icon: (
      <div className="flex items-end gap-0.5 h-4">
        <span className="w-1 h-1.5 rounded-sm bg-current opacity-90" />
        <span className="w-1 h-2.5 rounded-sm bg-current opacity-45" />
        <span className="w-1 h-3.5 rounded-sm bg-current opacity-35" />
      </div>
    ),
  },
  {
    value: "MEDIUM",
    label: "MEDIUM",
    hint: "Balanced",
    icon: (
      <div className="flex items-end gap-0.5 h-4">
        <span className="w-1 h-1.5 rounded-sm bg-current opacity-80" />
        <span className="w-1 h-2.5 rounded-sm bg-current opacity-80" />
        <span className="w-1 h-3.5 rounded-sm bg-current opacity-45" />
      </div>
    ),
  },
  {
    value: "HIGH",
    label: "HIGH",
    hint: "Best quality",
    icon: (
      <div className="flex items-end gap-0.5 h-4">
        <span className="w-1 h-1.5 rounded-sm bg-current opacity-85" />
        <span className="w-1 h-2.5 rounded-sm bg-current opacity-85" />
        <span className="w-1 h-3.5 rounded-sm bg-current opacity-85" />
      </div>
    ),
  },
];

const PLAYBACK_MODE_OPTIONS: Array<{
  value: PlaybackMode;
  label: string;
  hint: string;
  icon: ReactNode;
}> = [
  {
    value: "DIRECT",
    label: "Direct",
    hint: "HTTP stream · seek enabled",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM6 5.5l4.5 2.5L6 10.5v-5z" />
      </svg>
    ),
  },
];

export function SettingsPanel({
  station,
  onBack,
  onSaved,
}: SettingsPanelProps) {
  const router = useRouter();
  const stationCoverInputRef = useRef<HTMLInputElement | null>(null);
  const [isDarkTheme, setIsDarkTheme] = useState(false);
  const [name, setName] = useState(station.name);
  const [description, setDescription] = useState(station.description ?? "");
  const [coverImage, setCoverImage] = useState<string | null>(
    station.coverImage ?? null,
  );
  const [accessMode, setAccessMode] = useState<AccessMode>(
    (station.accessMode as AccessMode) ?? "PRIVATE",
  );
  const [passwordEnabled, setPasswordEnabled] = useState(
    !!station.isPasswordProtected,
  );
  const [streamQuality, setStreamQuality] = useState<StreamQuality>(
    (station.streamQuality as StreamQuality) ?? "HIGH",
  );
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>(
    (station.playbackMode as PlaybackMode) ?? "DIRECT",
  );
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [coverImageUploading, setCoverImageUploading] = useState(false);
  const [coverImageDeleting, setCoverImageDeleting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setName(station.name);
    setDescription(station.description ?? "");
    setCoverImage(station.coverImage ?? null);
    setAccessMode((station.accessMode as AccessMode) ?? "PRIVATE");
    setPasswordEnabled(!!station.isPasswordProtected);
    setStreamQuality((station.streamQuality as StreamQuality) ?? "HIGH");
    setPlaybackMode((station.playbackMode as PlaybackMode) ?? "DIRECT");
    setPassword("");
    setError("");
  }, [station]);

  useEffect(() => {
    const root = document.documentElement;
    const syncTheme = () => setIsDarkTheme(root.classList.contains("dark"));
    syncTheme();

    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  const hasPasswordAlready = !!station.isPasswordProtected;
  const playbackModeOptions = useMemo(
    () => PLAYBACK_MODE_OPTIONS,
    [],
  );

  const canSave = useMemo(() => {
    if (!name.trim()) return false;
    const passwordLength = password.trim().length;
    if (
      passwordEnabled &&
      !hasPasswordAlready &&
      (passwordLength < 6 || passwordLength > 8)
    )
      return false;
    if (
      passwordEnabled &&
      hasPasswordAlready &&
      passwordLength > 0 &&
      (passwordLength < 6 || passwordLength > 8)
    )
      return false;
    return true;
  }, [name, passwordEnabled, hasPasswordAlready, password]);

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError("");
    try {
      await Promise.all([
        api.put(`/stations/${station.id}`, {
          name: name.trim(),
          description: description.trim() || null,
          accessMode,
          passwordEnabled,
          crossfadeDuration: 3,
          streamQuality,
          playbackMode,
          ...(passwordEnabled && password.trim()
            ? { password: password.trim() }
            : {}),
        }),
      ]);

      onSaved({
        name: name.trim(),
        description: description.trim() || null,
        coverImage,
        accessMode,
        crossfadeDuration: 3,
        streamQuality,
        playbackMode,
        isPasswordProtected: passwordEnabled
          ? password.trim().length >= 6 || hasPasswordAlready
          : false,
      });
      setPassword("");
      onBack();
    } catch (err: any) {
      setError(err?.response?.data?.message ?? "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteStation = async () => {
    if (!station.id || deleting) return;

    setDeleting(true);
    setError("");
    try {
      await api.delete(`/stations/${station.id}`);
      router.push("/dashboard");
      return true;
    } catch (err: any) {
      setError(err?.response?.data?.message ?? "Failed to delete station");
      return false;
    } finally {
      setDeleting(false);
    }
  };

  const handleStationCoverUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!station.id) return;
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file");
      return;
    }

    setError("");
    setCoverImageUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await api.post(`/stations/${station.id}/cover/upload`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      const nextCover =
        typeof response?.data?.coverImage === "string" ? response.data.coverImage : null;
      setCoverImage(nextCover);
      onSaved({ coverImage: nextCover });
    } catch (err: any) {
      const message = err?.response?.data?.message;
      if (Array.isArray(message)) setError(message.join(", "));
      else setError(message ?? "Failed to upload station cover");
    } finally {
      setCoverImageUploading(false);
    }
  };

  const handleDeleteStationCover = async () => {
    if (!station.id || !coverImage) return;
    setError("");
    setCoverImageDeleting(true);
    try {
      await api.delete(`/stations/${station.id}/cover`);
      setCoverImage(null);
      onSaved({ coverImage: null });
    } catch (err: any) {
      const message = err?.response?.data?.message;
      if (Array.isArray(message)) setError(message.join(", "));
      else setError(message ?? "Failed to delete station cover");
    } finally {
      setCoverImageDeleting(false);
    }
  };

  return (
    <div className="h-full flex flex-col" style={{ background: "var(--bg)" }}>
      <div
        style={{
          width: "100%",
          background: "var(--bg-elevated)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="px-4 py-6 md:px-8 md:py-6"
        >
          <div className="flex items-start justify-between mb-3">
            <Button
              variant="ghost"
              size="md"
              className="!px-0"
              onClick={onBack}
            >
              <ArrowLeft size={14} />
              Back
            </Button>
          </div>
          <input
            ref={stationCoverInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleStationCoverUpload}
          />
          <div className="space-y-3">
            <textarea
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              rows={1}
              placeholder="Station name"
              className="w-full py-0 text-7xl text-[--text-muted] tracking-tight placeholder:text-[--text-muted] leading-[0.95] resize-none overflow-hidden whitespace-pre-wrap break-words focus:outline-none focus-visible:outline-none"
              style={{
                background: "transparent",
                border: "none",
                outline: "none",
              }}
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={300}
              rows={3}
              placeholder="Description"
              className="w-full pt-2.5 pb-0 text-sm text-[--text-primary] placeholder:text-[--text-muted] focus:outline-none focus-visible:outline-none resize-none"
              style={{
                background: "transparent",
                border: "none",
                outline: "none",
              }}
            />
          </div>
        </motion.section>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-8 md:p-8">
        <div className="flex flex-col gap-8 w-full max-w-[920px]">
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.03 }}
          >
            <div className="flex items-center gap-2 mb-6">
              <p className="text-4xl font-black text-[--text-primary] tracking-tight leading-none">
                Access
              </p>
            </div>
            <p className="-mt-3 mb-5 text-sm text-[--text-muted]">
              Choose station availability and configure extra password
              protection independently.
            </p>
            <div className="flex flex-wrap gap-2 items-stretch">
              {ACCESS_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setAccessMode(opt.value)}
                  className="w-[138px] h-[122px] rounded-xl p-3 transition-colors text-left shrink-0 flex flex-col justify-between"
                  style={{
                    background:
                      accessMode === opt.value
                        ? isDarkTheme
                          ? "var(--bg-inset)"
                          : "rgba(255,255,255,0.92)"
                        : isDarkTheme
                          ? "rgba(255,255,255,0.07)"
                          : "rgba(0,0,0,0.06)",
                    border: `2px solid ${
                      accessMode === opt.value
                        ? isDarkTheme
                          ? "var(--color-accent)"
                          : "rgba(24,23,15,0.55)"
                        : "var(--border)"
                    }`,
                  }}
                >
                  <div className="text-[--text-primary]">{opt.icon}</div>
                  <div>
                    <p className="text-sm font-semibold text-[--text-primary] leading-tight">
                      {opt.label}
                    </p>
                    <p className="text-[10px] text-[--text-muted] mt-1 leading-tight">
                      {opt.hint}
                    </p>
                  </div>
                </button>
              ))}
              <button
                type="button"
                onClick={() => setPasswordEnabled((v) => !v)}
                className="w-[284px] h-[122px] rounded-xl p-3 text-left shrink-0 flex flex-col justify-between transition-colors"
                style={{
                  background: passwordEnabled
                    ? isDarkTheme
                      ? "var(--bg-inset)"
                      : "rgba(255,255,255,0.92)"
                    : isDarkTheme
                      ? "rgba(255,255,255,0.07)"
                      : "rgba(0,0,0,0.06)",
                  border: `2px solid ${
                    passwordEnabled
                      ? isDarkTheme
                        ? "var(--color-accent)"
                        : "rgba(24,23,15,0.55)"
                      : "var(--border)"
                  }`,
                }}
              >
                <div className="flex items-start justify-between">
                  <Lock size={18} className="text-[--text-primary]" />
                  <span className="text-[10px] text-[--text-muted]">
                    {passwordEnabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
                <div>
                  <p className="text-sm font-semibold text-[--text-primary] leading-tight">
                    Password protection
                  </p>
                  <input
                    type="password"
                    value={password}
                    maxLength={8}
                    disabled={!passwordEnabled}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setPassword(e.target.value.slice(0, 8))}
                    placeholder={
                      hasPasswordAlready
                        ? "Enter new password (max 8)"
                        : "Set password (6-8 chars)"
                    }
                    className="mt-2 w-full h-9 px-3 rounded-lg text-xs text-[--text-primary] placeholder:text-[--text-muted] focus:outline-none disabled:opacity-60"
                    style={{
                      border: "1px solid var(--border)",
                      background: "var(--bg-elevated)",
                    }}
                  />
                </div>
              </button>
            </div>
          </motion.section>

          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.06 }}
          >
            <div className="flex items-center gap-2 mb-6">
              <p className="text-4xl font-black text-[--text-primary] tracking-tight leading-none">
                Station Mode
              </p>
            </div>
            <p className="-mt-3 mb-5 text-sm text-[--text-muted]">
              Tracks stream over HTTP with local playback, seek support, and event-based sync.
            </p>
            <div className="flex flex-wrap gap-2 items-stretch">
              {playbackModeOptions.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setPlaybackMode(opt.value)}
                  className="w-[138px] h-[122px] rounded-xl p-3 transition-colors text-left shrink-0 flex flex-col justify-between"
                  style={{
                    background:
                      playbackMode === opt.value
                        ? isDarkTheme
                          ? "var(--bg-inset)"
                          : "rgba(255,255,255,0.92)"
                        : isDarkTheme
                          ? "rgba(255,255,255,0.07)"
                          : "rgba(0,0,0,0.06)",
                    border: `2px solid ${
                      playbackMode === opt.value
                        ? isDarkTheme
                          ? "var(--color-accent)"
                          : "rgba(24,23,15,0.55)"
                        : "var(--border)"
                    }`,
                  }}
                >
                  <div className="text-[--text-primary]">{opt.icon}</div>
                  <div>
                    <p className="text-sm font-semibold text-[--text-primary] leading-tight">
                      {opt.label}
                    </p>
                    <p className="text-[10px] text-[--text-muted] mt-1 leading-tight">
                      {opt.hint}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </motion.section>

          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.09 }}
            className="rounded-2xl mt-2"
            style={{}}
          >
            <div className="h-full flex flex-col justify-between">
              <p className="mb-6 text-4xl font-black text-[--text-primary] tracking-tight leading-none">
                Playback
              </p>

              <div className="mt-5">
                <p className="-mt-4 mb-4 text-sm text-[--text-muted]">
                  Direct playback currently sends the original uploaded file to
                  listeners. Quality presets below are not applied yet because
                  alternate low/medium/high transcodes are not generated in the
                  current direct-only pipeline.
                </p>
                <div className="flex flex-wrap gap-2">
                  {QUALITY_OPTIONS.map((opt) => {
                    const active = streamQuality === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        disabled
                        onClick={() => setStreamQuality(opt.value)}
                        className="w-[138px] h-[122px] rounded-xl p-3 transition-colors text-left shrink-0 flex flex-col justify-between disabled:cursor-not-allowed"
                        style={{
                          background: active
                            ? isDarkTheme
                              ? "var(--bg-inset)"
                              : "rgba(255,255,255,0.92)"
                            : isDarkTheme
                              ? "rgba(255,255,255,0.07)"
                              : "rgba(0,0,0,0.06)",
                          border: `2px solid ${
                            active
                              ? isDarkTheme
                                ? "var(--color-accent)"
                                : "rgba(24,23,15,0.55)"
                              : "var(--border)"
                          }`,
                          opacity: active ? 0.92 : 0.6,
                        }}
                      >
                        <div className="text-[--text-primary]">{opt.icon}</div>
                        <div>
                          <p className="text-sm font-semibold text-[--text-primary]">
                            {opt.label}
                          </p>
                          <p className="text-[10px] text-[--text-muted] mt-1">
                            {opt.hint}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
                <p className="mt-3 text-xs text-[--text-muted]">
                  To make these presets work for listeners, the server needs a
                  real transcode ladder such as `LOW / MEDIUM / HIGH` assets and
                  quality-aware stream selection.
                </p>
              </div>
            </div>
          </motion.section>

          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 }}
          >
            <div className="flex items-center gap-2 mb-6">
              <p className="text-4xl font-black text-[--text-primary] tracking-tight leading-none">
                Media
              </p>
            </div>
            <p className="-mt-3 mb-5 text-sm text-[--text-muted]">
              Upload station cover shown in the left panel.
            </p>

            <div className="space-y-5">
              <div>
                <div className="flex items-center justify-end gap-3 mb-2">
                  <div className="flex items-center gap-2">
                    {coverImage ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={handleDeleteStationCover}
                        isLoading={coverImageDeleting}
                      >
                        Remove
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        stationCoverInputRef.current?.click();
                      }}
                      isLoading={coverImageUploading}
                    >
                      {coverImage ? "Replace image" : "Upload image"}
                    </Button>
                  </div>
                </div>
                {coverImage ? (
                  <div className="relative w-32 md:w-36 aspect-square rounded-xl overflow-hidden border border-[--border] bg-[--bg-subtle]">
                    <img
                      src={coverImage}
                      alt="Station cover"
                      className="w-full h-full object-cover"
                    />
                  </div>
                ) : (
                  <p className="text-xs text-[--text-muted]">
                    Add one station cover image to show in the left panel.
                  </p>
                )}
              </div>
            </div>
          </motion.section>

          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="rounded-2xl"
          >
            <p className="text-4xl font-black text-[--text-primary] tracking-tight leading-none mb-4">
              Danger Zone
            </p>
            <p className="text-sm text-[--text-muted] mb-4">
              Remove this station completely with its queue, tracks and
              settings.
            </p>
            <Button
              variant="danger"
              className="!pl-0 pr-4 justify-start !bg-transparent hover:!bg-transparent"
              onClick={() => setDeleteModalOpen(true)}
              isLoading={deleting}
            >
              <X size={14} />
              Delete Station
            </Button>
          </motion.section>
        </div>
      </div>

      <div
        className="h-16 px-4 flex items-center justify-between gap-2"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        {error ? (
          <p className="text-sm text-red-300 truncate">{error}</p>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={onBack}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!canSave || saving}
            isLoading={saving}
          >
            Save Settings
          </Button>
        </div>
      </div>

      <ConfirmModal
        open={deleteModalOpen}
        title="Delete station?"
        description={`Station "${station.name}" will be removed permanently with its queue, tracks and settings.`}
        confirmLabel="Delete station"
        loading={deleting}
        onCancel={() => setDeleteModalOpen(false)}
        onConfirm={async () => {
          const success = await handleDeleteStation();
          if (success) setDeleteModalOpen(false);
        }}
      />
    </div>
  );
}
