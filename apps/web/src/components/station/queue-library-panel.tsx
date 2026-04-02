"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { formatDuration } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TrackCoverImage } from "@/components/ui/track-cover-image";
import api from "@/lib/api";
import { buildTrackCoverUrl } from "@/lib/media-url";
import type { QueueItem } from "@web-radio/shared";
import {
  GripVertical,
  Music2,
  MoreHorizontal,
  Settings,
  Plus,
  Play,
  SkipForward,
  ListEnd,
  Folder,
  Search,
  X,
  Check,
} from "lucide-react";

function getApiErrorMessage(error: unknown, fallback: string) {
  const message = (error as any)?.response?.data?.message;
  if (Array.isArray(message)) return message.join(", ");
  if (typeof message === "string" && message.trim().length > 0) return message;
  return fallback;
}

interface Playlist {
  id: string;
  name: string;
  trackCount: number;
  totalDuration: number;
  isDefault: boolean;
  sortOrder: number;
}

interface LibraryTrack {
  id: string;
  title: string | null;
  artist: string | null;
  duration: number;
  hasCover: boolean;
  filename: string;
  sortOrder: number;
}

const EMPTY_PLAYLISTS: Playlist[] = [];
const EMPTY_LIBRARY_TRACKS: LibraryTrack[] = [];

interface QueueLibraryPanelProps {
  stationId: string;
  activePlaylistId: string | null;
  currentTrackId?: string | null;
  queue: QueueItem[];
  canControl: boolean;
  shuffleEnabled: boolean;
  onQueueReorder: (items: Array<{ id: string; position: number }>) => void;
  onAddToQueue: (
    trackId: string,
    options?: { mode?: "end" | "next" | "now"; beforeItemId?: string },
  ) => Promise<void> | void;
  onRemoveFromQueue: (itemId: string) => void;
  onActivePlaylistChange?: (playlistId: string) => void;
  onOpenFolderManage?: (playlistId: string) => void;
}

type FolderColorKey = "orange" | "blue" | "green" | "violet" | "rose" | "amber";

const FOLDER_PALETTE: Record<
  FolderColorKey,
  { tab: string; back: string; front: string }
> = {
  orange: {
    tab: "linear-gradient(180deg, #FFC7A3 0%, #F68A49 100%)",
    back: "linear-gradient(180deg, #FFBE92 0%, #F87432 100%)",
    front: "linear-gradient(180deg, #FFB487 0%, #FF7532 72%, #EA4F10 100%)",
  },
  blue: {
    tab: "linear-gradient(180deg, #B8D8FF 0%, #5E9BFF 100%)",
    back: "linear-gradient(180deg, #A9CDFF 0%, #4D8CF4 100%)",
    front: "linear-gradient(180deg, #9FC6FF 0%, #4B85E4 72%, #2E65BC 100%)",
  },
  green: {
    tab: "linear-gradient(180deg, #C8F1C9 0%, #58B85E 100%)",
    back: "linear-gradient(180deg, #BFEABF 0%, #4DAA55 100%)",
    front: "linear-gradient(180deg, #B2E3B4 0%, #4C9A51 72%, #35753A 100%)",
  },
  violet: {
    tab: "linear-gradient(180deg, #DACBFF 0%, #946CFF 100%)",
    back: "linear-gradient(180deg, #D2C1FF 0%, #8159ED 100%)",
    front: "linear-gradient(180deg, #CBB7FF 0%, #7B52E2 72%, #5A35B3 100%)",
  },
  rose: {
    tab: "linear-gradient(180deg, #FFC8D9 0%, #FF6A95 100%)",
    back: "linear-gradient(180deg, #FFBDD2 0%, #F05D89 100%)",
    front: "linear-gradient(180deg, #FFB3CC 0%, #E4517C 72%, #B73860 100%)",
  },
  amber: {
    tab: "linear-gradient(180deg, #FFE3B1 0%, #FFB13B 100%)",
    back: "linear-gradient(180deg, #FFDAA0 0%, #F4A42E 100%)",
    front: "linear-gradient(180deg, #FFD692 0%, #E89A25 72%, #BB7914 100%)",
  },
};

function QueueTrackMenu({
  onRemove,
  onClose,
}: {
  onRemove: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <motion.div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      initial={{ opacity: 0, scale: 0.95, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: -4 }}
      transition={{ duration: 0.12 }}
      className="absolute right-0 top-[calc(100%+4px)] z-30 min-w-[140px] rounded-xl overflow-hidden p-1"
      style={{
        boxShadow: "var(--shadow-lg)",
        background: "var(--bg-elevated)",
      }}
    >
      <button
        className="flex items-center gap-2.5 w-full rounded-lg px-3 py-2.5 text-sm text-red-400 hover:bg-[--bg-subtle]"
        onClick={() => {
          onRemove();
          onClose();
        }}
      >
        Remove
      </button>
    </motion.div>
  );
}

