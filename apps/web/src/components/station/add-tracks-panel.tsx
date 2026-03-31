"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeft,
  Folder,
  Music2,
  Plus,
  Trash2,
  Play,
  GripVertical,
  Upload,
  X,
  Check,
  Download,
  MoreHorizontal,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { formatDuration, formatFileSize } from "@/lib/utils";
import api from "@/lib/api";
import { useAuthStore } from "@/stores/auth.store";
import { SUPPORTED_EXTENSIONS } from "@web-radio/shared";

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

const COLOR_ORDER: FolderColorKey[] = [
  "orange",
  "blue",
  "green",
  "violet",
  "rose",
  "amber",
];

interface UploadShowcaseCard {
  id: string;
  imageUrl: string | null;
  left: number;
  top: number;
  size: number;
  rotation: number;
  rotateOffset: number;
  rotateVelocity: number;
  offsetX: number;
  offsetY: number;
  velocityX: number;
  velocityY: number;
  floatPhaseX: number;
  floatPhaseY: number;
  isNew: boolean;
}

const DESKTOP_MAX_UPLOAD_SHOWCASE_CARDS = 10;
const MOBILE_MAX_UPLOAD_SHOWCASE_CARDS = 4;
const CARD_MIN_DISTANCE = 14;
const FALLBACK_BINARY_MIME_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);

function getFileExtension(name: string) {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot).toLowerCase();
}

function isSupportedAudioUploadFile(file: File) {
  const ext = getFileExtension(file.name);
  const mime = String(file.type ?? "").trim().toLowerCase();
  const isExtAllowed = SUPPORTED_EXTENSIONS.includes(ext);
  if (!isExtAllowed) return false;
  return mime.startsWith("audio/") || FALLBACK_BINARY_MIME_TYPES.has(mime);
}

function randomNumber(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function randomInt(min: number, max: number) {
  return Math.round(randomNumber(min, max));
}

function createUploadShowcaseCard({
  id,
  imageUrl,
  existingCards,
  isNew,
  isCompact,
}: {
  id: string;
  imageUrl: string | null;
  existingCards: UploadShowcaseCard[];
  isNew: boolean;
  isCompact: boolean;
}): UploadShowcaseCard {
  const positionRange = isCompact
    ? { leftMin: 35, leftMax: 65, topMin: 30, topMax: 70 }
    : { leftMin: 24, leftMax: 76, topMin: 24, topMax: 76 };
  let left = randomNumber(positionRange.leftMin, positionRange.leftMax);
  let top = randomNumber(positionRange.topMin, positionRange.topMax);

  for (let attempt = 0; attempt < 48; attempt += 1) {
    const candidateLeft = randomNumber(
      positionRange.leftMin,
      positionRange.leftMax,
    );
    const candidateTop = randomNumber(
      positionRange.topMin,
      positionRange.topMax,
    );
    const intersects = existingCards.some((card) => {
      const distance = Math.hypot(card.left - candidateLeft, card.top - candidateTop);
      return distance < CARD_MIN_DISTANCE;
    });
    if (!intersects) {
      left = candidateLeft;
      top = candidateTop;
      break;
    }
    left = candidateLeft;
    top = candidateTop;
  }

  return {
    id,
    imageUrl,
    left,
    top,
    size: randomInt(110, 150),
    rotation: randomNumber(-8, 8),
    rotateOffset: 0,
    rotateVelocity: 0,
    offsetX: 0,
    offsetY: 0,
    velocityX: 0,
    velocityY: 0,
    floatPhaseX: randomNumber(0, Math.PI * 2),
    floatPhaseY: randomNumber(0, Math.PI * 2),
    isNew,
  };
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

interface Playlist {
  id: string;
  name: string;
  trackCount: number;
  isDefault: boolean;
}

interface PlaylistTrack {
  id: string;
  title: string | null;
  artist: string | null;
  duration: number;
  hasCover: boolean;
  filename: string;
  sortOrder?: number;
}

const EMPTY_PLAYLISTS: Playlist[] = [];
const EMPTY_PLAYLIST_TRACKS: PlaylistTrack[] = [];

function getApiErrorMessage(error: unknown, fallback: string) {
  const message = (error as any)?.response?.data?.message;
  if (Array.isArray(message)) return message.join(", ");
  if (typeof message === "string" && message.trim().length > 0) return message;
  return fallback;
}

function parseContentDispositionFileName(headerValue?: string) {
  if (!headerValue) return null;

  const utf8 = headerValue.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      return utf8[1];
    }
  }

  const ascii = headerValue.match(/filename=\"?([^\";]+)\"?/i);
  if (ascii?.[1]) return ascii[1];
  return null;
}

function getTrackDownloadName(track: PlaylistTrack) {
  const fromFilename = track.filename?.trim();
  if (fromFilename) return fromFilename;

  const fromTitle = track.title?.trim();
  if (fromTitle) return `${fromTitle}.mp3`;

  return `track-${track.id}.mp3`;
}

function triggerBlobDownload(blob: Blob, fileName: string) {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1200);
}

interface UploadFile {
  id: string;
  file: File;
  status: "pending" | "uploading" | "done" | "error";
  error?: string;
  progress: number;
}

interface AddTracksPanelProps {
  stationId: string;
  activePlaylistId: string | null;
  currentTrackId?: string | null;
  initialPlaylistId?: string | null;
  onBack: () => void;
  onActivePlaylistChange?: (playlistId: string) => void;
}

function FolderTrackMenu({
  onDownload,
  onDelete,
  onClose,
  disabled,
}: {
  onDownload: () => void;
  onDelete: () => void;
  onClose: () => void;
  disabled: boolean;
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
      className="absolute right-0 top-[calc(100%+4px)] z-30 min-w-[170px] rounded-xl overflow-hidden p-1"
      style={{
        boxShadow: "var(--shadow-lg)",
        background: "var(--bg-elevated)",
      }}
    >
      <button
        disabled={disabled}
        className="flex items-center gap-2.5 w-full rounded-lg px-3 py-2.5 text-sm text-[--text-primary] hover:bg-[--bg-subtle] disabled:opacity-40"
        onClick={() => {
          onDownload();
          onClose();
        }}
      >
        <Download size={13} className="text-[--color-accent]" />
        Download track
      </button>
      <button
        disabled={disabled}
        className="flex items-center gap-2.5 w-full rounded-lg px-3 py-2.5 text-sm text-red-400 hover:bg-[--bg-subtle] disabled:opacity-40"
        onClick={() => {
          onDelete();
          onClose();
        }}
      >
        <Trash2 size={13} />
        Delete track
      </button>
    </motion.div>
  );
}

