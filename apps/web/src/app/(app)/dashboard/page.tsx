"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/auth.store";
import { Button } from "@/components/ui/button";
import api from "@/lib/api";
import { Radio, LogOut, Search, Plus, X, TreePine } from "lucide-react";

interface StationListItem {
  id: string;
  code: string;
  name: string;
  isLive?: boolean;
  currentTrackId?: string | null;
  isPaused?: boolean;
}

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return h >>> 0;
}

function createRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_MAP_STATIONS = 10;
const MAX_OWN_STATIONS = 5;
const ACTIVE_MARKER_COLOR = "#E8440F";
const INACTIVE_MARKER_COLOR = "#FFFFFF";

export default function DashboardPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, logout } = useAuthStore();
  const [publicSeed] = useState(() => Math.floor(Math.random() * 1_000_000_000));
  const [search, setSearch] = useState("");
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newStationName, setNewStationName] = useState("");
  const [newStationDescription, setNewStationDescription] = useState("");
  const [createError, setCreateError] = useState("");
  const mapAreaRef = useRef<HTMLDivElement | null>(null);
  const [mapArea, setMapArea] = useState({ width: 1280, height: 640 });

  useEffect(() => {
    const root = document.documentElement;
    const hadDark = root.classList.contains("dark");
    root.classList.add("dark");
    return () => {
      if (!hadDark) root.classList.remove("dark");
    };
  }, []);

  useEffect(() => {
    const node = mapAreaRef.current;
    if (!node) return;

    const updateSize = () => {
      const rect = node.getBoundingClientRect();
      setMapArea({
        width: Math.max(320, Math.round(rect.width)),
        height: Math.max(260, Math.round(rect.height)),
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(node);
    window.addEventListener("resize", updateSize);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateSize);
    };
  }, []);

  const { data: myStations = [], isLoading: loadingMy } = useQuery({
    queryKey: ["my-stations"],
    queryFn: () =>
      api.get("/stations/my").then((r) => r.data as StationListItem[]),
    enabled: !!user,
  });

  const { data: discoverStations = [], isLoading: loadingDiscover } = useQuery({
    queryKey: ["discover-stations"],
    queryFn: () =>
      api.get("/stations/discover").then((r) => r.data as StationListItem[]),
    enabled: !!user,
  });

  const allStations = useMemo(() => {
    const map = new Map<string, StationListItem>();
    for (const s of [...myStations, ...discoverStations]) map.set(s.id, s);
    return Array.from(map.values()).sort(
      (a, b) => hashString(a.id) - hashString(b.id),
    );
  }, [myStations, discoverStations]);

  const ownStations = useMemo(
    () => myStations.slice(0, MAX_OWN_STATIONS),
    [myStations],
  );

  const randomPublicStations = useMemo(() => {
    const ownedIds = new Set(ownStations.map((s) => s.id));
    return [...discoverStations]
      .filter((s) => !ownedIds.has(s.id))
      .sort(
        (a, b) =>
          hashString(`${a.id}-${publicSeed}`) - hashString(`${b.id}-${publicSeed}`),
      );
  }, [discoverStations, ownStations, publicSeed]);

  const defaultMapStations = useMemo(() => {
    const publicSlots = Math.max(0, MAX_MAP_STATIONS - ownStations.length);
    return [...ownStations, ...randomPublicStations.slice(0, publicSlots)];
  }, [ownStations, randomPublicStations]);

  const activeStationIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of discoverStations) ids.add(s.id);
    for (const s of myStations) {
      if (s.isLive || s.currentTrackId) ids.add(s.id);
    }
    return ids;
  }, [discoverStations, myStations]);

  const filteredStations = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return defaultMapStations;
    const ownIds = new Set(ownStations.map((s) => s.id));
    const matched = allStations.filter(
      (s) => s.name.toLowerCase().includes(q) || s.code.includes(q),
    );
    const matchedOwn = ownStations.filter(
      (s) => s.name.toLowerCase().includes(q) || s.code.includes(q),
    );
    const matchedPublic = matched.filter((s) => !ownIds.has(s.id));
    return [...matchedOwn, ...matchedPublic].slice(0, MAX_MAP_STATIONS);
  }, [allStations, defaultMapStations, ownStations, search]);

  const plottedStations = useMemo(() => {
    if (filteredStations.length === 0) return [];

    const count = filteredStations.length;
    if (count === 1) {
      return [{ station: filteredStations[0], x: 50, y: 52 }];
    }

    const mapWidth = Math.max(320, mapArea.width);
    const mapHeight = Math.max(260, mapArea.height);
    const markerHalfWidth = Math.min(150, Math.max(92, mapWidth * 0.14));
    const sidePad = Math.max(16, markerHalfWidth + 10);
    const verticalPad = Math.max(18, Math.min(48, mapHeight * 0.07));
    const minX = sidePad;
    const maxX = Math.max(sidePad + 1, mapWidth - sidePad);
    const minY = verticalPad;
    const maxY = Math.max(verticalPad + 1, mapHeight - verticalPad);
    const rangeX = Math.max(1, maxX - minX);
    const rangeY = Math.max(1, maxY - minY);
    const rng = createRng(hashString(`stations-grid-${publicSeed}-${count}`));
    const xSlots = Array.from({ length: count }, (_, i) => i);
    const ySlots = Array.from({ length: count }, (_, i) => i);
    for (let i = count - 1; i > 0; i--) {
      const jx = Math.floor(rng() * (i + 1));
      const jy = Math.floor(rng() * (i + 1));
      [xSlots[i], xSlots[jx]] = [xSlots[jx], xSlots[i]];
      [ySlots[i], ySlots[jy]] = [ySlots[jy], ySlots[i]];
    }

    const binW = rangeX / count;
    const binH = rangeY / count;
    const jitterXMax = Math.max(4, binW * 0.4);
    const jitterYMax = Math.max(4, binH * 0.4);

    const points = filteredStations.map((station, idx) => {
      const xCenter = minX + (xSlots[idx] + 0.5) * binW;
      const yCenter = minY + (ySlots[idx] + 0.5) * binH;
      const x = Math.max(minX, Math.min(maxX, xCenter + (rng() * 2 - 1) * jitterXMax));
      const y = Math.max(minY, Math.min(maxY, yCenter + (rng() * 2 - 1) * jitterYMax));
      return { station, x, y };
    });

    // Lightweight overlap resolver in case two points are too close after jitter.
    const minDx = Math.max(70, Math.min(140, rangeX / Math.max(2, count - 1)));
    const minDy = Math.max(44, Math.min(96, rangeY / Math.max(2, count - 1)));
    for (let iter = 0; iter < 10; iter++) {
      let moved = false;
      for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
          const a = points[i];
          const b = points[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const absDx = Math.abs(dx);
          const absDy = Math.abs(dy);
          if (absDx >= minDx || absDy >= minDy) continue;

          moved = true;
          const pushX = (minDx - absDx) * 0.5;
          const pushY = (minDy - absDy) * 0.5;
          const dirX = dx === 0 ? (rng() > 0.5 ? 1 : -1) : Math.sign(dx);
          const dirY = dy === 0 ? (rng() > 0.5 ? 1 : -1) : Math.sign(dy);

          a.x = Math.max(minX, Math.min(maxX, a.x - (pushX * dirX) / 2));
          b.x = Math.max(minX, Math.min(maxX, b.x + (pushX * dirX) / 2));
          a.y = Math.max(minY, Math.min(maxY, a.y - (pushY * dirY) / 2));
          b.y = Math.max(minY, Math.min(maxY, b.y + (pushY * dirY) / 2));
        }
      }
      if (!moved) break;
    }

    return points.map((p) => ({
      station: p.station,
      x: (p.x / mapWidth) * 100,
      y: (p.y / mapHeight) * 100,
    }));
  }, [filteredStations, publicSeed, mapArea.height, mapArea.width]);
  const mapTrees = useMemo(
    () =>
      Array.from({ length: 18 }, (_, idx) => {
        const h = hashString(`tree-${publicSeed}-${idx}`);
        return {
          id: `tree-${idx}`,
          x: 4 + (h % 92),
          y: 16 + ((h >> 8) % 76),
          size: 22 + ((h >> 16) % 11),
          opacity: 0.28 + ((h >> 20) % 10) / 100,
        };
      }),
    [publicSeed],
  );

  const isLoading = loadingMy || loadingDiscover;
  const canCreateStation = newStationName.trim().length >= 2;

  const createStationMutation = useMutation({
    mutationFn: () =>
      api
        .post("/stations", {
          name: newStationName.trim(),
          description: newStationDescription.trim() || undefined,
        })
        .then((r) => r.data as StationListItem),
    onSuccess: async (createdStation) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["my-stations"] }),
        queryClient.invalidateQueries({ queryKey: ["discover-stations"] }),
      ]);
      setIsCreateModalOpen(false);
      setNewStationName("");
      setNewStationDescription("");
      setCreateError("");
      router.push(`/station/${createdStation.code}`);
    },
    onError: (err: any) => {
      setCreateError(
        err?.response?.data?.message ?? "Failed to create station",
      );
    },
  });

  async function handleLogout() {
    await logout();
    router.push("/login");
  }

  const handleSearchSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const normalized = search.replace(/\D/g, "");

    const foundByCode = plottedStations.find(
      (s) => s.station.code === normalized,
    );
    if (foundByCode) {
      router.push(`/station/${foundByCode.station.code}`);
      return;
    }

    if (normalized.length === 6) {
      router.push(`/station/${normalized}`);
      return;
    }

  };

  const handleCreateSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canCreateStation || createStationMutation.isPending) return;
    setCreateError("");
    await createStationMutation.mutateAsync();
  };

  return (
    <div
      className="min-h-screen h-[100dvh] flex flex-col overflow-hidden"
      style={{ background: "var(--bg)" }}
    >
      <header
        className="sticky top-0 z-50 flex items-center justify-between px-5 h-13"
        style={{
          background: "var(--bg-elevated)",
          borderBottom: "1px solid var(--border)",
          backdropFilter: "blur(12px)",
        }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: "var(--color-accent)" }}
          >
            <Radio size={12} style={{ color: "var(--bg)" }} />
          </div>
          <span className="font-semibold text-[--text-primary] text-sm tracking-[0.08em]">
            PINE
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-xs text-[--text-muted] mr-2">
            {user?.username}
          </span>
          <Button variant="ghost" size="icon-sm" onClick={handleLogout}>
            <LogOut size={14} />
          </Button>
        </div>
      </header>

      <main className="flex-1 min-h-0 relative overflow-hidden flex flex-col">
        <div className="absolute inset-0" aria-hidden style={{ background: "var(--bg)" }} />
        <div
          className="absolute inset-0 opacity-60"
          aria-hidden
          style={{
            backgroundImage:
              "linear-gradient(to right, var(--border-light) 1px, transparent 1px), linear-gradient(to bottom, var(--border-light) 1px, transparent 1px)",
            backgroundSize: "28px 28px",
          }}
        />
        <div className="absolute inset-0 z-10 pointer-events-none" aria-hidden>
          {mapTrees.map((tree) => (
            <div
              key={tree.id}
              className="absolute"
              style={{
                left: `${tree.x}%`,
                top: `${tree.y}%`,
                transform: "translate(-50%, -50%)",
                opacity: tree.opacity,
              }}
            >
              <div
                className="flex items-center justify-center rounded-md"
                style={{
                  width: tree.size + 8,
                  height: tree.size + 8,
                  background: "var(--bg)",
                }}
              >
                <TreePine
                  size={tree.size}
                  style={{ color: "var(--text-muted)" }}
                  strokeWidth={2.1}
                />
              </div>
            </div>
          ))}
        </div>

        <div className="relative z-20 flex-1 min-h-0 flex flex-col">
          <div className="px-5 py-4">
            <div className="w-full max-w-[900px] flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <form
                onSubmit={handleSearchSubmit}
                className="w-full sm:flex-1 h-11 rounded-xl flex items-center gap-2 px-3 focus-within:outline-none focus-within:ring-0"
                style={{
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border)",
                  boxShadow: "none",
                  outline: "none",
                }}
              >
                <Search size={14} className="text-[--text-muted] shrink-0" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by station name or paste 6-digit code"
                  className="w-full text-sm bg-transparent text-[--text-primary] placeholder:text-[--text-muted] outline-none focus:outline-none focus-visible:outline-none ring-0 focus:ring-0 focus-visible:ring-0"
                  style={{ outline: "none", boxShadow: "none" }}
                />
              </form>
              <Button
                type="button"
                className="h-11 px-4 w-full sm:w-auto sm:shrink-0"
                onClick={() => {
                  setCreateError("");
                  setIsCreateModalOpen(true);
                }}
              >
                <Plus size={14} />
                New Station
              </Button>
            </div>
          </div>

          <div ref={mapAreaRef} className="relative flex-1 min-h-0">
            {!isLoading && plottedStations.length > 0 && (
              <div className="absolute inset-0 z-10 pointer-events-none">
                {plottedStations.map(({ station, x, y }, i) => (
                  <motion.button
                    key={station.id}
                    type="button"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, delay: i * 0.02 }}
                    onClick={() => router.push(`/station/${station.code}`)}
                    className="absolute pointer-events-auto group"
                    style={{
                      left: `${x}%`,
                      top: `${y}%`,
                      transform: "translate(-50%, -50%)",
                    }}
                  >
                    <div className="flex items-center gap-2">
                      {(() => {
                        const isActive =
                          activeStationIds.has(station.id) ||
                          !!station.isLive ||
                          !!station.currentTrackId;
                        const dotColor = isActive
                          ? ACTIVE_MARKER_COLOR
                          : INACTIVE_MARKER_COLOR;
                        const dotShadow = isActive
                          ? "0 0 10px rgba(232,68,15,0.7)"
                          : "0 0 0 rgba(0,0,0,0)";
                        const pulseColor = "rgba(232,68,15,0.4)";

                        return (
                          <span className="relative flex h-2.5 w-2.5">
                            {isActive && (
                              <>
                                <motion.span
                                  className="absolute inset-0 rounded-full"
                                  style={{ background: pulseColor }}
                                  animate={{ scale: [1, 2], opacity: [0.7, 0] }}
                                  transition={{
                                    duration: 1.2,
                                    repeat: Infinity,
                                    ease: "easeOut",
                                  }}
                                />
                                <motion.span
                                  className="absolute inset-0 rounded-full"
                                  style={{ background: pulseColor }}
                                  animate={{ scale: [1, 2], opacity: [0.55, 0] }}
                                  transition={{
                                    duration: 1.2,
                                    repeat: Infinity,
                                    ease: "easeOut",
                                    delay: 0.6,
                                  }}
                                />
                              </>
                            )}
                            <span
                              className="relative h-2.5 w-2.5 rounded-full"
                              style={{
                                background: dotColor,
                                boxShadow: dotShadow,
                              }}
                            />
                          </span>
                        );
                      })()}
                      <div
                        className="max-w-[230px] rounded-xl pl-1 pr-2 py-1.5 flex items-center gap-2 text-left transition-colors"
                        style={{
                          background: "var(--bg-elevated)",
                          border: "1px solid var(--border)",
                        }}
                      >
                        <div
                          className="w-7 h-7 rounded-full flex items-center justify-center"
                          style={{ background: "var(--bg-subtle)" }}
                        >
                          <Radio size={12} style={{ color: "var(--color-accent)" }} />
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-[--text-primary] truncate group-hover:text-[--color-accent]">
                            {station.name}
                          </p>
                          <p className="text-[10px] text-[--text-muted] font-mono">
                            #{station.code}
                          </p>
                        </div>
                      </div>
                    </div>
                  </motion.button>
                ))}
              </div>
            )}

            {isLoading ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-5 h-5 border-2 border-[--color-accent] border-t-transparent rounded-full animate-spin" />
              </div>
            ) : plottedStations.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
                <p className="text-sm text-[--text-muted]">
                  No stations found for this query.
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </main>

      <AnimatePresence>
        {isCreateModalOpen && (
          <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
            <motion.button
              type="button"
              aria-label="Close"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/60"
              onClick={() => {
                if (createStationMutation.isPending) return;
                setIsCreateModalOpen(false);
                setCreateError("");
              }}
            />

            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 10 }}
              transition={{ duration: 0.18 }}
              className="relative z-10 w-full max-w-xl rounded-2xl overflow-hidden"
              style={{
                background: "var(--bg-elevated)",
                border: "1px solid var(--border)",
              }}
            >
              <div
                className="px-5 py-4 flex items-center justify-between"
                style={{ borderBottom: "1px solid var(--border)" }}
              >
                <div>
                  <p className="text-base font-semibold text-[--text-primary]">
                    Create New Station
                  </p>
                  <p className="text-xs text-[--text-muted] mt-0.5">
                    Set station name and description.
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    if (createStationMutation.isPending) return;
                    setIsCreateModalOpen(false);
                    setCreateError("");
                  }}
                >
                  <X size={14} />
                </Button>
              </div>

              <form onSubmit={handleCreateSubmit} className="p-5 space-y-3">
                <input
                  value={newStationName}
                  onChange={(e) => setNewStationName(e.target.value)}
                  maxLength={60}
                  placeholder="Station name"
                  className="w-full h-11 px-3 rounded-xl text-sm text-[--text-primary] placeholder:text-[--text-muted] focus:outline-none"
                  style={{
                    background: "var(--bg-subtle)",
                    border: "1px solid var(--border)",
                  }}
                />
                <textarea
                  value={newStationDescription}
                  onChange={(e) => setNewStationDescription(e.target.value)}
                  maxLength={300}
                  rows={3}
                  placeholder="Description (optional)"
                  className="w-full px-3 py-2.5 rounded-xl text-sm text-[--text-primary] placeholder:text-[--text-muted] focus:outline-none resize-none"
                  style={{
                    background: "var(--bg-subtle)",
                    border: "1px solid var(--border)",
                  }}
                />

                {createError ? (
                  <p className="text-sm text-red-300">{createError}</p>
                ) : null}

                <div className="pt-1 flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      if (createStationMutation.isPending) return;
                      setIsCreateModalOpen(false);
                      setCreateError("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={!canCreateStation}
                    isLoading={createStationMutation.isPending}
                  >
                    Create Station
                  </Button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