function FolderArtwork({
  active = false,
  open = false,
  color = "orange",
  previewCovers = [],
}: {
  active?: boolean;
  open?: boolean;
  color?: FolderColorKey;
  previewCovers?: string[];
}) {
  const palette = FOLDER_PALETTE[color] ?? FOLDER_PALETTE.orange;
  const tabInactive = "linear-gradient(180deg, #B0B0B0 0%, #818181 100%)";
  const backInactive = "linear-gradient(180deg, #A2A2A2 0%, #6F6F6F 100%)";
  const frontInactive = "linear-gradient(180deg, #969696 0%, #767676 68%, #5E5E5E 100%)";
  const cleanCovers = previewCovers.filter(Boolean);
  const sheetSources: Array<string | null> =
    cleanCovers.length >= 3
      ? cleanCovers.slice(0, 3)
      : cleanCovers.length === 2
        ? cleanCovers
        : cleanCovers.length === 1
          ? [cleanCovers[0], null]
          : [null, null];

  return (
    <div
      className="relative w-[120px] h-[86px] mx-auto overflow-visible"
      style={{ perspective: 700 }}
    >
      {open &&
        sheetSources.map((coverUrl, idx) => {
          const transforms = [
            { x: -16, y: 10, rotate: -12 },
            { x: -2, y: 4, rotate: -3 },
            { x: 14, y: 10, rotate: 8 },
          ];
          const t = transforms[idx] ?? transforms[0];

          return (
            <motion.div
              key={`folder-sheet-${idx}-${coverUrl ?? "empty"}`}
              className="absolute left-1/2 top-1 w-7 h-7 rounded-[6px] overflow-hidden border pointer-events-none"
              style={{
                zIndex: 1 + idx,
                borderColor: "rgba(255,255,255,0.58)",
                boxShadow: "0 5px 12px rgba(0,0,0,0.2)",
                background: "rgba(255,255,255,0.95)",
              }}
              initial={{ opacity: 0, y: t.y + 4, x: t.x, rotate: t.rotate }}
              animate={{ opacity: 1, y: t.y, x: t.x, rotate: t.rotate }}
              exit={{ opacity: 0, y: t.y + 4, x: t.x, rotate: t.rotate }}
              transition={{ duration: 0.22, ease: "easeOut", delay: idx * 0.03 }}
            >
              <TrackCoverImage
                src={coverUrl}
                fallbackIconSize={11}
                fallbackClassName="w-full h-full flex items-center justify-center bg-white"
              />
            </motion.div>
          );
        })}

      <motion.div
        className="absolute left-9 top-2 w-16 h-5 rounded-t-[6px]"
        animate={{ y: 0, rotate: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
      >
        <div
          className="absolute inset-0 rounded-t-[6px]"
          style={{ background: tabInactive, boxShadow: "none" }}
        />
        <motion.div
          className="absolute inset-0 rounded-t-[6px]"
          style={{ background: palette.tab, boxShadow: "none" }}
          animate={{ opacity: active ? 1 : 0 }}
          transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
        />
      </motion.div>
      {/* Back plate: stays in place */}
      <div
        className="absolute left-4 right-4 top-5 h-[58px] rounded-[8px]"
      >
        <div className="absolute inset-0 rounded-[8px]" style={{ background: backInactive }} />
        <motion.div
          className="absolute inset-0 rounded-[8px]"
          style={{ background: palette.back }}
          animate={{ opacity: active ? 1 : 0 }}
          transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
        />
      </div>
      {/* Front plate: opens in perspective, upper-left corner goes deeper */}
      <motion.div
        className="absolute left-4 right-4 top-5 h-[58px] rounded-[8px]"
        animate={{
          rotateX: open ? -45 : 0,
          rotateY: open ? 12 : 0,
          skewX: open ? 18 : 0,
          x: open ? -1 : 0,
          y: open ? -1 : 0,
        }}
        transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
        style={{
          transformOrigin: "right bottom",
          transformStyle: "preserve-3d",
        }}
      >
        <div className="absolute inset-0 rounded-[8px]" style={{ background: frontInactive }} />
        <motion.div
          className="absolute inset-0 rounded-[8px]"
          style={{ background: palette.front }}
          animate={{ opacity: active ? 1 : 0 }}
          transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
        />
        <div
          className="absolute inset-x-5 top-7 h-3 rounded-[2px]"
          style={{ background: "rgba(255,255,255,0.09)", boxShadow: "none" }}
        />
        <motion.div
          className="absolute inset-x-5 top-7 h-3 rounded-[2px]"
          style={{ background: "rgba(255,255,255,0.12)", boxShadow: "none" }}
          animate={{ opacity: active ? 1 : 0 }}
          transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
        />
        <div
          className="absolute inset-x-0 bottom-0 h-2 rounded-b-[8px]"
          style={{
            background:
              "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.12) 100%)",
          }}
        />
      </motion.div>
    </div>
  );
}

function DraggableFolderChip({
  playlist,
  isActive,
  isViewed,
  onClick,
  color,
  onOpenSettings,
  previewCovers,
}: {
  playlist: Playlist;
  isActive: boolean;
  isViewed: boolean;
  onClick: () => void;
  color: FolderColorKey;
  onOpenSettings: () => void;
  previewCovers?: string[];
}) {
  const [isHover, setIsHover] = useState(false);
  const [hoverPush, setHoverPush] = useState({ x: 0, y: 0 });
  const showGear = isHover;

  const handleMouseLeave = () => {
    setIsHover(false);
    setHoverPush({ x: 0, y: 0 });
  };

  const handleMouseMove = (e: any) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const normX = Math.max(
      -1,
      Math.min(1, (e.clientX - centerX) / (rect.width * 0.5)),
    );
    const normY = Math.max(
      -1,
      Math.min(1, (e.clientY - centerY) / (rect.height * 0.5)),
    );

    // Move in the opposite direction of the cursor to create a soft "avoid" effect.
    setHoverPush({
      x: -normX * 6,
      y: -normY * 4,
    });
  };

  return (
    <div className="relative shrink-0 w-[172px]">
      <button
        onClick={onClick}
        onMouseEnter={() => setIsHover(true)}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        className="w-full p-1 text-center transition-colors rounded-xl"
      >
        <AnimatePresence>
          {showGear && (
            <motion.div
              role="button"
              tabIndex={0}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="absolute top-0 right-1 z-20 w-7 h-7 rounded-lg flex items-center justify-center text-[--text-secondary] hover:text-[--text-primary] hover:bg-[--bg-subtle]"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onOpenSettings();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onOpenSettings();
                }
              }}
            >
              <Settings size={14} />
            </motion.div>
          )}
        </AnimatePresence>
        <motion.div
          animate={{ x: hoverPush.x, y: hoverPush.y }}
          transition={{ type: "spring", stiffness: 210, damping: 17, mass: 0.68 }}
          className="inline-block"
        >
          <motion.div
            animate={
              isHover
                ? {
                    rotate: [0, 1.15, -0.9, 0.7, -0.35, 0],
                    scale: [1, 1.01, 1, 1.006, 1],
                  }
                : { rotate: 0, scale: 1 }
            }
            transition={
              isHover
                ? { duration: 2.2, repeat: Infinity, ease: "easeInOut" }
                : { duration: 0.22, ease: "easeOut" }
            }
            style={{ transformOrigin: "50% 62%" }}
          >
            <FolderArtwork
              active={isViewed}
              open={isViewed || isHover}
              color={isViewed ? "orange" : color}
              previewCovers={previewCovers}
            />
          </motion.div>
        </motion.div>
        <p
          className={`text-[18px] font-semibold mt-1.5 leading-tight truncate ${isViewed ? "text-[--text-primary]" : "text-[--text-secondary]"}`}
        >
          {isActive && (
            <span className="inline-block mr-1.5 text-[10px] leading-none text-[#E8440F] align-middle">
              ●
            </span>
          )}
          {playlist.name}
        </p>
        <p className="text-[11px] text-[--text-muted] mt-0.5">
          {playlist.trackCount} files
        </p>
      </button>
    </div>
  );
}