function SortableFolderTrackRow({
  track,
  onDelete,
  onDownload,
  onStartEdit,
  isEditing,
  editingTitle,
  onEditingTitleChange,
  onCommitEdit,
  onCancelEdit,
  canReorder,
  canSelect,
  isSelected,
  selectionDisabled,
  onToggleSelect,
  deleting,
  downloading,
  menuOpen,
  onOpenMenu,
  onCloseMenu,
  isCurrentTrack,
}: {
  track: PlaylistTrack;
  onDelete: () => void;
  onDownload: () => void;
  onStartEdit: () => void;
  isEditing: boolean;
  editingTitle: string;
  onEditingTitleChange: (value: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  canReorder: boolean;
  canSelect: boolean;
  isSelected: boolean;
  selectionDisabled: boolean;
  onToggleSelect: (trackId: string) => void;
  deleting: boolean;
  downloading: boolean;
  menuOpen: boolean;
  onOpenMenu: () => void;
  onCloseMenu: () => void;
  isCurrentTrack: boolean;
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
    id: track.id,
    disabled: !canReorder,
  });

  const coverUrl = track.hasCover
    ? `${API_URL}/tracks/${track.id}/cover`
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
      className={`relative flex items-center gap-3 p-2.5 rounded-xl transition-colors ${
        isCurrentTrack || isSelected
          ? "bg-[--color-accent-muted]"
          : "hover:bg-[--bg-subtle]"
      }`}
    >
      <motion.div
        initial={false}
        animate={{
          opacity: showCheckbox ? 1 : 0,
          x: showCheckbox ? 0 : -10,
          width: showCheckbox ? 16 : 0,
          marginRight: showCheckbox ? 0 : -12,
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

      <button
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        disabled={!canReorder || selectionDisabled}
        className="text-[--text-muted] hover:text-[--text-secondary] cursor-grab active:cursor-grabbing disabled:opacity-30"
        title="Reorder"
      >
        <GripVertical size={14} />
      </button>

      <div
        className={`w-8 h-8 rounded-lg overflow-hidden flex-shrink-0 ${
          coverUrl ? "bg-[--bg-subtle]" : "bg-gray-500/20"
        }`}
      >
        {coverUrl ? (
          <img src={coverUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Music2 size={14} className="text-[--text-muted]" />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        {isEditing ? (
          <input
            autoFocus
            value={editingTitle}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onEditingTitleChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommitEdit();
              if (e.key === "Escape") onCancelEdit();
            }}
            onBlur={onCommitEdit}
            className="h-7 w-full px-0 text-sm font-medium text-[--text-primary] focus:outline-none focus-visible:outline-none"
            style={{
              background: "transparent",
              border: "none",
              outline: "none",
            }}
          />
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onStartEdit();
            }}
            className={`text-left w-full text-sm font-medium truncate hover:opacity-80 ${
              isCurrentTrack ? "text-[--color-accent]" : "text-[--text-primary]"
            }`}
            title="Edit title"
          >
            {track.title ?? track.filename}
          </button>
        )}
        <p className="text-xs text-[--text-muted] truncate">
          {track.artist ?? "—"}
        </p>
      </div>

      <span className="text-xs text-[--text-muted] tabular-nums">
        {formatDuration(track.duration)}
      </span>

      <div className="relative">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={(e) => {
            e.stopPropagation();
            onOpenMenu();
          }}
          title="Track actions"
          disabled={selectionDisabled || deleting || downloading}
        >
          <MoreHorizontal size={14} />
        </Button>
        <AnimatePresence>
          {menuOpen && (
            <FolderTrackMenu
              onDownload={onDownload}
              onDelete={onDelete}
              onClose={onCloseMenu}
              disabled={selectionDisabled || deleting || downloading}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function ActiveFolderArtwork({
  color,
  onClick,
  coverUrls = [],
}: {
  color: FolderColorKey;
  onClick: () => void;
  coverUrls?: string[];
}) {
  const palette = FOLDER_PALETTE[color] ?? FOLDER_PALETTE.orange;
  const cleanCovers = coverUrls.filter(Boolean);
  const previewSheets: Array<string | null> =
    cleanCovers.length >= 3
      ? cleanCovers.slice(0, 3)
      : cleanCovers.length === 2
        ? cleanCovers
        : cleanCovers.length === 1
          ? [cleanCovers[0], null]
          : [null, null];

  return (
    <button
      onClick={onClick}
      className="relative w-[176px] h-[136px]"
      style={{ perspective: 760 }}
      title="Change folder color"
    >
      {previewSheets.map((coverUrl, idx) => {
        const sheetTransforms = [
          { x: -28, y: -2, rotate: -14 },
          { x: -2, y: -11, rotate: -4 },
          { x: 22, y: -1, rotate: 10 },
        ];
        const transform = sheetTransforms[idx] ?? sheetTransforms[0];

        return (
          <motion.div
            key={`active-folder-sheet-${idx}-${coverUrl ?? "empty"}`}
            className="absolute left-1/2 top-6 w-[48px] h-[48px] rounded-[9px] overflow-hidden border pointer-events-none"
            style={{
              x: transform.x,
              y: transform.y,
              rotate: transform.rotate,
              zIndex: 1 + idx,
              borderColor: "rgba(255,255,255,0.6)",
              boxShadow: "0 7px 18px rgba(0,0,0,0.17)",
              background: "rgba(255,255,255,0.95)",
            }}
            initial={false}
            animate={{
              y: [transform.y, transform.y - 1.8, transform.y],
              rotate: [transform.rotate, transform.rotate + 0.8, transform.rotate],
            }}
            transition={{
              duration: 3.6 + idx * 0.6,
              repeat: Infinity,
              ease: "easeInOut",
              delay: idx * 0.18,
            }}
          >
            {coverUrl ? (
              <img src={coverUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-white">
                <Music2 size={14} className="text-[--text-muted]" />
              </div>
            )}
          </motion.div>
        );
      })}

      <div
        className="absolute left-6 right-6 top-[30px] h-[84px] rounded-[12px]"
        style={{ background: palette.back }}
      />
      <motion.div
        className="absolute left-6 right-6 top-[30px] h-[84px] rounded-[12px]"
        animate={{
          rotateX: -45,
          rotateY: 12,
          skewX: 18,
          x: -1,
          y: -1,
        }}
        transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
        style={{
          transformStyle: "preserve-3d",
          background: palette.front,
          transformOrigin: "right bottom",
        }}
      >
        <div
          className="absolute inset-x-4 top-8 h-[10px] rounded-[3px]"
          style={{ background: "rgba(255,255,255,0.12)", boxShadow: "none" }}
        />
        <div
          className="absolute inset-x-0 bottom-0 h-2 rounded-b-[12px]"
          style={{
            background:
              "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.12) 100%)",
          }}
        />
      </motion.div>
    </button>
  );
}

export function AddTracksPanel({
  stationId,
  activePlaylistId,
  currentTrackId,
  initialPlaylistId,
  onBack,
  onActivePlaylistChange,
}: AddTracksPanelProps) {
  const queryClient = useQueryClient();
  const refreshUser = useAuthStore((s) => s.refreshUser);
  const [isUploadMode, setIsUploadMode] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<UploadFile[]>([]);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [folderColors, setFolderColors] = useState<
    Record<string, FolderColorKey>
  >({});
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(
    initialPlaylistId ?? activePlaylistId ?? null,
  );
  const [folderNameDraft, setFolderNameDraft] = useState("");
  const [orderedTracks, setOrderedTracks] = useState<PlaylistTrack[]>([]);
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [editingTrackTitle, setEditingTrackTitle] = useState("");
  const [trackToDelete, setTrackToDelete] = useState<PlaylistTrack | null>(null);
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
  const [openTrackMenuId, setOpenTrackMenuId] = useState<string | null>(null);
  const [trackActionError, setTrackActionError] = useState<string | null>(null);
  const [isTrackDownloadPending, setIsTrackDownloadPending] = useState(false);
  const [isBulkDownloadPending, setIsBulkDownloadPending] = useState(false);
  const [isBulkDeletePending, setIsBulkDeletePending] = useState(false);
  const [isBulkDeleteConfirmOpen, setIsBulkDeleteConfirmOpen] = useState(false);
  const [isUploadShowcaseExpanded, setIsUploadShowcaseExpanded] =
    useState(false);
  const [showcaseSupportsHover, setShowcaseSupportsHover] = useState(true);
  const [isCompactShowcase, setIsCompactShowcase] = useState(false);
  const [uploadShowcaseCards, setUploadShowcaseCards] = useState<
    UploadShowcaseCard[]
  >([]);
  const uploadShowcaseInitKeyRef = useRef<string | null>(null);
  const uploadShowcaseAreaRef = useRef<HTMLDivElement>(null);
  const uploadShowcasePointerRef = useRef({
    x: 0,
    y: 0,
    inside: false,
  });

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  useEffect(() => {
    setSelectedPlaylistId(initialPlaylistId ?? activePlaylistId ?? null);
  }, [initialPlaylistId, activePlaylistId]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;

    const hoverQuery = window.matchMedia("(hover: hover)");
    const compactQuery = window.matchMedia("(max-width: 640px)");

    const syncShowcaseMode = () => {
      const hoverEnabled = hoverQuery.matches;
      setShowcaseSupportsHover(hoverEnabled);
      setIsCompactShowcase(compactQuery.matches);
    };

    syncShowcaseMode();

    if (hoverQuery.addEventListener && compactQuery.addEventListener) {
      hoverQuery.addEventListener("change", syncShowcaseMode);
      compactQuery.addEventListener("change", syncShowcaseMode);
      return () => {
        hoverQuery.removeEventListener("change", syncShowcaseMode);
        compactQuery.removeEventListener("change", syncShowcaseMode);
      };
    }

    hoverQuery.addListener(syncShowcaseMode);
    compactQuery.addListener(syncShowcaseMode);
    return () => {
      hoverQuery.removeListener(syncShowcaseMode);
      compactQuery.removeListener(syncShowcaseMode);
    };
  }, []);

  useEffect(() => {
    if (!isUploadMode) {
      setIsUploadShowcaseExpanded(false);
    }
  }, [isUploadMode]);

  useEffect(() => {
    if (!stationId) return;
    try {
      const raw = localStorage.getItem(`folder-colors-${stationId}`);
      if (!raw) return;
      setFolderColors(JSON.parse(raw) as Record<string, FolderColorKey>);
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

  const { data: playlistsData } = useQuery<Playlist[]>({
    queryKey: ["playlists", stationId],
    queryFn: () =>
      api.get(`/stations/${stationId}/playlists`).then((r) => r.data),
    enabled: !!stationId,
  });
  const playlists = playlistsData ?? EMPTY_PLAYLISTS;

  useEffect(() => {
    if (!playlists.length) {
      setSelectedPlaylistId(null);
      return;
    }

    if (!selectedPlaylistId) {
      setSelectedPlaylistId(
        initialPlaylistId ?? activePlaylistId ?? playlists[0].id,
      );
      return;
    }

    const exists = playlists.some(
      (playlist) => playlist.id === selectedPlaylistId,
    );
    if (!exists) setSelectedPlaylistId(playlists[0].id);
  }, [playlists, selectedPlaylistId, initialPlaylistId, activePlaylistId]);

  const selectedPlaylist = useMemo(
    () =>
      playlists.find((playlist) => playlist.id === selectedPlaylistId) ?? null,
    [playlists, selectedPlaylistId],
  );

  useEffect(() => {
    setFolderNameDraft(selectedPlaylist?.name ?? "");
  }, [selectedPlaylist?.id, selectedPlaylist?.name]);

  const activateFolderMutation = useMutation({
    mutationFn: (playlistId: string) =>
      api.post(`/stations/${stationId}/playlists/${playlistId}/activate`),
    onSuccess: (_res, playlistId) => {
      queryClient.invalidateQueries({ queryKey: ["playlists", stationId] });
      onActivePlaylistChange?.(playlistId);
    },
  });

  const renameFolderMutation = useMutation({
    mutationFn: ({ playlistId, name }: { playlistId: string; name: string }) =>
      api.put(`/playlists/${playlistId}`, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["playlists", stationId] });
    },
  });

  const deleteFolderMutation = useMutation({
    mutationFn: ({
      playlistId,
    }: {
      playlistId: string;
      fallbackId: string | null;
    }) => api.delete(`/playlists/${playlistId}`),
    onSuccess: async (_res, vars) => {
      queryClient.invalidateQueries({ queryKey: ["playlists", stationId] });
      queryClient.invalidateQueries({
        queryKey: ["playlist-tracks", vars.playlistId],
      });
      refreshUser().catch(() => {});

      if (vars.playlistId === activePlaylistId && vars.fallbackId) {
        await activateFolderMutation.mutateAsync(vars.fallbackId);
      }

      if (vars.fallbackId) {
        setSelectedPlaylistId(vars.fallbackId);
      } else {
        onBack();
      }
    },
  });

  const { data: tracksData, isLoading: tracksLoading } = useQuery<
    PlaylistTrack[]
  >({
    queryKey: ["playlist-tracks", selectedPlaylist?.id],
    queryFn: () =>
      api.get(`/playlists/${selectedPlaylist?.id}/tracks`).then((r) => r.data),
    enabled: !!selectedPlaylist?.id,
  });
  const tracks = tracksData ?? EMPTY_PLAYLIST_TRACKS;

  useEffect(() => {
    setOrderedTracks(tracksData ?? EMPTY_PLAYLIST_TRACKS);
    setEditingTrackId(null);
    setEditingTrackTitle("");
    setSelectedTrackIds([]);
    setOpenTrackMenuId(null);
    setTrackActionError(null);
    setIsBulkDeleteConfirmOpen(false);
  }, [selectedPlaylist?.id, tracksData]);

  const selectedTrackIdSet = useMemo(
    () => new Set(selectedTrackIds),
    [selectedTrackIds],
  );
  const selectedTracks = useMemo(
    () => orderedTracks.filter((track) => selectedTrackIdSet.has(track.id)),
    [orderedTracks, selectedTrackIdSet],
  );
  const hasSelectedTracks = selectedTracks.length > 0;

  const deleteTrackMutation = useMutation({
    mutationFn: (trackId: string) => api.delete(`/tracks/${trackId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["playlist-tracks", selectedPlaylist?.id],
      });
      queryClient.invalidateQueries({ queryKey: ["playlists", stationId] });
      refreshUser().catch(() => {});
    },
  });

  const renameTrackMutation = useMutation({
    mutationFn: ({
      trackId,
      title,
    }: {
      trackId: string;
      title: string | null;
    }) => api.put(`/tracks/${trackId}`, { title }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["playlist-tracks", selectedPlaylist?.id],
      });
    },
  });

  const reorderTracksMutation = useMutation({
    mutationFn: (items: Array<{ trackId: string; sortOrder: number }>) =>
      api.put(`/playlists/${selectedPlaylist?.id}/tracks/reorder`, { items }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["playlist-tracks", selectedPlaylist?.id],
      });
    },
  });

  const handleDeleteTrack = (track: PlaylistTrack) => {
    setTrackToDelete(track);
  };

  const handleToggleTrackSelection = (trackId: string) => {
    setTrackActionError(null);
    setSelectedTrackIds((prev) =>
      prev.includes(trackId)
        ? prev.filter((id) => id !== trackId)
        : [...prev, trackId],
    );
  };

  const downloadTrackFromServer = useCallback(async (track: PlaylistTrack) => {
    const response = await api.get(`/tracks/${track.id}/stream`, {
      responseType: "blob",
    });
    const fileName =
      parseContentDispositionFileName(
        (response.headers?.["content-disposition"] as string | undefined) ??
          (response.headers?.["Content-Disposition"] as string | undefined),
      ) ?? getTrackDownloadName(track);
    triggerBlobDownload(response.data as Blob, fileName);
  }, []);

  const handleDownloadTrack = useCallback(
    async (track: PlaylistTrack) => {
      if (isTrackDownloadPending || isBulkDownloadPending) return;
      setTrackActionError(null);
      setIsTrackDownloadPending(true);
      try {
        await downloadTrackFromServer(track);
      } catch (error) {
        setTrackActionError(
          getApiErrorMessage(error, "Failed to download track."),
        );
      } finally {
        setIsTrackDownloadPending(false);
      }
    },
    [downloadTrackFromServer, isBulkDownloadPending, isTrackDownloadPending],
  );

  const handleDownloadSelectedTracks = useCallback(async () => {
    if (!selectedTracks.length || isBulkDownloadPending || isTrackDownloadPending)
      return;

    setTrackActionError(null);
    setOpenTrackMenuId(null);
    setIsBulkDownloadPending(true);
    try {
      for (const track of selectedTracks) {
        // Keep order stable for batch downloads.
        // eslint-disable-next-line no-await-in-loop
        await downloadTrackFromServer(track);
      }
    } catch (error) {
      setTrackActionError(
        getApiErrorMessage(error, "Failed to download selected tracks."),
      );
    } finally {
      setIsBulkDownloadPending(false);
    }
  }, [
    downloadTrackFromServer,
    isBulkDownloadPending,
    isTrackDownloadPending,
    selectedTracks,
  ]);

  const handleConfirmBulkDelete = useCallback(async () => {
    if (!selectedTrackIds.length || isBulkDeletePending) return;

    setTrackActionError(null);
    setOpenTrackMenuId(null);
    setIsBulkDeletePending(true);
    try {
      for (const trackId of selectedTrackIds) {
        // eslint-disable-next-line no-await-in-loop
        await api.delete(`/tracks/${trackId}`);
      }
      await queryClient.invalidateQueries({
        queryKey: ["playlist-tracks", selectedPlaylist?.id],
      });
      await queryClient.invalidateQueries({ queryKey: ["playlists", stationId] });
      refreshUser().catch(() => {});
      setSelectedTrackIds([]);
      setIsBulkDeleteConfirmOpen(false);
    } catch (error) {
      setTrackActionError(
        getApiErrorMessage(error, "Failed to delete selected tracks."),
      );
    } finally {
      setIsBulkDeletePending(false);
    }
  }, [
    isBulkDeletePending,
    queryClient,
    refreshUser,
    selectedPlaylist?.id,
    selectedTrackIds,
    stationId,
  ]);

  const startTrackEdit = (track: PlaylistTrack) => {
    setEditingTrackId(track.id);
    setEditingTrackTitle(track.title ?? "");
  };

  const cancelTrackEdit = () => {
    setEditingTrackId(null);
    setEditingTrackTitle("");
  };

  const commitTrackEdit = () => {
    if (!editingTrackId) return;
    const current = orderedTracks.find((track) => track.id === editingTrackId);
    if (!current) return;

    const nextTitle = editingTrackTitle.trim();
    const currentTitle = (current.title ?? "").trim();
    if (nextTitle !== currentTitle) {
      renameTrackMutation.mutate({
        trackId: current.id,
        title: nextTitle.length > 0 ? nextTitle : null,
      });
    }

    cancelTrackEdit();
  };

  const handleTrackDragEnd = (event: DragEndEvent) => {
    const overId = event.over?.id ? String(event.over.id) : null;
    const activeId = String(event.active.id);
    if (!overId || activeId === overId) return;

    const oldIndex = orderedTracks.findIndex((track) => track.id === activeId);
    const newIndex = orderedTracks.findIndex((track) => track.id === overId);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(orderedTracks, oldIndex, newIndex);
    setOrderedTracks(reordered);
    reorderTracksMutation.mutate(
      reordered.map((track, idx) => ({ trackId: track.id, sortOrder: idx })),
    );
  };

  const handleCycleFolderColor = () => {
    if (!selectedPlaylist?.id) return;
    setFolderColors((prev) => {
      const current = prev[selectedPlaylist.id] ?? "orange";
      const idx = COLOR_ORDER.indexOf(current);
      const next = COLOR_ORDER[(idx + 1) % COLOR_ORDER.length];
      return { ...prev, [selectedPlaylist.id]: next };
    });
  };

  const handleDeleteFolder = () => {
    if (!selectedPlaylist || selectedPlaylist.isDefault) return;
    const ok = window.confirm(`Delete folder "${selectedPlaylist.name}"?`);
    if (!ok) return;

    const fallback =
      playlists.find((playlist) => playlist.id !== selectedPlaylist.id) ?? null;
    deleteFolderMutation.mutate({
      playlistId: selectedPlaylist.id,
      fallbackId: fallback?.id ?? null,
    });
  };

  const activeFolderColor = selectedPlaylist
    ? (folderColors[selectedPlaylist.id] ?? "orange")
    : "orange";

  useEffect(() => {
    if (!selectedPlaylist) return;
    const nextName = folderNameDraft.trim();
    if (!nextName || nextName === selectedPlaylist.name) return;

    const timer = window.setTimeout(() => {
      renameFolderMutation.mutate({
        playlistId: selectedPlaylist.id,
        name: nextName,
      });
    }, 500);

    return () => window.clearTimeout(timer);
  }, [folderNameDraft, selectedPlaylist?.id, selectedPlaylist?.name]);

  const addUploadFiles = (raw: FileList | File[]) => {
    const audio = Array.from(raw).filter(isSupportedAudioUploadFile);
    if (!audio.length) return;

    setUploadFiles((prev) => [
      ...prev,
      ...audio.map((file) => ({
        id: `${file.name}-${Date.now()}-${Math.random()}`,
        file,
        status: "pending" as const,
        progress: 0,
      })),
    ]);
  };

  const removeUploadFile = (id: string) => {
    setUploadFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const uploadOne = async (item: UploadFile) => {
    if (!selectedPlaylist?.id) return;
    setUploadFiles((prev) =>
      prev.map((f) =>
        f.id === item.id ? { ...f, status: "uploading" as const } : f,
      ),
    );

    try {
      const formData = new FormData();
      formData.append("file", item.file);

      const uploadResponse = await api.post(
        `/stations/${stationId}/tracks/upload?playlistId=${selectedPlaylist.id}`,
        formData,
        {
          headers: { "Content-Type": "multipart/form-data" },
          onUploadProgress: (e) => {
            const pct = e.total ? Math.round((e.loaded / e.total) * 100) : 0;
            setUploadFiles((prev) =>
              prev.map((f) => (f.id === item.id ? { ...f, progress: pct } : f)),
            );
          },
        },
      );

      setUploadFiles((prev) =>
        prev.map((f) =>
          f.id === item.id
            ? { ...f, status: "done" as const, progress: 100 }
            : f,
        ),
      );
      appendUploadedShowcaseCard(
        uploadResponse?.data as { id: string; hasCover: boolean } | undefined,
      );
      queryClient.invalidateQueries({
        queryKey: ["playlist-tracks", selectedPlaylist.id],
      });
      queryClient.invalidateQueries({ queryKey: ["playlists", stationId] });
      refreshUser().catch(() => {});
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? "Upload failed";
      setUploadFiles((prev) =>
        prev.map((f) =>
          f.id === item.id ? { ...f, status: "error" as const, error: msg } : f,
        ),
      );
    }
  };

  const uploadAll = async () => {
    const pending = uploadFiles.filter((f) => f.status === "pending");
    for (const item of pending) {
      // eslint-disable-next-line no-await-in-loop
      await uploadOne(item);
    }
  };

  const pendingUploadsCount = uploadFiles.filter(
    (f) => f.status === "pending",
  ).length;
  const hasPendingUploads = pendingUploadsCount > 0;
  const allUploadsDone =
    uploadFiles.length > 0 &&
    uploadFiles.every((f) => f.status === "done" || f.status === "error");
  const coverPool = useMemo(
    () =>
      orderedTracks
        .filter((track) => track.hasCover)
        .map((track) => `${API_URL}/tracks/${track.id}/cover`),
    [orderedTracks],
  );
  const activeFolderCoverUrls = useMemo(() => coverPool.slice(0, 3), [coverPool]);
  const uploadShowcaseMaxCards = isCompactShowcase
    ? MOBILE_MAX_UPLOAD_SHOWCASE_CARDS
    : DESKTOP_MAX_UPLOAD_SHOWCASE_CARDS;

  const buildInitialUploadShowcaseCards = useCallback(() => {
    const cards: UploadShowcaseCard[] = [];
    const desiredCount = isCompactShowcase
      ? Math.min(uploadShowcaseMaxCards, Math.max(3, coverPool.length || 3))
      : Math.min(uploadShowcaseMaxCards, Math.max(6, coverPool.length || 6));

    for (let idx = 0; idx < desiredCount; idx += 1) {
      const imageUrl = coverPool.length
        ? coverPool[Math.floor(Math.random() * coverPool.length)]
        : null;
      cards.push(
        createUploadShowcaseCard({
          id: `seed-${selectedPlaylist?.id ?? "none"}-${idx}-${Date.now()}`,
          imageUrl,
          existingCards: cards,
          isNew: false,
          isCompact: isCompactShowcase,
        }),
      );
    }

    return cards;
  }, [coverPool, isCompactShowcase, selectedPlaylist?.id, uploadShowcaseMaxCards]);

  const appendUploadedShowcaseCard = useCallback(
    (payload: { id: string; hasCover: boolean } | null | undefined) => {
      const imageUrl = payload?.hasCover
        ? `${API_URL}/tracks/${payload.id}/cover`
        : null;

      setUploadShowcaseCards((prev) => {
        const nextCard = createUploadShowcaseCard({
          id: `uploaded-${payload?.id ?? Date.now()}-${Math.random()}`,
          imageUrl,
          existingCards: prev,
          isNew: true,
          isCompact: isCompactShowcase,
        });

        return [nextCard, ...prev].slice(0, uploadShowcaseMaxCards);
      });
    },
    [isCompactShowcase, uploadShowcaseMaxCards],
  );

  useEffect(() => {
    if (!isUploadMode) {
      uploadShowcaseInitKeyRef.current = null;
      return;
    }

    const key = `${selectedPlaylist?.id ?? "none"}-${isCompactShowcase ? "compact" : "desktop"}`;
    if (uploadShowcaseInitKeyRef.current === key && uploadShowcaseCards.length) {
      return;
    }

    setUploadShowcaseCards(buildInitialUploadShowcaseCards());
    uploadShowcaseInitKeyRef.current = key;
  }, [
    isUploadMode,
    isCompactShowcase,
    selectedPlaylist?.id,
    uploadShowcaseCards.length,
    buildInitialUploadShowcaseCards,
  ]);

  useEffect(() => {
    if (!isUploadMode) return;

    let rafId = 0;
    let prevTime = 0;

    const frame = (now: number) => {
      const dtMs = prevTime ? now - prevTime : 16;
      prevTime = now;
      const dt = Math.min(dtMs / 16.6667, 1.6);

      setUploadShowcaseCards((prev) => {
        if (!prev.length) return prev;

        const container = uploadShowcaseAreaRef.current;
        if (!container) return prev;

        const width = Math.max(container.clientWidth, 1);
        const height = Math.max(container.clientHeight, 1);
        const pointer = uploadShowcasePointerRef.current;
        const count = prev.length;
        const forceX = new Array<number>(count).fill(0);
        const forceY = new Array<number>(count).fill(0);
        const centers = prev.map((card) => ({
          x: (card.left / 100) * width + card.offsetX,
          y: (card.top / 100) * height + card.offsetY,
        }));

        if (pointer.inside && isUploadShowcaseExpanded) {
          const cursorRadius = Math.min(width, height) * 0.38;
          const cursorPower = 0.9;

          for (let i = 0; i < count; i += 1) {
            const dx = centers[i].x - pointer.x;
            const dy = centers[i].y - pointer.y;
            const distance = Math.hypot(dx, dy) || 0.001;
            if (distance >= cursorRadius) continue;

            const influence = (1 - distance / cursorRadius) ** 2;
            const push = influence * cursorPower;
            forceX[i] += (dx / distance) * push;
            forceY[i] += (dy / distance) * push;
          }
        }

        const cardRepelStrength = isUploadShowcaseExpanded ? 0.46 : 0.25;
        const pairDistanceFactor = isUploadShowcaseExpanded ? 0.62 : 0.52;

        for (let i = 0; i < count; i += 1) {
          for (let j = i + 1; j < count; j += 1) {
            const dx = centers[i].x - centers[j].x;
            const dy = centers[i].y - centers[j].y;
            const distance = Math.hypot(dx, dy) || 0.001;
            const minDistance =
              ((prev[i].size + prev[j].size) / 2) * pairDistanceFactor;

            if (distance >= minDistance) continue;

            const overlap = (minDistance - distance) / minDistance;
            const repel = overlap * cardRepelStrength;
            const nx = dx / distance;
            const ny = dy / distance;
            forceX[i] += nx * repel;
            forceY[i] += ny * repel;
            forceX[j] -= nx * repel;
            forceY[j] -= ny * repel;
          }
        }

        const springBack = isUploadShowcaseExpanded ? 0.036 : 0.05;
        const damping = isUploadShowcaseExpanded ? 0.9 : 0.86;
        const maxOffset = isUploadShowcaseExpanded ? 46 : 24;

        return prev.map((card, idx) => {
          const waveForceX =
            Math.sin(now * 0.00058 + card.floatPhaseX) *
            (isUploadShowcaseExpanded ? 0.12 : 0.03);
          const waveForceY =
            Math.cos(now * 0.00053 + card.floatPhaseY) *
            (isUploadShowcaseExpanded ? 0.12 : 0.03);

          const totalForceX =
            forceX[idx] + waveForceX - card.offsetX * springBack;
          const totalForceY =
            forceY[idx] + waveForceY - card.offsetY * springBack;

          let velocityX = (card.velocityX + totalForceX * dt) * damping;
          let velocityY = (card.velocityY + totalForceY * dt) * damping;
          let offsetX = card.offsetX + velocityX * dt;
          let offsetY = card.offsetY + velocityY * dt;

          const distanceFromOrigin = Math.hypot(offsetX, offsetY);
          if (distanceFromOrigin > maxOffset) {
            const ratio = maxOffset / distanceFromOrigin;
            offsetX *= ratio;
            offsetY *= ratio;
            velocityX *= 0.72;
            velocityY *= 0.72;
          }

          const rotateForce = velocityX * 0.006 - card.rotateOffset * 0.09;
          const rotateVelocity =
            (card.rotateVelocity + rotateForce * dt) * 0.86;
          const rotateOffset = Math.max(
            Math.min(card.rotateOffset + rotateVelocity * dt, 8),
            -8,
          );

          return {
            ...card,
            offsetX,
            offsetY,
            velocityX,
            velocityY,
            rotateOffset,
            rotateVelocity,
            isNew: false,
          };
        });
      });

      rafId = window.requestAnimationFrame(frame);
    };

    rafId = window.requestAnimationFrame(frame);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [isUploadMode, isUploadShowcaseExpanded]);

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
          className="px-3 py-3 md:px-4 md:py-4"
        >
          <Button
            variant="ghost"
            size="md"
            className="!px-0 mb-4"
            onClick={onBack}
          >
            <ArrowLeft size={14} />
            Back
          </Button>

          <div className="flex flex-col items-center gap-4 md:flex-row md:items-center md:gap-6">
            <div className="md:ml-6">
              <ActiveFolderArtwork
                color={activeFolderColor}
                onClick={handleCycleFolderColor}
                coverUrls={activeFolderCoverUrls}
              />
            </div>

            <div className="min-w-0 flex-1 w-full text-center md:text-left">
              <input
                value={folderNameDraft}
                onChange={(e) => setFolderNameDraft(e.target.value)}
                placeholder="Folder name"
                className="w-full bg-transparent text-center md:text-left text-4xl font-black leading-tight text-[--text-primary] focus:outline-none focus-visible:outline-none"
                style={{
                  background: "transparent",
                  border: "none",
                  outline: "none",
                }}
              />
              <p className="text-sm text-[--text-muted] mt-2">
                {selectedPlaylist
                  ? `${selectedPlaylist.trackCount} track${selectedPlaylist.trackCount === 1 ? "" : "s"}`
                  : "No folder selected"}
              </p>

              <div className="mt-4 flex items-center justify-center md:justify-start gap-2 flex-nowrap overflow-x-auto md:flex-wrap md:overflow-visible">
                <Button
                  size="sm"
                  className="!px-0 shrink-0 md:shrink"
                  onClick={() =>
                    selectedPlaylist?.id &&
                    activateFolderMutation.mutate(selectedPlaylist.id)
                  }
                  isLoading={activateFolderMutation.isPending}
                  disabled={
                    !selectedPlaylist ||
                    selectedPlaylist.id === activePlaylistId
                  }
                >
                  <Play size={13} />
                  {selectedPlaylist?.id === activePlaylistId
                    ? "Active folder"
                    : "Activate folder"}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="shrink-0 md:shrink"
                  onClick={() => setIsUploadMode((prev) => !prev)}
                  disabled={!selectedPlaylist}
                >
                  <Plus size={13} />
                  {isUploadMode ? "Close add tracks" : "Add tracks"}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  className="shrink-0 md:shrink"
                  onClick={handleDeleteFolder}
                  isLoading={deleteFolderMutation.isPending}
                  disabled={!selectedPlaylist || selectedPlaylist.isDefault}
                >
                  <Trash2 size={13} />
                  Delete folder
                </Button>
              </div>
            </div>
          </div>
        </motion.section>
      </div>

      <div className="flex-1 overflow-y-auto p-2 md:p-4">
        {isUploadMode ? (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="max-w-5xl mx-auto min-h-full flex flex-col justify-center w-full"
          >
            <input
              ref={uploadInputRef}
              type="file"
              accept="audio/*"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && addUploadFiles(e.target.files)}
            />

            <div className="relative py-2 sm:py-5">
              <div className="relative text-center">
                <p className="text-4xl font-black text-[--text-primary] tracking-tight leading-none">
                  Publish tracks
                </p>
                <p className="mt-2 text-sm text-[--text-secondary] max-w-xl mx-auto">
                  Covers from the current folder are shown as floating cards.
                  Hover to make them drift like leaves on water.
                </p>

                <div
                  ref={uploadShowcaseAreaRef}
                  className="mx-auto mt-8 relative h-[300px] w-full max-w-[880px] sm:h-[360px]"
                  onMouseEnter={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    uploadShowcasePointerRef.current = {
                      x: e.clientX - rect.left,
                      y: e.clientY - rect.top,
                      inside: true,
                    };
                    setIsUploadShowcaseExpanded(true);
                  }}
                  onMouseMove={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    uploadShowcasePointerRef.current = {
                      x: e.clientX - rect.left,
                      y: e.clientY - rect.top,
                      inside: true,
                    };
                  }}
                  onMouseLeave={() => {
                    uploadShowcasePointerRef.current.inside = false;
                    if (showcaseSupportsHover) setIsUploadShowcaseExpanded(false);
                  }}
                  onFocusCapture={() => setIsUploadShowcaseExpanded(true)}
                  onBlurCapture={(e) => {
                    if (!showcaseSupportsHover) return;
                    const next = e.relatedTarget as Node | null;
                    if (next && e.currentTarget.contains(next)) return;
                    setIsUploadShowcaseExpanded(false);
                  }}
                >
                  <AnimatePresence>
                    {uploadShowcaseCards.map((card) => (
                      <motion.button
                        key={card.id}
                        type="button"
                        title="Upload tracks"
                        onClick={() => uploadInputRef.current?.click()}
                        initial={
                          card.isNew
                            ? { opacity: 0, scale: 0.52, y: 14 }
                            : { opacity: 0, scale: 0.88, y: 10 }
                        }
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.78 }}
                        transition={{ duration: card.isNew ? 0.44 : 0.28 }}
                        className="absolute -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[10px] border bg-white shadow-[0_10px_24px_rgba(0,0,0,0.09)]"
                        style={{
                          left: `${card.left}%`,
                          top: `${card.top}%`,
                          width: card.size,
                          height: card.size,
                          borderColor: "rgba(0,0,0,0.06)",
                          x: card.offsetX,
                          y: card.offsetY,
                          rotate: card.rotation + card.rotateOffset,
                        }}
                      >
                        {card.imageUrl ? (
                          <img
                            src={card.imageUrl}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center bg-white">
                            <Music2 size={24} className="text-[--text-muted]" />
                          </div>
                        )}
                      </motion.button>
                    ))}
                  </AnimatePresence>
                </div>

                <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="!pl-0"
                    onClick={() => uploadInputRef.current?.click()}
                    title="Open file picker"
                  >
                    <Upload size={18} />
                    Browse files
                  </Button>
                </div>
              </div>
            </div>

            {uploadFiles.length > 0 && (
              <div className="mt-5 space-y-2">
                {uploadFiles.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 bg-[--bg-elevated] rounded-xl px-3 py-2.5"
                  >
                    <Music2
                      size={14}
                      className="text-[--text-muted] flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-[--text-primary] truncate">
                        {item.file.name}
                      </p>
                      <p className="text-[10px] text-[--text-muted] mt-0.5">
                        {formatFileSize(item.file.size)}
                      </p>
                      {item.status === "uploading" && (
                        <div className="mt-1 h-1 rounded-full bg-[--border] overflow-hidden">
                          <motion.div
                            className="h-full rounded-full bg-[--color-accent]"
                            style={{ width: `${item.progress}%` }}
                            transition={{ duration: 0.2 }}
                          />
                        </div>
                      )}
                      {item.status === "error" && (
                        <p className="text-[10px] text-red-400 mt-0.5">
                          {item.error}
                        </p>
                      )}
                    </div>
                    <div className="flex-shrink-0">
                      {item.status === "pending" && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeUploadFile(item.id);
                          }}
                          className="text-[--text-muted] hover:text-[--text-primary]"
                        >
                          <X size={12} />
                        </button>
                      )}
                      {item.status === "uploading" && (
                        <Loader2
                          size={14}
                          className="text-[--color-accent] animate-spin"
                        />
                      )}
                      {item.status === "done" && (
                        <CheckCircle2 size={14} className="text-emerald-500" />
                      )}
                      {item.status === "error" && (
                        <AlertCircle size={14} className="text-red-400" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </motion.section>
        ) : (
          <div className="p-0">
            {tracksLoading ? (
              <div className="flex justify-center py-8">
                <div className="w-5 h-5 border-2 border-[--color-accent] border-t-transparent rounded-full animate-spin" />
              </div>
            ) : orderedTracks.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-36 text-[--text-muted]">
                <Folder size={24} className="mb-2 opacity-30" />
                <p className="text-sm">No tracks in this folder</p>
              </div>
            ) : (
              <div className="relative space-y-2">
                {hasSelectedTracks && (
                  <div
                    className="pb-2 flex flex-wrap items-center gap-2"
                    style={{
                      borderBottom: "1px solid rgba(128, 128, 128, 0.18)",
                    }}
                  >
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={
                        isBulkDownloadPending ||
                        isTrackDownloadPending ||
                        isBulkDeletePending
                      }
                      isLoading={isBulkDownloadPending}
                      onClick={handleDownloadSelectedTracks}
                    >
                      <Download size={13} />
                      Download selected
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={isBulkDeletePending || isBulkDownloadPending}
                      isLoading={isBulkDeletePending}
                      onClick={() => setIsBulkDeleteConfirmOpen(true)}
                    >
                      <Trash2 size={13} />
                      Delete selected
                    </Button>
                  </div>
                )}

                {trackActionError && (
                  <p className="text-xs text-red-500">{trackActionError}</p>
                )}

                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleTrackDragEnd}
                >
                  <SortableContext
                    items={orderedTracks.map((track) => track.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="space-y-1">
                      {orderedTracks.map((track) => (
                        <SortableFolderTrackRow
                          key={track.id}
                          track={track}
                          isCurrentTrack={track.id === currentTrackId}
                          canReorder={!reorderTracksMutation.isPending}
                          canSelect={true}
                          isSelected={selectedTrackIdSet.has(track.id)}
                          selectionDisabled={
                            reorderTracksMutation.isPending ||
                            deleteTrackMutation.isPending ||
                            isBulkDeletePending
                          }
                          onToggleSelect={handleToggleTrackSelection}
                          deleting={
                            deleteTrackMutation.isPending || isBulkDeletePending
                          }
                          downloading={
                            isTrackDownloadPending || isBulkDownloadPending
                          }
                          menuOpen={openTrackMenuId === track.id}
                          onOpenMenu={() =>
                            setOpenTrackMenuId((prev) =>
                              prev === track.id ? null : track.id,
                            )
                          }
                          onCloseMenu={() => setOpenTrackMenuId(null)}
                          onDownload={() => handleDownloadTrack(track)}
                          onDelete={() => handleDeleteTrack(track)}
                          onStartEdit={() => startTrackEdit(track)}
                          isEditing={editingTrackId === track.id}
                          editingTitle={editingTrackTitle}
                          onEditingTitleChange={setEditingTrackTitle}
                          onCommitEdit={commitTrackEdit}
                          onCancelEdit={cancelTrackEdit}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              </div>
            )}
          </div>
        )}
      </div>

      {isUploadMode && (
        <div
          className="h-16 px-4 flex items-center justify-between gap-2"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          <p className="text-xs text-[--text-muted]">
            {uploadFiles.length} file{uploadFiles.length !== 1 ? "s" : ""}{" "}
            selected
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setUploadFiles([]);
                setIsUploadMode(false);
              }}
            >
              {allUploadsDone ? "Done" : "Cancel upload"}
            </Button>
            {hasPendingUploads && (
              <Button size="sm" onClick={uploadAll}>
                <Upload size={13} />
                Upload {pendingUploadsCount}
              </Button>
            )}
          </div>
        </div>
      )}

      <ConfirmModal
        open={!!trackToDelete}
        title="Delete track?"
        description={
          trackToDelete
            ? `Track "${trackToDelete.title ?? trackToDelete.filename}" will be removed permanently.`
            : ""
        }
        confirmLabel="Delete track"
        loading={deleteTrackMutation.isPending}
        onCancel={() => setTrackToDelete(null)}
        onConfirm={() => {
          if (!trackToDelete) return;
          setTrackActionError(null);
          deleteTrackMutation.mutate(trackToDelete.id, {
            onSettled: () => setTrackToDelete(null),
          });
        }}
      />
      <ConfirmModal
        open={isBulkDeleteConfirmOpen}
        title="Delete selected tracks?"
        description={`Selected tracks (${selectedTrackIds.length}) will be removed permanently.`}
        confirmLabel="Delete selected"
        loading={isBulkDeletePending}
        onCancel={() => setIsBulkDeleteConfirmOpen(false)}
        onConfirm={handleConfirmBulkDelete}
      />
    </div>
  );
}
