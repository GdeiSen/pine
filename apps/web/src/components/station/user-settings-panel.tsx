"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { motion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import api from "@/lib/api";
import { useAuthStore } from "@/stores/auth.store";
import { getAvatarFallback, formatFileSize } from "@/lib/utils";

interface UserSettingsPanelProps {
  onBack: () => void;
}

function resolveApiErrorMessage(err: any, fallback: string) {
  const message = err?.response?.data?.message;
  if (Array.isArray(message)) return message.join(", ");
  if (typeof message === "string" && message.trim().length > 0) return message;
  return fallback;
}

export function UserSettingsPanel({ onBack }: UserSettingsPanelProps) {
  const user = useAuthStore((s) => s.user);
  const refreshUser = useAuthStore((s) => s.refreshUser);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  const [nickname, setNickname] = useState(user?.username ?? "");
  const [avatar, setAvatar] = useState<string | null>(user?.avatar ?? null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    setNickname(user?.username ?? "");
    setAvatar(user?.avatar ?? null);
  }, [user?.username, user?.avatar]);

  const storageLabel = useMemo(() => {
    if (!user?.storage) return "—";
    return `${formatFileSize(user.storage.availableBytes)} free · ${formatFileSize(
      user.storage.usedBytes,
    )} used`;
  }, [user?.storage]);

  const hasAnyPasswordValue = useMemo(
    () =>
      currentPassword.trim().length > 0 ||
      newPassword.trim().length > 0 ||
      confirmPassword.trim().length > 0,
    [confirmPassword, currentPassword, newPassword],
  );

  const isPasswordSectionValid = useMemo(() => {
    if (!hasAnyPasswordValue) return true;
    if (currentPassword.trim().length === 0) return false;
    if (newPassword.trim().length < 6) return false;
    if (newPassword.trim().length > 100) return false;
    if (newPassword !== confirmPassword) return false;
    return true;
  }, [confirmPassword, currentPassword, hasAnyPasswordValue, newPassword]);

  const passwordHint = useMemo(() => {
    if (!hasAnyPasswordValue) return "Leave all fields empty if you don't want to change password.";
    if (currentPassword.trim().length === 0) return "Enter your current password to continue.";
    if (newPassword.trim().length > 0 && newPassword.trim().length < 6)
      return "New password must contain at least 6 characters.";
    if (newPassword.trim().length > 100)
      return "New password can contain up to 100 characters.";
    if (newPassword !== confirmPassword) return "New password and confirmation should match.";
    return "";
  }, [confirmPassword, currentPassword, hasAnyPasswordValue, newPassword]);

  const showPasswordErrorHint = hasAnyPasswordValue && !isPasswordSectionValid;

  const canSave = useMemo(() => {
    if (!nickname.trim()) return false;
    if (!isPasswordSectionValid) return false;
    if (avatarUploading || saving) return false;
    return true;
  }, [avatarUploading, isPasswordSectionValid, nickname, saving]);

  const handleAvatarChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file");
      return;
    }

    setError("");
    setSuccess("");
    setAvatarUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await api.post("/auth/me/avatar", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      const nextAvatar =
        typeof response?.data?.avatar === "string" ? response.data.avatar : null;
      setAvatar(nextAvatar);
      await refreshUser().catch(() => {});
      setSuccess("Avatar updated");
    } catch (err: any) {
      setError(resolveApiErrorMessage(err, "Failed to upload avatar"));
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleSave = async () => {
    if (!canSave) return;
    setError("");
    setSuccess("");
    setSaving(true);

    const trimmedNickname = nickname.trim();
    const hasPasswordUpdate =
      currentPassword.trim().length > 0 ||
      newPassword.trim().length > 0 ||
      confirmPassword.trim().length > 0;

    try {
      await api.put("/auth/me", { username: trimmedNickname || null });

      if (hasPasswordUpdate) {
        await api.put("/auth/me/password", {
          currentPassword: currentPassword.trim(),
          newPassword: newPassword.trim(),
        });
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
      }

      await refreshUser().catch(() => {});
      setSuccess(hasPasswordUpdate ? "Profile and password updated" : "Profile updated");
    } catch (err: any) {
      setError(resolveApiErrorMessage(err, "Failed to save user settings"));
    } finally {
      setSaving(false);
    }
  };

  const passwordInputClassName =
    "w-full h-9 rounded-lg border border-[--border] bg-[--bg-elevated] px-2.5 text-xs text-[--text-primary] placeholder:text-[--text-muted] focus:outline-none focus:ring-2 focus:ring-[--color-accent-muted] focus:border-[--text-primary]/20 transition";

  return (
    <div className="h-full flex flex-col" style={{ background: "var(--bg)" }}>
      <div
        style={{
          width: "100%",
          background:
            "linear-gradient(180deg, var(--bg-elevated) 0%, color-mix(in oklab, var(--bg-elevated) 90%, var(--bg) 10%) 100%)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="px-4 py-6 md:px-8"
        >
          <div className="flex items-start justify-between mb-5">
            <Button variant="ghost" size="md" className="!px-0" onClick={onBack}>
              <ArrowLeft size={14} />
              Back
            </Button>
          </div>

          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleAvatarChange}
          />

          <div className="flex flex-col items-start gap-4">
            <button
              type="button"
              onClick={() => avatarInputRef.current?.click()}
              disabled={avatarUploading}
              className="relative w-24 h-24 rounded-full overflow-hidden shrink-0"
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                boxShadow: "var(--shadow-sm)",
              }}
              title="Change avatar"
            >
              {avatar ? (
                <img src={avatar} alt="User avatar" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-2xl font-black text-[--text-primary]">
                  {getAvatarFallback((nickname || user?.username || "PI").slice(0, 2))}
                </div>
              )}
            </button>

            <div className="min-w-0 w-full">
              <input
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                maxLength={30}
                placeholder="Nickname"
                className="w-full py-0 text-6xl md:text-7xl uppercase tracking-tight text-[--text-muted] placeholder:text-[--text-muted] leading-[0.95] focus:outline-none"
                style={{ background: "transparent", border: "none", outline: "none" }}
              />
              <p className="mt-1 text-sm text-[--text-muted] truncate">
                {user?.email ?? "User profile"}
              </p>
              <p className="mt-1 text-xs text-[--text-muted]">{storageLabel}</p>
            </div>
          </div>
        </motion.section>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-7">
        <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex items-center gap-2 mb-6">
            <p className="text-4xl font-black text-[--text-primary] tracking-tight leading-none">
              Password
            </p>
          </div>
          <p className="-mt-3 mb-5 text-sm text-[--text-muted]">
            Change password only when needed. Fill every field to apply an update.
          </p>

          <div className="flex flex-col gap-3 md:gap-4 max-w-xl">
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-[--text-secondary]">
                Current password
              </label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                maxLength={100}
                placeholder="Enter current"
                className={passwordInputClassName}
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-[--text-secondary]">
                New password
              </label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                maxLength={100}
                placeholder="Enter new"
                className={passwordInputClassName}
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-[--text-secondary]">
                Confirm password
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                maxLength={100}
                placeholder="Repeat new"
                className={passwordInputClassName}
              />
            </div>
          </div>

          <p
            className={`mt-4 text-xs ${showPasswordErrorHint ? "text-red-400" : "text-[--text-muted]"}`}
          >
            {showPasswordErrorHint
              ? passwordHint
              : "Leave all fields empty if you don't want to change password."}
          </p>
        </motion.section>
      </div>

      <div
        className="h-16 px-4 md:px-8 flex items-center justify-between gap-2"
        style={{ borderTop: "1px solid var(--border)", background: "var(--bg-elevated)" }}
      >
        {error ? (
          <p className="text-sm text-red-400 truncate">{error}</p>
        ) : success ? (
          <p className="text-sm text-emerald-500 truncate">{success}</p>
        ) : (
          <span />
        )}

        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={onBack}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave} isLoading={saving}>
            Save changes
          </Button>
        </div>
      </div>
    </div>
  );
}