function SortableQueueRow({
  item,
  isCurrentTrack,
  canControl,
  onRemove,
}: {
  item: QueueItem;
  isCurrentTrack: boolean;
  canControl: boolean;
  onRemove: (id: string) => void;
}) {
  const [openMenu, setOpenMenu] = useState(false);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `queue-${item.id}`,
    disabled: !canControl,
  });

  const coverUrl = item.track.hasCover
    ? buildTrackCoverUrl(item.track.id)
    : null;

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      className={`flex items-center gap-2 md:gap-3 rounded-xl transition-colors ${
        item.queueType === "USER" ? "px-0 py-1.5 md:py-2.5" : "p-1.5 md:p-2.5"
      } ${
        isCurrentTrack ? "bg-[--color-accent-muted]" : "hover:bg-[--bg-subtle]"
      }`}
    >
      <button
        {...attributes}
        {...listeners}
        className="text-[--text-muted] hover:text-[--text-secondary] cursor-grab active:cursor-grabbing"
        disabled={!canControl}
      >
        <GripVertical size={14} />
      </button>

      <div
        className={`w-8 h-8 rounded-lg overflow-hidden flex-shrink-0 ${
          coverUrl ? "bg-[--bg-subtle]" : "bg-gray-500/20"
        }`}
      >
        <TrackCoverImage
          src={coverUrl}
          fallbackIconSize={14}
          fallbackClassName="w-full h-full flex items-center justify-center"
        />
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[--text-primary] truncate">
          {item.track.title ?? item.track.id}
        </p>
        <p className="text-xs text-[--text-muted] truncate">
          {item.track.artist ?? "—"}
        </p>
      </div>

      {item.queueType === "USER" && item.addedBy && (
        <div className="flex items-center gap-1.5 max-w-[140px]">
          <div className="w-5 h-5 rounded-full overflow-hidden flex items-center justify-center bg-[--bg-subtle] text-[9px] font-semibold text-[--text-secondary] flex-shrink-0">
            {item.addedBy.avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.addedBy.avatar}
                alt={item.addedBy.username}
                className="w-full h-full object-cover"
              />
            ) : (
              item.addedBy.username.slice(0, 2).toUpperCase()
            )}
          </div>
          <span className="text-xs text-[--text-secondary] truncate">
            {item.addedBy.username}
          </span>
        </div>
      )}

      <span className="text-xs text-[--text-muted] tabular-nums">
        {formatDuration(item.track.duration)}
      </span>

      {canControl && (
        <div className="relative">
          <button
            onClick={() => setOpenMenu((v) => !v)}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-[--text-muted] hover:text-[--text-primary] hover:bg-[--bg-subtle]"
            title="More"
          >
            <MoreHorizontal size={14} />
          </button>
          <AnimatePresence>
            {openMenu && (
              <QueueTrackMenu
                onRemove={() => onRemove(item.id)}
                onClose={() => setOpenMenu(false)}
              />
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

function LibraryTrackMenu({
  onAction,
  onClose,
}: {
  onAction: (mode: "end" | "next" | "now") => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.95, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: -4 }}
      transition={{ duration: 0.12 }}
      className="absolute right-0 top-[calc(100%+4px)] z-30 min-w-[190px] rounded-xl overflow-hidden p-1"
      style={{
        boxShadow: "var(--shadow-lg)",
        background: "var(--bg-elevated)",
      }}
    >
      <button
        className="flex items-center gap-2.5 w-full rounded-lg px-3 py-2.5 text-sm text-[--text-primary] hover:bg-[--bg-subtle]"
        onClick={() => {
          onAction("end");
          onClose();
        }}
      >
        <ListEnd size={13} className="text-[--color-accent]" />
        Add to end
      </button>
      <button
        className="flex items-center gap-2.5 w-full rounded-lg px-3 py-2.5 text-sm text-[--text-primary] hover:bg-[--bg-subtle]"
        onClick={() => {
          onAction("next");
          onClose();
        }}
      >
        <SkipForward size={13} className="text-[--color-accent]" />
        Play next
      </button>
      <button
        className="flex items-center gap-2.5 w-full rounded-lg px-3 py-2.5 text-sm text-[--text-primary] hover:bg-[--bg-subtle]"
        onClick={() => {
          onAction("now");
          onClose();
        }}
      >
        <Play size={13} className="text-[--color-accent]" />
        Play now
      </button>
    </motion.div>
  );
}

function SortableLibraryRow({
  track,
  index,
  isCurrentTrack,
  canReorder,
  canSelect,
  isSelected,
  selectionDisabled,
  onToggleSelect,
  canMenu,
  onMenuAction,
  menuOpen,
  onOpenMenu,
  onCloseMenu,
}: {
  track: LibraryTrack;
  index: number;
  isCurrentTrack: boolean;
  canReorder: boolean;
  canSelect: boolean;
  isSelected: boolean;
  selectionDisabled: boolean;
  onToggleSelect: (trackId: string) => void;
  canMenu: boolean;
  onMenuAction: (mode: "end" | "next" | "now") => void;
  menuOpen: boolean;
  onOpenMenu: () => void;
  onCloseMenu: () => void;
}) {
  const [isHoveringRow, setIsHoveringRow] = useState(false);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `lib-${track.id}`,
    disabled: !canReorder,
  });

  const coverUrl = track.hasCover
    ? buildTrackCoverUrl(track.id)
    : null;
  const showCheckbox = canSelect && (isSelected || isHoveringRow);

  return (
    <div
      ref={setNodeRef}
      onMouseEnter={() => setIsHoveringRow(true)}
      onMouseLeave={() => setIsHoveringRow(false)}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      className={`relative flex items-center gap-1.5 md:gap-2 p-1.5 md:p-2.5 rounded-xl transition-colors ${
        isSelected ? "bg-[--color-accent-muted]" : "hover:bg-[--bg-subtle]"
      }`}
    >
      <motion.div
        initial={false}
        animate={{
          opacity: showCheckbox ? 1 : 0,
          x: showCheckbox ? 0 : -10,
          width: showCheckbox ? 16 : 0,
          marginRight: showCheckbox ? 0 : -6,
        }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        className="overflow-hidden"
        style={{ pointerEvents: showCheckbox ? "auto" : "none" }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(track.id);
          }}
          disabled={selectionDisabled || !showCheckbox}
          tabIndex={showCheckbox ? 0 : -1}
          className="w-4 h-4 rounded-[4px] flex items-center justify-center border border-[--border] text-[--text-primary] bg-[--bg] hover:border-[--color-accent] disabled:opacity-60 disabled:cursor-not-allowed"
          title={isSelected ? "Unselect track" : "Select track"}
          aria-label={isSelected ? "Unselect track" : "Select track"}
        >
          {isSelected && <Check size={10} className="text-[--color-accent]" />}
        </button>
      </motion.div>

      <span className="w-5 flex items-center justify-end">
        <span
          className={`inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-md text-xs font-semibold tabular-nums ${
            isCurrentTrack ? "text-[#E8440F]" : "text-[--text-muted]"
          }`}
        >
          {index}
        </span>
      </span>

      {canReorder && (
        <button
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          disabled={!canReorder}
          className="text-[--text-muted] hover:text-[--text-secondary] cursor-grab active:cursor-grabbing"
        >
          <GripVertical size={14} />
        </button>
      )}

      <div
        className={`w-8 h-8 rounded-lg overflow-hidden flex-shrink-0 ${
          coverUrl ? "bg-[--bg-subtle]" : "bg-gray-500/20"
        }`}
      >
        <TrackCoverImage
          src={coverUrl}
          fallbackIconSize={14}
          fallbackClassName="w-full h-full flex items-center justify-center"
        />
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[--text-primary] truncate">
          {track.title ?? track.filename}
        </p>
        <p className="text-xs text-[--text-muted] truncate">
          {track.artist ?? "—"}
        </p>
      </div>

      <span className="text-xs text-[--text-muted] tabular-nums">
        {formatDuration(track.duration)}
      </span>

      <div className="relative">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenMenu();
          }}
          disabled={!canMenu || selectionDisabled}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-[--text-muted] hover:text-[--text-primary] hover:bg-[--bg-subtle]"
        >
          <MoreHorizontal size={14} />
        </button>
        <AnimatePresence>
          {menuOpen && canMenu && (
            <LibraryTrackMenu onAction={onMenuAction} onClose={onCloseMenu} />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

export function QueueLibraryPanel({
  stationId,
  activePlaylistId,
  currentTrackId,
  queue,
  canControl,
  shuffleEnabled,
  onQueueReorder,
  onAddToQueue,
  onRemoveFromQueue,
  onActivePlaylistChange,
  onOpenFolderManage,
}: QueueLibraryPanelProps) {
  const queryClient = useQueryClient();
  const [openMenuTrackId, setOpenMenuTrackId] = useState<string | null>(null);
  const [trackSearch, setTrackSearch] = useState("");
  const [currentPlaylistId, setCurrentPlaylistId] = useState<string | null>(
    activePlaylistId ?? null,
  );
  const [folderColors, setFolderColors] = useState<
    Record<string, FolderColorKey>
  >({});
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
  const [isBulkActionPending, setIsBulkActionPending] = useState(false);
  const [bulkActionError, setBulkActionError] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const { setNodeRef: queueDropRef, isOver: isQueueDropOver } = useDroppable({
    id: "queue-drop-end",
  });

  const { data: playlistsData, isLoading: playlistsLoading } = useQuery<
    Playlist[]
  >({
    queryKey: ["playlists", stationId],
    queryFn: () =>
      api.get(`/stations/${stationId}/playlists`).then((r) => r.data),
    enabled: !!stationId,
  });
  const playlists = playlistsData ?? EMPTY_PLAYLISTS;
  useEffect(() => {
    setCurrentPlaylistId((prev) => {
      if (!playlists.length) {
        return prev === null ? prev : null;
      }

      if (prev && playlists.some((playlist) => playlist.id === prev)) {
        return prev;
      }

      const next = activePlaylistId ?? playlists[0].id;
      return prev === next ? prev : next;
    });
  }, [playlists, activePlaylistId]);

  useEffect(() => {
    setTrackSearch("");
    setOpenMenuTrackId(null);
    setSelectedTrackIds([]);
    setBulkActionError(null);
  }, [currentPlaylistId]);

  useEffect(() => {
    if (!stationId) return;
    try {
      const raw = localStorage.getItem(`folder-colors-${stationId}`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, FolderColorKey>;
      setFolderColors(parsed ?? {});
    } catch {
      setFolderColors({});
    }
  }, [stationId]);

  useEffect(() => {
    if (!stationId) return;
    localStorage.setItem(
      `folder-colors-${stationId}`,
      JSON.stringify(folderColors),
    );
  }, [stationId, folderColors]);

  const { data: playlistTracksData, isLoading: tracksLoading } = useQuery<
    LibraryTrack[]
  >({
    queryKey: ["playlist-tracks", currentPlaylistId],
    queryFn: () =>
      api.get(`/playlists/${currentPlaylistId}/tracks`).then((r) => r.data),
    enabled: !!currentPlaylistId,
  });
  const playlistTracks = playlistTracksData ?? EMPTY_LIBRARY_TRACKS;
  const currentFolderCoverUrls = useMemo(
    () =>
      playlistTracks
        .filter((track) => track.hasCover)
        .slice(0, 3)
        .map((track) => buildTrackCoverUrl(track.id)),
    [playlistTracks],
  );

  const createFolderMutation = useMutation({
    mutationFn: (name: string) =>
      api.post(`/stations/${stationId}/playlists`, { name }),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ["playlists", stationId] });
      const created = res?.data;
      if (created?.id) {
        activateFolderMutation.mutate(created.id);
        onOpenFolderManage?.(created.id);
      }
    },
  });

  const activateFolderMutation = useMutation({
    mutationFn: (playlistId: string) =>
      api.post(`/stations/${stationId}/playlists/${playlistId}/activate`),
    onSuccess: (_res, playlistId) => {
      queryClient.invalidateQueries({ queryKey: ["playlists", stationId] });
      onActivePlaylistChange?.(playlistId);
    },
  });

  const activePlaylist = useMemo(
    () => playlists.find((p) => p.id === activePlaylistId),
    [playlists, activePlaylistId],
  );

  const userQueue = useMemo(
    () => queue.filter((i) => i.queueType === "USER"),
    [queue],
  );
  const systemQueue = useMemo(
    () => queue.filter((i) => i.queueType === "SYSTEM"),
    [queue],
  );
  const isViewingActivePlaylist =
    !!currentPlaylistId && currentPlaylistId === activePlaylistId;

  const displayTracks = useMemo(() => {
    if (!playlistTracks.length) return [];

    let tracks = [...playlistTracks];

    if (isViewingActivePlaylist && shuffleEnabled && systemQueue.length > 0) {
      const order = systemQueue.map((item) => item.track.id);
      const byId = new Map(tracks.map((track) => [track.id, track]));
      const ordered: LibraryTrack[] = [];

      for (const id of order) {
        const track = byId.get(id);
        if (track) {
          ordered.push(track);
          byId.delete(id);
        }
      }

      tracks = [...ordered, ...Array.from(byId.values())];
    }

    return tracks;
  }, [playlistTracks, isViewingActivePlaylist, shuffleEnabled, systemQueue]);

  const normalizedTrackSearch = useMemo(
    () => trackSearch.trim().toLowerCase(),
    [trackSearch],
  );

  const filteredTracks = useMemo(() => {
    if (!normalizedTrackSearch) return displayTracks;

    return displayTracks.filter((track) => {
      const fields = [track.title, track.artist, track.filename, track.id];
      return fields.some((value) =>
        String(value ?? "")
          .toLowerCase()
          .includes(normalizedTrackSearch),
      );
    });
  }, [displayTracks, normalizedTrackSearch]);

  const selectableTrackIds = useMemo(
    () => new Set(displayTracks.map((track) => track.id)),
    [displayTracks],
  );

  useEffect(() => {
    setSelectedTrackIds((prev) => {
      if (!prev.length) return prev;
      const next = prev.filter((trackId) => selectableTrackIds.has(trackId));
      return next.length === prev.length ? prev : next;
    });
  }, [selectableTrackIds]);

  const selectedTrackIdSet = useMemo(
    () => new Set(selectedTrackIds),
    [selectedTrackIds],
  );
  const visibleTrackIds = useMemo(
    () => filteredTracks.map((track) => track.id),
    [filteredTracks],
  );
  const selectedVisibleCount = useMemo(
    () =>
      visibleTrackIds.reduce(
        (count, trackId) => (selectedTrackIdSet.has(trackId) ? count + 1 : count),
        0,
      ),
    [visibleTrackIds, selectedTrackIdSet],
  );
  const allVisibleSelected =
    visibleTrackIds.length > 0 && selectedVisibleCount === visibleTrackIds.length;
  const hasSelectedTracks = selectedTrackIds.length > 0;

  const handleFolderClick = (playlist: Playlist) => {
    setCurrentPlaylistId(playlist.id);
  };

  const handleToggleTrackSelection = useCallback((trackId: string) => {
    setBulkActionError(null);
    setSelectedTrackIds((prev) =>
      prev.includes(trackId)
        ? prev.filter((id) => id !== trackId)
        : [...prev, trackId],
    );
  }, []);

  const handleToggleVisibleSelection = useCallback(() => {
    setBulkActionError(null);
    setSelectedTrackIds((prev) => {
      const next = new Set(prev);
      const shouldSelectAllVisible = visibleTrackIds.some((id) => !next.has(id));

      if (shouldSelectAllVisible) {
        visibleTrackIds.forEach((id) => next.add(id));
      } else {
        visibleTrackIds.forEach((id) => next.delete(id));
      }

      return Array.from(next);
    });
  }, [visibleTrackIds]);

  const handleBulkQueueAction = useCallback(
    async (mode: "end" | "next" | "now") => {
      if (!selectedTrackIds.length || isBulkActionPending) return;

      const selectedIds = new Set(selectedTrackIds);
      const orderedSelection = displayTracks
        .filter((track) => selectedIds.has(track.id))
        .map((track) => track.id);
      if (!orderedSelection.length) return;

      const queueOrder =
        mode === "end" ? orderedSelection : [...orderedSelection].reverse();

      setBulkActionError(null);
      setOpenMenuTrackId(null);
      setIsBulkActionPending(true);
      try {
        for (const trackId of queueOrder) {
          // Keep requests ordered so queue insertion order stays predictable.
          // eslint-disable-next-line no-await-in-loop
          await Promise.resolve(onAddToQueue(trackId, { mode }));
        }
        setSelectedTrackIds([]);
      } catch (error) {
        setBulkActionError(
          getApiErrorMessage(error, "Couldn't run bulk action. Try again."),
        );
      } finally {
        setIsBulkActionPending(false);
      }
    },
    [displayTracks, isBulkActionPending, onAddToQueue, selectedTrackIds],
  );

  const queueSortableIds = userQueue.map((item) => `queue-${item.id}`);
  const libSortableIds = filteredTracks.map((track) => `lib-${track.id}`);

  const handleDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId) return;

    if (activeId.startsWith("queue-") && overId.startsWith("queue-")) {
      const fromId = activeId.slice("queue-".length);
      const toId = overId.slice("queue-".length);
      if (!fromId || !toId || fromId === toId) return;

      const oldIndex = userQueue.findIndex((item) => item.id === fromId);
      const newIndex = userQueue.findIndex((item) => item.id === toId);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = arrayMove(userQueue, oldIndex, newIndex);
      onQueueReorder(
        reordered.map((item, idx) => ({ id: item.id, position: idx })),
      );
      return;
    }
  };

  if (!stationId) return null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <div className="p-4 space-y-6">
        <AnimatePresence initial={false}>
          {userQueue.length > 0 && (
            <motion.section
              key="queue-section"
              initial={{ opacity: 0, y: -8, height: 0 }}
              animate={{ opacity: 1, y: 0, height: "auto" }}
              exit={{ opacity: 0, y: -8, height: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="space-y-2"
            >
              <div className="flex items-center justify-between">
                <p className="text-4xl font-black text-[--text-primary] tracking-tight leading-none">
                  Queue
                </p>
                <Badge variant="accent" className="text-[10px]">
                  {userQueue.length} tracks
                </Badge>
              </div>

              <div ref={queueDropRef} className="space-y-1">
                <SortableContext
                  items={queueSortableIds}
                  strategy={verticalListSortingStrategy}
                >
                  <div
                    className="space-y-1"
                    style={
                      isQueueDropOver
                        ? {
                            outline: "1px dashed var(--color-accent)",
                            borderRadius: 12,
                          }
                        : undefined
                    }
                  >
                    {userQueue.map((item) => (
                      <SortableQueueRow
                        key={item.id}
                        item={item}
                        isCurrentTrack={item.track.id === currentTrackId}
                        canControl={canControl}
                        onRemove={onRemoveFromQueue}
                      />
                    ))}
                  </div>
                </SortableContext>
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        <section className="space-y-3">
          <div className="flex h-10 items-center justify-between">
            <p className="text-4xl font-black text-[--text-primary] tracking-tight leading-none">
              Library
            </p>
            <Button
              size="icon-sm"
              variant="ghost"
              className="h-10 w-10 !p-0 flex items-center justify-center self-center"
              onClick={() => createFolderMutation.mutate("New folder")}
              title="Create folder"
              isLoading={createFolderMutation.isPending}
            >
              <Plus size={18} />
            </Button>
          </div>
          <div className="ml-1 flex items-center">
            <div className="relative w-full sm:w-[220px] max-w-full">
              <Search
                size={16}
                className="absolute left-0 top-1/2 -translate-y-1/2 text-[--text-muted]"
              />
              <input
                data-no-focus-ring="true"
                type="text"
                value={trackSearch}
                onChange={(e) => setTrackSearch(e.target.value)}
                placeholder="search"
                className="h-8 w-full rounded-lg !border-0 border-none pl-6 pr-8 text-sm text-[--text-primary] placeholder:text-[--text-muted] !outline-none transition-all focus:!border-0 focus:!outline-none focus-visible:!border-0 focus-visible:!outline-none focus:ring-0 focus-visible:ring-0"
                style={{
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  boxShadow: "none",
                }}
              />
              {trackSearch && (
                <button
                  type="button"
                  onClick={() => setTrackSearch("")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-md text-[--text-muted] hover:bg-[--bg-elevated] hover:text-[--text-primary]"
                  title="Clear search"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>

          <div className="mt-4 mb-10 -ml-6">
            <div className="flex flex-wrap gap-2 pr-1">
              {playlists.map((playlist) => (
                <DraggableFolderChip
                  key={playlist.id}
                  playlist={playlist}
                  isActive={playlist.id === activePlaylist?.id}
                  isViewed={playlist.id === currentPlaylistId}
                  onClick={() => handleFolderClick(playlist)}
                  color={folderColors[playlist.id] ?? "orange"}
                  onOpenSettings={() => onOpenFolderManage?.(playlist.id)}
                  previewCovers={
                    playlist.id === currentPlaylistId
                      ? currentFolderCoverUrls
                      : undefined
                  }
                />
              ))}
            </div>
          </div>

          <div
            className="rounded-2xl p-1 md:p-2"
            style={{
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
            }}
          >
            {canControl && hasSelectedTracks && (
              <div
                className="mb-2 pb-2"
                style={{
                  borderBottom: "1px solid rgba(128, 128, 128, 0.18)",
                }}
              >
                <div className="flex flex-wrap items-center gap-2 pl-1.5 md:pl-2.5">
                  <button
                    type="button"
                    onClick={handleToggleVisibleSelection}
                    disabled={!filteredTracks.length || isBulkActionPending}
                    className="w-4 h-4 rounded-[4px] flex items-center justify-center border border-[--border] text-[--text-primary] bg-[--bg] hover:border-[--color-accent] disabled:opacity-60 disabled:cursor-not-allowed"
                    title={
                      allVisibleSelected
                        ? "Unselect visible tracks"
                        : "Select visible tracks"
                    }
                  >
                    {allVisibleSelected && (
                      <Check size={10} className="text-[--color-accent]" />
                    )}
                  </button>

                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!hasSelectedTracks || isBulkActionPending}
                    isLoading={isBulkActionPending}
                    onClick={() => handleBulkQueueAction("end")}
                  >
                    Add selected to end
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!hasSelectedTracks || isBulkActionPending}
                    isLoading={isBulkActionPending}
                    onClick={() => handleBulkQueueAction("next")}
                  >
                    Play selected next
                  </Button>
                  <Button
                    size="sm"
                    disabled={!hasSelectedTracks || isBulkActionPending}
                    isLoading={isBulkActionPending}
                    onClick={() => handleBulkQueueAction("now")}
                  >
                    Play selected now
                  </Button>
                </div>
                {bulkActionError && (
                  <p className="mt-2 text-xs text-red-500">{bulkActionError}</p>
                )}
              </div>
            )}

            {tracksLoading ? (
              <div className="flex justify-center py-8">
                <div className="w-5 h-5 border-2 border-[--color-accent] border-t-transparent rounded-full animate-spin" />
              </div>
            ) : displayTracks.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 text-[--text-muted]">
                <Folder size={20} className="mb-2 opacity-30" />
                <p className="text-sm">No tracks in this folder</p>
              </div>
            ) : filteredTracks.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 text-[--text-muted]">
                <Search size={18} className="mb-2 opacity-40" />
                <p className="text-sm">No tracks found</p>
              </div>
            ) : (
              <div className="relative">
                <SortableContext
                  items={libSortableIds}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-1">
                    {filteredTracks.map((track, idx) => (
                      <SortableLibraryRow
                        key={track.id}
                        track={track}
                        index={idx + 1}
                        isCurrentTrack={track.id === currentTrackId}
                        canReorder={false}
                        canSelect={canControl}
                        isSelected={selectedTrackIdSet.has(track.id)}
                        selectionDisabled={isBulkActionPending}
                        onToggleSelect={handleToggleTrackSelection}
                        canMenu={canControl}
                        menuOpen={openMenuTrackId === track.id}
                        onOpenMenu={() =>
                          setOpenMenuTrackId(
                            openMenuTrackId === track.id ? null : track.id,
                          )
                        }
                        onCloseMenu={() => setOpenMenuTrackId(null)}
                        onMenuAction={(mode) => onAddToQueue(track.id, { mode })}
                      />
                    ))}
                  </div>
                </SortableContext>
              </div>
            )}
          </div>

          {playlistsLoading && (
            <div className="flex justify-center py-3">
              <div className="w-4 h-4 border-2 border-[--color-accent] border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </section>
      </div>
    </DndContext>
  );
}
