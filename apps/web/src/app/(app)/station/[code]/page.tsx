"use client";

import { use, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useStation } from "@/hooks/useStation";
import { useAuthStore } from "@/stores/auth.store";
import { LeftPanel } from "@/components/station/left-panel";
import { TrackInfo } from "@/components/station/track-info";
import { QueueLibraryPanel } from "@/components/station/queue-library-panel";
import { SettingsPanel } from "@/components/station/settings-panel";
import { AddTracksPanel } from "@/components/station/add-tracks-panel";
import { ListenOnlyPageShell } from "@/components/station/listen-only-page-shell";
import { PublicListenPlayer } from "@/components/station/public-listen-player";
import { ListenOnlyPlayerCard } from "@/components/station/listen-only-player-card";
import { HeaderVolumeControl } from "@/components/station/header-volume-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import api from "@/lib/api";
import {
  Settings,
  Moon,
  Sun,
  Radio,
  ListMusic,
  Users2,
  MoreHorizontal,
  Search,
  X,
  ShieldCheck,
  UserRound,
  Play,
  UserX,
} from "lucide-react";
import { useTheme } from "next-themes";
import type { LoopMode } from "@/stores/station.store";
import { MemberRole, Permission, type StationMember } from "@web-radio/shared";

type Tab = "queue" | "members";
type ContentMode = "station" | "settings" | "add-tracks";
type PublicGuestStation = {
  code: string;
  name: string;
  description: string | null;
  listenerCount: number;
  accessMode: "PUBLIC" | "PRIVATE";
  isPasswordProtected: boolean;
  currentTrackId: string | null;
  currentTrack?: {
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
  currentPosition?: number;
  isPaused?: boolean;
  trackStartedAt?: string | null;
  pausedPosition?: number;
};

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "queue", label: "Queue", icon: <ListMusic size={14} /> },
  { id: "members", label: "Members", icon: <Users2 size={14} /> },
];

const MAX_MEMBERS_ON_MAP = 10;
const MAX_ADMINS_PER_STATION = 10;
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

function formatApiError(err: any, fallback: string) {
  const message = err?.response?.data?.message;
  if (Array.isArray(message)) return message.join(", ");
  if (typeof message === "string" && message.trim()) return message;
  return fallback;
}

function getStationJoinError(err: any) {
  const status = err?.response?.status;
  const raw = formatApiError(err, "Не удалось подключиться к станции");
  const text = raw.toLowerCase();

  if (status === 404) {
    return { message: "Станция не найдена", requiresPassword: false };
  }
  if (status === 403) {
    return { message: "Нет доступа к станции", requiresPassword: false };
  }
  if (status === 401 && text.includes("password required")) {
    return { message: "Введите пароль станции", requiresPassword: true };
  }
  if (status === 401 && text.includes("wrong password")) {
    return { message: "Неверный пароль станции", requiresPassword: true };
  }

  return {
    message: raw,
    requiresPassword: status === 401 && text.includes("password"),
  };
}

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return h >>> 0;
}

function isMapAdminRole(role: MemberRole) {
  return role === MemberRole.OWNER || role === MemberRole.ADMIN;
}

function getRoleLabel(role: MemberRole) {
  if (role === MemberRole.OWNER) return "Owner";
  if (role === MemberRole.ADMIN) return "Admin";
  return "Listener";
}

