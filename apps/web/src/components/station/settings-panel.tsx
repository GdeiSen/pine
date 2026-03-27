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
import api from "@/lib/api";
import { useAuthStore } from "@/stores/auth.store";
import { formatFileSize, getAvatarFallback } from "@/lib/utils";

type AccessMode = "PUBLIC" | "PRIVATE";
type StreamQuality = "LOW" | "MEDIUM" | "HIGH";

interface StationSettingsInfo {
  id: string;
  code: string;
  name: string;
  description: string | null;
  accessMode: string;
  isPasswordProtected: boolean;
  crossfadeDuration: number;
  streamQuality: StreamQuality;
}

interface SettingsPanelProps {
  station: StationSettingsInfo;
  onBack: () => void;
  onSaved: (patch: Partial<StationSettingsInfo>) => void;
}

async function toAvatarDataUrl(file: File): Promise<string> {
  const readAsDataUrl = () =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const src = await readAsDataUrl();
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

  const maxSide = 360;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return src;

  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.86);
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

export function SettingsPanel({
  station,
  onBack,
  onSaved,
}: SettingsPanelProps) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const refreshUser = useAuthStore((s) => s.refreshUser);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDarkTheme, setIsDarkTheme] = useState(false);
  const [name, setName] = useState(station.name);
  const [description, setDescription] = useState(station.description ?? "");
  const [nickname, setNickname] = useState(user?.username ?? "");
  const [avatar, setAvatar] = useState<string | null>(user?.avatar ?? null);
  const [accessMode, setAccessMode] = useState<AccessMode>(
    (station.accessMode as AccessMode) ?? "PRIVATE",
  );
  const [passwordEnabled, setPasswordEnabled] = useState(
    !!station.isPasswordProtected,
  );
  const [streamQuality, setStreamQuality] = useState<StreamQuality>(
    (station.streamQuality as StreamQuality) ?? "HIGH",
  );
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  const availableStorageLabel = user?.storage
    ? `${formatFileSize(user.storage.availableBytes)} free`
    : "—";
  const usedStorageLabel = user?.storage
    ? `${formatFileSize(user.storage.usedBytes)} used`
    : "";

  useEffect(() => {
    setName(station.name);
    setDescription(station.description ?? "");
    setAccessMode((station.accessMode as AccessMode) ?? "PRIVATE");
    setPasswordEnabled(!!station.isPasswordProtected);
    setStreamQuality((station.streamQuality as StreamQuality) ?? "HIGH");
    setPassword("");
    setError("");
  }, [station]);

  useEffect(() => {
    setNickname(user?.username ?? "");
    setAvatar(user?.avatar ?? null);
  }, [user?.username, user?.avatar]);

  useEffect(() => {
    refreshUser().catch(() => {});
  }, [refreshUser]);

  useEffect(() => {
    const root = document.documentElement;
    const syncTheme = () => setIsDarkTheme(root.classList.contains("dark"));
    syncTheme();

    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  const hasPasswordAlready = !!station.isPasswordProtected;
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
          ...(passwordEnabled && password.trim()
            ? { password: password.trim() }
            : {}),
        }),
        api.put("/auth/me", {
          username: nickname.trim() || null,
          avatar,
        }),
      ]);

      onSaved({
        name: name.trim(),
        description: description.trim() || null,
        accessMode,
        crossfadeDuration: 3,
        streamQuality,
        isPasswordProtected: passwordEnabled
          ? password.trim().length >= 6 || hasPasswordAlready
          : false,
      });
      setPassword("");
      await refreshUser().catch(() => {});
      onBack();
    } catch (err: any) {
      setError(err?.response?.data?.message ?? "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file");
      return;
    }
    try {
      const next = await toAvatarDataUrl(file);
      setAvatar(next);
    } catch {
      setError("Failed to load avatar");
    }
  };

  const handleDeleteStation = async () => {
    if (!station.id || deleting) return;
    const confirmed = window.confirm(
      `Delete station "${station.name}" permanently? This cannot be undone.`,
    );
    if (!confirmed) return;

    setDeleting(true);
    setError("");
    try {
      await api.delete(`/stations/${station.id}`);
      router.push("/dashboard");
    } catch (err: any) {
      setError(err?.response?.data?.message ?? "Failed to delete station");
    } finally {
      setDeleting(false);
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
          className="px-8 py-6"
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
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleAvatarChange}
          />
          <div className="flex items-end gap-4 mb-6">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="relative w-20 h-20 rounded-full overflow-hidden shrink-0"
              title="Change avatar"
              style={{
                background: isDarkTheme
                  ? "rgba(255,255,255,0.06)"
                  : "rgba(0,0,0,0.08)",
                border: "1px solid var(--border)",
              }}
            >
              {avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={avatar}
                  alt="User avatar"
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-2xl font-black text-[--text-primary]">
                  {getAvatarFallback(
                    (nickname || user?.username || "PI").slice(0, 2),
                  )}
                </div>
              )}
            </button>

            <div className="min-w-0 flex-1 flex items-end justify-between gap-4">
              <div className="min-w-0 flex-1">
                <input
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  maxLength={30}
                  placeholder="Nickname (auto-generated if empty)"
                  className="w-full text-2xl text-[--text-primary] placeholder:text-[--text-muted] leading-tight focus:outline-none"
                  style={{
                    background: "transparent",
                    border: "none",
                    outline: "none",
                  }}
                />
                <p className="mt-1 text-sm text-[--text-muted] truncate">
                  {user?.email ?? "Radio listener profile"}
                </p>
              </div>
              <div className="shrink-0 text-right pb-0.5">
                <p className="text-[10px] uppercase tracking-[0.08em] text-[--text-muted]">
                  Storage
                </p>
                <p className="text-sm font-semibold text-[--text-primary] whitespace-nowrap">
                  {availableStorageLabel}
                </p>
                {usedStorageLabel ? (
                  <p className="text-[11px] text-[--text-muted] whitespace-nowrap">
                    {usedStorageLabel}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
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

      <div className="flex-1 overflow-y-auto p-8">
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
                    onChange={(e) =>
                      setPassword(e.target.value.slice(0, 8))
                    }
                    placeholder={
                      hasPasswordAlready
                        ? "Enter new password (max 8)"
                        : "Set password (6-8 chars)"
                    }
                    className="mt-2 w-full h-9 px-3 rounded-lg text-xs text-[--text-primary] placeholder:text-[--text-muted] focus:outline-none disabled:opacity-60"
                    style={{ border: "1px solid var(--border)", background: "var(--bg-elevated)" }}
                  />
                </div>
              </button>
            </div>
          </motion.section>

          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.09 }}
            className="rounded-2xl mt-8"
            style={{}}
          >
            <div className="h-full flex flex-col justify-between">
              <p className="mb-6 text-4xl font-black text-[--text-primary] tracking-tight leading-none">
                Playback
              </p>
              <p className="-mt-4 mb-6 text-sm text-[--text-muted]">
                Crossfade is fixed at 3 seconds by default.
              </p>

              <div className="mt-5">
                <p className="mb-6 mt-2 text-xl text-[--text-muted]">
                  Transmission Quality
                </p>
                <p className="-mt-4 mb-4 text-sm text-[--text-muted]">
                  Select stream quality based on listener network conditions:
                  lower quality saves traffic and reduces buffering risk, while
                  higher quality gives clearer and richer audio playback.
                </p>
                <div className="flex flex-wrap gap-2">
                  {QUALITY_OPTIONS.map((opt) => {
                    const active = streamQuality === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setStreamQuality(opt.value)}
                        className="w-[138px] h-[122px] rounded-xl p-3 transition-colors text-left shrink-0 flex flex-col justify-between"
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
              </div>
            </div>
          </motion.section>

          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 }}
            className="rounded-2xl"
          >
            <p className="text-4xl font-black text-[--text-primary] tracking-tight leading-none mb-4">
              Danger Zone
            </p>
            <p className="text-sm text-[--text-muted] mb-4">
              Remove this station completely with its queue, tracks and settings.
            </p>
            <Button
              variant="danger"
              className="!pl-0 pr-4 justify-start !bg-transparent hover:!bg-transparent"
              onClick={handleDeleteStation}
              isLoading={deleting}
            >
              <X size={14} />
              Delete Station
            </Button>
          </motion.section>
        </div>
      </div>

      <div
        className="px-4 py-3 flex items-center justify-between gap-2"
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
    </div>
  );
}