export default function StationPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = use(params);
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>("queue");
  const [contentMode, setContentMode] = useState<ContentMode>("station");
  const [managedPlaylistId, setManagedPlaylistId] = useState<string | null>(
    null,
  );
  const [canConnect, setCanConnect] = useState(false);
  const [isJoinChecking, setIsJoinChecking] = useState(true);
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [joinError, setJoinError] = useState("");
  const [stationPassword, setStationPassword] = useState("");
  const [approvedJoinPassword, setApprovedJoinPassword] = useState<
    string | null
  >(null);
  const [isSubmittingPassword, setIsSubmittingPassword] = useState(false);
  const [guestListenState, setGuestListenState] =
    useState<PublicGuestStation | null>(null);
  const [joinAttempt, setJoinAttempt] = useState(0);
  const [memberMenuUserId, setMemberMenuUserId] = useState<string | null>(null);
  const [memberActionPending, setMemberActionPending] = useState<string | null>(
    null,
  );
  const [memberActionError, setMemberActionError] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [mounted, setMounted] = useState(false);
  const [isTrackInfoVisible, setIsTrackInfoVisible] = useState(true);
  const [isContentScrolledDown, setIsContentScrolledDown] = useState(false);
  const [isPageScrolledDown, setIsPageScrolledDown] = useState(false);
  const trackInfoRef = useRef<HTMLDivElement | null>(null);
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const { theme, setTheme } = useTheme();
  const user = useAuthStore((s) => s.user);
  useEffect(() => setMounted(true), []);
  useEffect(() => setMemberMenuUserId(null), [memberSearch, activeTab]);
  useEffect(() => {
    if (contentMode !== "station") {
      setIsTrackInfoVisible(true);
      setIsContentScrolledDown(false);
      return;
    }

    const target = trackInfoRef.current;
    if (!target) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsTrackInfoVisible(entry?.isIntersecting ?? true);
      },
      { threshold: 0.12 },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [contentMode]);

  useEffect(() => {
    const el = contentScrollRef.current;
    if (!el || contentMode !== "station") {
      setIsContentScrolledDown(false);
      return;
    }

    const handleScroll = () => {
      setIsContentScrolledDown(el.scrollTop > 56);
    };

    handleScroll();
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [contentMode, activeTab]);

  useEffect(() => {
    if (contentMode !== "station") {
      setIsPageScrolledDown(false);
      return;
    }

    const handleWindowScroll = () => {
      setIsPageScrolledDown(window.scrollY > 40);
    };

    handleWindowScroll();
    window.addEventListener("scroll", handleWindowScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleWindowScroll);
  }, [contentMode]);

  useEffect(() => {
    let cancelled = false;

    const bootstrapJoin = async () => {
      setCanConnect(false);
      setRequiresPassword(false);
      setJoinError("");
      setStationPassword("");
      setApprovedJoinPassword(null);
      setGuestListenState(null);
      setIsJoinChecking(true);

      const hasToken =
        typeof window !== "undefined" &&
        !!localStorage.getItem("access_token");

      if (!hasToken) {
        try {
          const res = await fetch(`${API_URL}/stations/${code}`, {
            cache: "no-store",
          });
          if (!res.ok) {
            if (!cancelled) setJoinError("Станция не найдена");
            return;
          }

          const stationData = (await res.json()) as PublicGuestStation;
          if (cancelled) return;

          if (
            stationData.accessMode === "PUBLIC" &&
            !stationData.isPasswordProtected
          ) {
            setGuestListenState(stationData);
            return;
          }

          if (stationData.isPasswordProtected) {
            setJoinError(
              "Для прослушивания этой станции требуется авторизация",
            );
            return;
          }

          setJoinError("Нет доступа к станции");
          return;
        } catch {
          if (!cancelled) setJoinError("Не удалось подключиться к станции");
          return;
        } finally {
          if (!cancelled) setIsJoinChecking(false);
        }
      }

      try {
        await api.post(`/stations/${code}/join`, {});
        if (cancelled) return;
        setCanConnect(true);
      } catch (err: any) {
        if (cancelled) return;
        const { message, requiresPassword: isPasswordRequired } =
          getStationJoinError(err);

        if (isPasswordRequired) {
          setJoinError(message);
          setRequiresPassword(true);
          return;
        }

        setJoinError(message);
      } finally {
        if (!cancelled) setIsJoinChecking(false);
      }
    };

    bootstrapJoin();

    return () => {
      cancelled = true;
    };
  }, [code, joinAttempt]);

  const {
    station,
    playback,
    queue,
    members,
    chat,
    audioNeedsRestart,
    isConnected,
    isConnecting,
    sendPlaybackControl,
    restartAudio,
    sendChatMessage,
    addToQueue,
    removeFromQueue,
    reorderQueue,
    setStation,
    setMembers,
  } = useStation(canConnect ? code : "", approvedJoinPassword);

  const isPlaying = playback.isPlaying;
  const isPaused = playback.isPaused;
  const track = playback.currentTrack;
  const loopMode = playback.loopMode ?? "none";
  const shuffleEnabled = playback.shuffleEnabled ?? false;
  const userQueueCount = queue.filter(
    (item) => item.queueType === "USER",
  ).length;
  const currentMember = members.find((member) => member.user.id === user?.id);
  const isOwner =
    station?.owner?.id === user?.id || currentMember?.role === MemberRole.OWNER;
  const isAdmin = currentMember?.role === MemberRole.ADMIN;
  const hasPlaybackPermission =
    currentMember?.permissions?.includes(Permission.PLAYBACK_CONTROL) ?? false;
  const canControl = isOwner || isAdmin || hasPlaybackPermission;
  const canManageMembers = isOwner || isAdmin;

  const normalizedMemberSearch = useMemo(
    () => memberSearch.trim().toLowerCase(),
    [memberSearch],
  );

  const filteredMembers = useMemo(() => {
    if (!normalizedMemberSearch) return members;
    return members.filter((member) => {
      const username = member.user.username.toLowerCase();
      const role = getRoleLabel(member.role).toLowerCase();
      return (
        username.includes(normalizedMemberSearch) ||
        role.includes(normalizedMemberSearch)
      );
    });
  }, [members, normalizedMemberSearch]);

  const mapMembers = useMemo(() => {
    const activeMembers = members.filter((member) => member.isOnline);
    const currentUserId = user?.id;
    const currentUsername = user?.username?.trim().toLowerCase();
    const ownerId = station?.owner?.id;

    if (currentUserId || currentUsername) {
      const isCurrentUser = (member: StationMember) =>
        (currentUserId ? member.user.id === currentUserId : false) ||
        (currentUsername
          ? member.user.username.trim().toLowerCase() === currentUsername
          : false);

      const alreadyOnMap = activeMembers.some(isCurrentUser);
      if (!alreadyOnMap) {
        const existingMember = members.find(isCurrentUser);
        const resolvedUserId =
          currentUserId ??
          existingMember?.user.id ??
          `self-${(currentUsername ?? "user").replace(/\s+/g, "-")}`;
        const fallbackRole =
          existingMember?.role ??
          (station?.owner?.id === currentUserId
            ? MemberRole.OWNER
            : MemberRole.LISTENER);

        activeMembers.unshift(
          existingMember
            ? { ...existingMember, isOnline: true }
            : {
                id: `self-${currentUserId}`,
                stationId: station?.id ?? "",
                user: {
                  id: resolvedUserId,
                  username: user?.username ?? "You",
                  avatar: user?.avatar ?? null,
                },
                role: fallbackRole,
                permissions: [],
                joinedAt: new Date().toISOString(),
                isOnline: true,
              },
        );
      }
    }

    const allActiveAdmins = activeMembers.filter((member) =>
      isMapAdminRole(member.role),
    );

    if (ownerId) {
      const ownerAdminIndex = allActiveAdmins.findIndex(
        (member) => member.user.id === ownerId,
      );
      if (ownerAdminIndex > 0) {
        const [ownerMember] = allActiveAdmins.splice(ownerAdminIndex, 1);
        allActiveAdmins.unshift(ownerMember);
      }
    }

    const activeAdmins = allActiveAdmins.slice(0, MAX_ADMINS_PER_STATION);
    const adminIds = new Set(activeAdmins.map((member) => member.user.id));
    const activeOthers = activeMembers.filter(
      (member) => !adminIds.has(member.user.id),
    );
    const combined = [...activeAdmins, ...activeOthers];

    // Keep online owner always visible on the map, even when slots are limited.
    if (ownerId) {
      const ownerIndex = combined.findIndex((member) => member.user.id === ownerId);
      if (ownerIndex > 0) {
        const [ownerMember] = combined.splice(ownerIndex, 1);
        combined.unshift(ownerMember);
      }
    }

    return combined.slice(0, MAX_MEMBERS_ON_MAP);
  }, [
    members,
    station?.id,
    station?.owner?.id,
    user?.avatar,
    user?.id,
    user?.username,
  ]);

  const mapMemberMarkers = useMemo(() => {
    const currentUserId = user?.id;
    const currentUsername = user?.username?.trim().toLowerCase();
    const ownerId = station?.owner?.id;
    let otherIndex = 0;

    return mapMembers.map((member) => {
      const isSelf =
        (currentUserId ? member.user.id === currentUserId : false) ||
        (currentUsername
          ? member.user.username.trim().toLowerCase() === currentUsername
          : false);
      const isOwnerMarker = ownerId ? member.user.id === ownerId : false;

      if (isSelf) {
        return { member, x: 50, y: 52, isSelf: true };
      }

      // Keep online owner always visible for listeners in a stable position.
      if (isOwnerMarker) {
        return { member, x: 50, y: 24, isSelf: false };
      }

      const hash = hashString(`${member.user.id}-${otherIndex}`);
      otherIndex += 1;
      // Keep markers inside safer bounds so cards are not clipped by map edges.
      const x = 16 + (hash % 68);
      const y = 22 + ((hash >> 8) % 58);
      return { member, x, y, isSelf: false };
    });
  }, [mapMembers, station?.owner?.id, user?.id, user?.username]);

  const handleToggle = useCallback(() => {
    sendPlaybackControl(isPaused || !isPlaying ? "play" : "pause");
  }, [isPaused, isPlaying, sendPlaybackControl]);

  const handleSkip = useCallback(
    () => sendPlaybackControl("skip"),
    [sendPlaybackControl],
  );
  const handlePrev = useCallback(
    () => sendPlaybackControl("prev"),
    [sendPlaybackControl],
  );
  const handleSeek = useCallback(
    (pos: number) => sendPlaybackControl("seek", pos),
    [sendPlaybackControl],
  );

  const handleToggleLoop = useCallback(() => {
    const next: LoopMode =
      loopMode === "none" ? "track" : loopMode === "track" ? "queue" : "none";
    sendPlaybackControl("set_loop", undefined, next);
  }, [loopMode, sendPlaybackControl]);

  const handleToggleShuffle = useCallback(() => {
    sendPlaybackControl("set_shuffle");
  }, [sendPlaybackControl]);

  const compactNowPlaying =
    contentMode === "station" &&
    (!isTrackInfoVisible || isContentScrolledDown || isPageScrolledDown) &&
    track
      ? `${track.title ?? "Unknown track"} — ${track.artist ?? "Unknown artist"}`
      : "";

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setJoinError("");
    const normalizedPassword = stationPassword.trim();
    if (!normalizedPassword) {
      setJoinError("Введите пароль станции");
      return;
    }
    setIsSubmittingPassword(true);

    try {
      await api.post(`/stations/${code}/join`, {
        password: normalizedPassword,
      });
      setRequiresPassword(false);
      setApprovedJoinPassword(normalizedPassword);
      setCanConnect(true);
    } catch (err: any) {
      const { message, requiresPassword: shouldStayInPasswordMode } =
        getStationJoinError(err);
      setJoinError(message);
      setRequiresPassword(shouldStayInPasswordMode);
    } finally {
      setIsSubmittingPassword(false);
    }
  };

  const updateMemberRole = async (
    targetUserId: string,
    role: MemberRole.ADMIN | MemberRole.LISTENER,
  ) => {
    if (!station?.id) return;
    if (role === MemberRole.ADMIN) {
      const targetMember = members.find(
        (member) => member.user.id === targetUserId,
      );
      const adminsCount = members.filter(
        (member) => member.role === MemberRole.ADMIN,
      ).length;
      const isAlreadyAdmin = targetMember?.role === MemberRole.ADMIN;
      if (!isAlreadyAdmin && adminsCount >= MAX_ADMINS_PER_STATION) {
        setMemberActionError(
          `Максимум ${MAX_ADMINS_PER_STATION} администраторов в станции`,
        );
        return;
      }
    }
    setMemberActionPending(targetUserId);
    setMemberActionError("");
    try {
      await api.put(`/stations/${station.id}/members/${targetUserId}/role`, {
        role,
      });
      setMembers(
        members.map((member) =>
          member.user.id === targetUserId
            ? {
                ...member,
                role,
                permissions:
                  role === MemberRole.ADMIN
                    ? [
                        Permission.PLAYBACK_CONTROL,
                        Permission.SKIP_TRACK,
                        Permission.ADD_TO_QUEUE,
                        Permission.REORDER_QUEUE,
                        Permission.REMOVE_FROM_QUEUE,
                        Permission.UPLOAD_TRACKS,
                        Permission.DELETE_TRACKS,
                        Permission.MANAGE_PLAYLISTS,
                        Permission.MANAGE_MEMBERS,
                        Permission.CHANGE_STATION_SETTINGS,
                      ]
                    : [],
              }
            : member,
        ),
      );
      setMemberMenuUserId(null);
    } catch (err: any) {
      setMemberActionError(formatApiError(err, "Failed to update role"));
    } finally {
      setMemberActionPending(null);
    }
  };

  const togglePlaybackPermission = async (targetUserId: string) => {
    if (!station?.id) return;
    const target = members.find((member) => member.user.id === targetUserId);
    if (!target) return;

    const hasPermission = target.permissions.includes(
      Permission.PLAYBACK_CONTROL,
    );
    const nextPermissions = hasPermission
      ? target.permissions.filter(
          (permission) =>
            permission !== Permission.PLAYBACK_CONTROL &&
            permission !== Permission.SKIP_TRACK,
        )
      : [
          ...new Set([
            ...target.permissions,
            Permission.PLAYBACK_CONTROL,
            Permission.SKIP_TRACK,
          ]),
        ];

    setMemberActionPending(targetUserId);
    setMemberActionError("");
    try {
      await api.put(
        `/stations/${station.id}/members/${targetUserId}/permissions`,
        {
          permissions: nextPermissions,
        },
      );
      setMembers(
        members.map((member) =>
          member.user.id === targetUserId
            ? { ...member, permissions: nextPermissions }
            : member,
        ),
      );
      setMemberMenuUserId(null);
    } catch (err: any) {
      setMemberActionError(formatApiError(err, "Failed to update permissions"));
    } finally {
      setMemberActionPending(null);
    }
  };

  const kickMember = async (targetUserId: string) => {
    if (!station?.id) return;
    setMemberActionPending(targetUserId);
    setMemberActionError("");
    try {
      await api.delete(`/stations/${station.id}/members/${targetUserId}`);
      setMembers(members.filter((member) => member.user.id !== targetUserId));
      setMemberMenuUserId(null);
    } catch (err: any) {
      setMemberActionError(formatApiError(err, "Failed to remove member"));
    } finally {
      setMemberActionPending(null);
    }
  };

  if (isJoinChecking) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: "var(--bg)" }}
      >
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col items-center gap-4"
        >
          <div
            className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin"
            style={{
              borderColor:
                "var(--color-accent) transparent transparent transparent",
            }}
          />
          <p className="text-sm text-[--text-muted]">
            Checking station access…
          </p>
        </motion.div>
      </div>
    );
  }

  if (requiresPassword && !canConnect) {
    return (
      <div
        className="min-h-screen flex items-center justify-center px-6"
        style={{ background: "var(--bg)" }}
      >
        <div className="w-full max-w-3xl text-left">
          <h1 className="text-4xl sm:text-5xl font-semibold text-[--text-primary] leading-tight">
            Station password required
          </h1>
          <p className="text-base sm:text-lg text-[--text-muted] mt-2">
            This station is protected. Enter password to continue.
          </p>

          <form
            onSubmit={handlePasswordSubmit}
            className="mt-8 space-y-4 w-full"
          >
            <Input
              label="Password"
              type="password"
              value={stationPassword}
              onChange={(e) => {
                setStationPassword(e.target.value);
                if (joinError) setJoinError("");
              }}
              placeholder="Enter station password"
              required
            />

            {joinError && (
              <p className="text-sm text-red-400">
                {joinError}
              </p>
            )}

            <div className="grid grid-cols-2 gap-2 w-full">
              <Button
                type="submit"
                className="w-full"
                isLoading={isSubmittingPassword}
                style={{ border: "1px solid var(--border)" }}
              >
                Join station
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                onClick={() => router.push("/dashboard")}
                style={{ border: "1px solid var(--border)" }}
              >
                Back to dashboard
              </Button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  if (joinError && !canConnect) {
    return (
      <div
        className="min-h-screen flex items-center justify-center px-6"
        style={{ background: "var(--bg)" }}
      >
        <div className="w-full max-w-3xl text-left">
          <h1 className="text-4xl sm:text-5xl font-semibold text-[--text-primary] leading-tight">
            Could not join station
          </h1>
          <p className="text-base sm:text-lg text-[--text-muted] mt-2">
            There was a problem connecting to this station.
          </p>
          <p className="text-base text-red-400 mt-3">{joinError}</p>
          <div className="mt-8 w-full grid grid-cols-2 gap-2">
            <Button
              className="w-full"
              onClick={() => setJoinAttempt((v) => v + 1)}
              style={{ border: "1px solid var(--border)" }}
            >
              Try again
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              onClick={() => router.push("/dashboard")}
              style={{ border: "1px solid var(--border)" }}
            >
              Back to dashboard
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (guestListenState && !user) {
    return (
      <ListenOnlyPageShell
        homeHref="/"
        stationCode={guestListenState.code ?? code}
        stationName={guestListenState.name}
        stationDescription={guestListenState.description}
        isPlaying={
          !!guestListenState.currentTrackId && !guestListenState.isPaused
        }
        isPaused={!!guestListenState.isPaused}
        showChatMessages={false}
        showChatInput={false}
      >
        <PublicListenPlayer
          code={code}
          initialState={{
            code: guestListenState.code,
            name: guestListenState.name,
            listenerCount: guestListenState.listenerCount ?? 0,
            accessMode: guestListenState.accessMode,
            isPasswordProtected: guestListenState.isPasswordProtected,
            currentTrackId: guestListenState.currentTrackId,
            currentTrack: guestListenState.currentTrack ?? null,
            currentPosition: guestListenState.currentPosition ?? 0,
            isPaused: guestListenState.isPaused ?? false,
            trackStartedAt: guestListenState.trackStartedAt ?? null,
            pausedPosition: guestListenState.pausedPosition ?? 0,
          }}
        />
      </ListenOnlyPageShell>
    );
  }

  if (isConnecting) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: "var(--bg)" }}
      >
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col items-center gap-4"
        >
          <div
            className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin"
            style={{
              borderColor:
                "var(--color-accent) transparent transparent transparent",
            }}
          />
          <p className="text-sm text-[--text-muted]">Connecting…</p>
        </motion.div>
      </div>
    );
  }

  if (station && !canControl) {
    return (
      <ListenOnlyPageShell
        homeHref={user ? "/dashboard" : "/"}
        stationCode={station?.code ?? code}
        stationName={station?.name}
        stationDescription={station?.description}
        isPlaying={isPlaying}
        isPaused={isPaused}
        showConnectionDot
        isConnected={isConnected}
        messages={chat}
        onSendMessage={sendChatMessage}
        currentUserId={user?.id}
        showChatMessages
        showChatInput
      >
        {track ? (
          <ListenOnlyPlayerCard
            track={track}
            currentPosition={playback.currentPosition}
            isPaused={isPaused}
            isPlaying={isPlaying}
            listenerCount={station?.listenerCount ?? 0}
            stationName={station?.name ?? ""}
            stationCode={station?.code ?? code}
            audioNeedsRestart={audioNeedsRestart}
            onRestartAudio={restartAudio}
          />
        ) : (
          <p className="text-xs text-[--text-muted] mt-6">
            Сейчас ничего не играет.
          </p>
        )}
      </ListenOnlyPageShell>
    );
  }

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: "var(--bg)" }}
    >
      {/* Navbar */}
      <header
        className="sticky top-0 z-50 relative flex items-center justify-between px-5 h-13 lg:ml-[340px]"
        style={{
          background: "var(--bg-elevated)",
          borderBottom: "1px solid var(--border)",
          backdropFilter: "blur(12px)",
        }}
      >
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="flex items-center gap-3"
            title="Go to stations list"
          >
            <div
              className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: "var(--color-accent)" }}
            >
              <Radio size={12} style={{ color: "var(--bg)" }} />
            </div>
            <span className="font-semibold text-[--text-primary] text-sm tracking-[0.08em]">
              PINE
            </span>
          </button>
          <div
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{
              background: isConnected ? "#22c55e" : "var(--text-muted)",
              boxShadow: isConnected ? "0 0 5px #22c55e70" : "none",
            }}
          />
        </div>

        <div className="flex items-center gap-1.5">
          <HeaderVolumeControl />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {mounted &&
              (theme === "dark" ? <Sun size={14} /> : <Moon size={14} />)}
          </Button>
          {(isOwner || isAdmin) && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() =>
                setContentMode((v) =>
                  v === "settings" ? "station" : "settings",
                )
              }
              className={
                contentMode === "settings"
                  ? "bg-[--bg-subtle] text-[--text-primary]"
                  : ""
              }
            >
              <Settings size={14} />
            </Button>
          )}
        </div>
        {compactNowPlaying && (
          <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 max-w-[62%] px-4">
            <p className="truncate text-center text-sm font-semibold text-[--text-primary]">
              {compactNowPlaying}
            </p>
          </div>
        )}
      </header>

      {/* Main layout */}
      <div className="flex flex-1 overflow-hidden lg:ml-[340px]">
        {/* Left: pure animation panel (desktop) */}
        <aside
          className="hidden lg:flex fixed left-0 top-0 h-screen w-[340px] flex-col min-h-0 z-40"
          style={{ borderRight: "1px solid var(--border)" }}
        >
          <div className="flex-1 min-h-0">
            <LeftPanel
              isPlaying={isPlaying}
              isPaused={isPaused}
              stationCode={station?.code ?? code}
              stationName={station?.name}
              stationDescription={station?.description}
              messages={chat}
              onSendMessage={sendChatMessage}
              currentUserId={user?.id}
            />
          </div>
        </aside>

        {/* Right: info + tabs */}
        <div className="flex flex-1 flex-col overflow-hidden min-w-0">
          {contentMode === "settings" ? (
            <SettingsPanel
              station={{
                id: station?.id ?? "",
                code: station?.code ?? code,
                name: station?.name ?? "",
                description: station?.description ?? null,
                accessMode: station?.accessMode ?? "PRIVATE",
                isPasswordProtected: station?.isPasswordProtected ?? false,
                crossfadeDuration: station?.crossfadeDuration ?? 3,
                streamQuality: station?.streamQuality ?? "HIGH",
              }}
              onBack={() => setContentMode("station")}
              onSaved={(patch) => {
                if (!station) return;
                setStation({ ...station, ...patch });
              }}
            />
          ) : contentMode === "add-tracks" ? (
            <AddTracksPanel
              stationId={station?.id ?? ""}
              activePlaylistId={station?.activePlaylistId ?? null}
              currentTrackId={track?.id}
              initialPlaylistId={managedPlaylistId}
              onBack={() => setContentMode("station")}
              onActivePlaylistChange={(playlistId) => {
                if (!station) return;
                setStation({ ...station, activePlaylistId: playlistId });
              }}
            />
          ) : (
            <>
              {/* Track info + controls */}
              <div
                ref={trackInfoRef}
                style={{
                  borderBottom: "1px solid var(--border)",
                  background: "var(--bg-elevated)",
                }}
              >
                <TrackInfo
                  track={track}
                  currentQueueType={playback.currentQueueType}
                  currentPosition={playback.currentPosition}
                  isPaused={isPaused}
                  isPlaying={isPlaying}
                  listenerCount={station?.listenerCount ?? 0}
                  stationName={station?.name ?? ""}
                  stationCode={station?.code ?? code}
                  canControl={canControl}
                  audioNeedsRestart={audioNeedsRestart}
                  loopMode={loopMode}
                  shuffleEnabled={shuffleEnabled}
                  onPlayPause={handleToggle}
                  onRestartAudio={restartAudio}
                  onSkip={handleSkip}
                  onPrev={handlePrev}
                  onSeek={handleSeek}
                  onToggleLoop={handleToggleLoop}
                  onToggleShuffle={handleToggleShuffle}
                />
              </div>

              {/* Tabs */}
              <div
                className="flex items-center gap-0 px-1"
                style={{
                  borderBottom: "1px solid var(--border)",
                  background: "var(--bg-elevated)",
                }}
              >
                {TABS.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`relative flex items-center gap-1.5 px-4 py-3 text-[13px] font-medium transition-colors ${
                      activeTab === tab.id
                        ? "text-[--text-primary]"
                        : "text-[--text-muted] hover:text-[--text-secondary]"
                    }`}
                  >
                    {tab.icon}
                    {tab.label}
                    {tab.id === "queue" && userQueueCount > 0 && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded-full leading-none"
                        style={{
                          background: "var(--color-accent)",
                          color: "var(--bg)",
                        }}
                      >
                        {userQueueCount}
                      </span>
                    )}
                    {activeTab === tab.id && (
                      <motion.div
                        layoutId="tab-indicator"
                        className="absolute inset-x-0 bottom-0 h-0.5 rounded-full"
                        style={{ background: "var(--color-accent)" }}
                      />
                    )}
                  </button>
                ))}
              </div>

              {/* Tab content */}
              <div
                ref={contentScrollRef}
                className="flex-1 overflow-y-auto"
                style={{ background: "var(--bg)" }}
              >
                <AnimatePresence mode="wait" initial={false}>
                  {activeTab === "queue" && (
                    <motion.div
                      key="queue"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.12 }}
                      className="p-4"
                    >
                      <QueueLibraryPanel
                        stationId={station?.id ?? ""}
                        activePlaylistId={station?.activePlaylistId ?? null}
                        currentTrackId={track?.id}
                        queue={queue}
                        canControl={canControl}
                        shuffleEnabled={shuffleEnabled}
                        onQueueReorder={reorderQueue}
                        onAddToQueue={addToQueue}
                        onRemoveFromQueue={removeFromQueue}
                        onOpenFolderManage={(playlistId) => {
                          setManagedPlaylistId(playlistId);
                          setContentMode("add-tracks");
                        }}
                        onActivePlaylistChange={(playlistId) => {
                          if (!station) return;
                          setStation({
                            ...station,
                            activePlaylistId: playlistId,
                          });
                        }}
                      />
                    </motion.div>
                  )}

                  {activeTab === "members" && (
                    <motion.div
                      key="members"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.12 }}
                      className="px-4 pb-4 space-y-3"
                    >
                      {memberActionError && (
                        <p className="text-xs text-red-400 bg-red-400/10 px-3 py-2 rounded-xl">
                          {memberActionError}
                        </p>
                      )}
                      <div className="relative h-[300px] overflow-hidden -mx-4">
                        <div
                          className="absolute inset-0"
                          aria-hidden
                          style={{ background: "var(--bg)" }}
                        />
                        <div
                          className="absolute inset-0"
                          aria-hidden
                          style={{
                            background:
                              "radial-gradient(900px 540px at 18% 24%, rgba(232,68,15,0.10), transparent 58%), radial-gradient(800px 500px at 82% 74%, rgba(120,120,120,0.08), transparent 62%), linear-gradient(180deg, rgba(255,255,255,0.08), rgba(0,0,0,0.02))",
                          }}
                        />
                        <div
                          className="absolute inset-0 opacity-60"
                          aria-hidden
                          style={{
                            backgroundImage:
                              "linear-gradient(to right, var(--border-light) 1px, transparent 1px), linear-gradient(to bottom, var(--border-light) 1px, transparent 1px)",
                            backgroundSize: "28px 28px",
                          }}
                        />
                        {mapMemberMarkers.length === 0 ? (
                          <div className="absolute inset-0 flex items-center justify-center text-[--text-muted]">
                            <p className="text-sm">No active members for map</p>
                          </div>
                        ) : (
                          <div className="absolute inset-0">
                            {mapMemberMarkers.map(
                              ({ member, x, y, isSelf }, idx) => (
                                <motion.div
                                  key={`map-${member.user.id}`}
                                  initial={{ opacity: 0, y: 6 }}
                                  animate={{ opacity: 1, y: 0 }}
                                  transition={{
                                    duration: 0.2,
                                    delay: idx * 0.03,
                                  }}
                                  className="absolute flex items-center gap-2"
                                  style={{
                                    left: `${x}%`,
                                    top: `${y}%`,
                                    transform: "translate(-50%, -50%)",
                                    zIndex: isSelf ? 20 : 10,
                                  }}
                                >
                                  <span
                                    className="w-2.5 h-2.5 rounded-full"
                                    style={{
                                      background: "#E8440F",

                                      boxShadow: "0 0 8px rgba(232,68,15,0.75)",
                                    }}
                                  />
                                  <div
                                    className="max-w-[190px] rounded-xl pl-2 pr-2 py-2 flex items-center gap-2"
                                    style={{
                                      background: "var(--bg-elevated)",
                                      border: "1px solid var(--border)",
                                    }}
                                  >
                                    <div
                                      className="w-7 h-7 rounded-full overflow-hidden flex items-center justify-center text-[10px] font-semibold text-[--text-secondary]"
                                      style={{ background: "var(--bg-subtle)" }}
                                    >
                                      {member.user.avatar ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img
                                          src={member.user.avatar}
                                          alt={member.user.username}
                                          className="w-full h-full object-cover"
                                        />
                                      ) : (
                                        member.user.username
                                          .slice(0, 2)
                                          .toUpperCase()
                                      )}
                                    </div>
                                    <p className="text-xs font-medium text-[--text-primary] truncate">
                                      {member.user.username}
                                      {isSelf ? " (you)" : ""}
                                    </p>
                                  </div>
                                </motion.div>
                              ),
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex justify-end">
                        <div className="relative w-[220px] max-w-full">
                          <Search
                            size={14}
                            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[--text-muted]"
                          />
                          <input
                            data-no-focus-ring="true"
                            type="text"
                            value={memberSearch}
                            onChange={(e) => setMemberSearch(e.target.value)}
                            placeholder="search"
                            className="h-8 w-full rounded-lg !border-0 border-none pl-8 pr-8 text-sm text-[--text-primary] placeholder:text-[--text-muted] !outline-none transition-all focus:!border-0 focus:!outline-none focus-visible:!border-0 focus-visible:!outline-none focus:ring-0 focus-visible:ring-0"
                            style={{
                              background: "transparent",
                              border: "none",
                              outline: "none",
                              boxShadow: "none",
                            }}
                          />
                          {memberSearch && (
                            <button
                              type="button"
                              onClick={() => setMemberSearch("")}
                              className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-md text-[--text-muted] hover:bg-[--bg-elevated] hover:text-[--text-primary]"
                              title="Clear search"
                            >
                              <X size={13} />
                            </button>
                          )}
                        </div>
                      </div>

                      {members.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-[--text-muted]">
                          <Users2 size={28} className="mb-2 opacity-30" />
                          <p className="text-sm">No members</p>
                        </div>
                      ) : filteredMembers.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-[--text-muted]">
                          <Search size={24} className="mb-2 opacity-30" />
                          <p className="text-sm">No members found</p>
                        </div>
                      ) : (
                        filteredMembers.map((m: StationMember) => {
                          const isSelf = m.user.id === user?.id;
                          const hasPlayback = m.permissions?.includes(
                            Permission.PLAYBACK_CONTROL,
                          );
                          const canShowActions =
                            canManageMembers &&
                            !isSelf &&
                            m.role !== MemberRole.OWNER;
                          const roleLabel = getRoleLabel(m.role);

                          return (
                            <div
                              key={m.id}
                              className="relative flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-[--bg-elevated] transition-colors"
                            >
                              <div
                                className="relative w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-[--text-secondary] flex-shrink-0 overflow-hidden"
                                style={{ background: "var(--bg-subtle)" }}
                              >
                                {m.user.avatar ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={m.user.avatar}
                                    alt={m.user.username}
                                    className="w-full h-full object-cover"
                                  />
                                ) : (
                                  m.user.username.slice(0, 2).toUpperCase()
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-[--text-primary] truncate flex items-center gap-2">
                                  <span className="truncate">
                                    {m.user.username}
                                  </span>
                                  <span
                                    className="text-xs font-semibold shrink-0"
                                    style={{
                                      color: m.isOnline
                                        ? "#E8440F"
                                        : "var(--text-muted)",
                                    }}
                                  >
                                    ({m.isOnline ? "active" : "innactive"})
                                  </span>
                                </p>
                                <p className="text-xs text-[--text-muted] truncate">
                                  {roleLabel}
                                  {hasPlayback ? " • Playback access" : ""}
                                </p>
                              </div>
                              {canShowActions && (
                                <button
                                  type="button"
                                  className="h-8 w-8 rounded-lg flex items-center justify-center text-[--text-muted] hover:text-[--text-primary] hover:bg-[--bg-subtle]"
                                  onClick={() =>
                                    setMemberMenuUserId((v) =>
                                      v === m.user.id ? null : m.user.id,
                                    )
                                  }
                                >
                                  <MoreHorizontal size={14} />
                                </button>
                              )}

                              {canShowActions &&
                                memberMenuUserId === m.user.id && (
                                  <div
                                    className="absolute right-3 top-12 z-20 w-56 rounded-xl p-1"
                                    style={{
                                      background: "var(--bg-elevated)",
                                      border: "1px solid var(--border)",
                                      boxShadow: "var(--shadow-md)",
                                    }}
                                  >
                                    {m.role !== MemberRole.ADMIN && (
                                      <button
                                        type="button"
                                        className="w-full text-left px-3 py-2 rounded-lg text-sm text-[--text-primary] hover:bg-[--bg-subtle] flex items-center gap-2.5"
                                        disabled={
                                          memberActionPending === m.user.id
                                        }
                                        onClick={() =>
                                          updateMemberRole(
                                            m.user.id,
                                            MemberRole.ADMIN,
                                          )
                                        }
                                      >
                                        <ShieldCheck
                                          size={14}
                                          className="text-[--text-muted]"
                                        />
                                        Make admin
                                      </button>
                                    )}
                                    {m.role !== MemberRole.LISTENER && (
                                      <button
                                        type="button"
                                        className="w-full text-left px-3 py-2 rounded-lg text-sm text-[--text-primary] hover:bg-[--bg-subtle] flex items-center gap-2.5"
                                        disabled={
                                          memberActionPending === m.user.id
                                        }
                                        onClick={() =>
                                          updateMemberRole(
                                            m.user.id,
                                            MemberRole.LISTENER,
                                          )
                                        }
                                      >
                                        <UserRound
                                          size={14}
                                          className="text-[--text-muted]"
                                        />
                                        Make listener
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      className="w-full text-left px-3 py-2 rounded-lg text-sm text-[--text-primary] hover:bg-[--bg-subtle] flex items-center gap-2.5"
                                      disabled={
                                        memberActionPending === m.user.id
                                      }
                                      onClick={() =>
                                        togglePlaybackPermission(m.user.id)
                                      }
                                    >
                                      {hasPlayback ? (
                                        <X
                                          size={14}
                                          className="text-[--text-muted]"
                                        />
                                      ) : (
                                        <Play
                                          size={14}
                                          className="text-[--text-muted]"
                                        />
                                      )}
                                      {hasPlayback
                                        ? "Remove playback rights"
                                        : "Allow playback edit"}
                                    </button>
                                    <button
                                      type="button"
                                      className="w-full text-left px-3 py-2 rounded-lg text-sm text-red-400 hover:bg-red-500/10 flex items-center gap-2.5"
                                      disabled={
                                        memberActionPending === m.user.id
                                      }
                                      onClick={() => kickMember(m.user.id)}
                                    >
                                      <UserX size={14} />
                                      Remove from station
                                    </button>
                                  </div>
                                )}
                            </div>
                          );
                        })
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
