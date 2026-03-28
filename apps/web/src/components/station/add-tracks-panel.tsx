"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
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
  CheckCircle2,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDuration, formatFileSize } from "@/lib/utils";
import api from "@/lib/api";

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

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

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

function SortableFolderTrackRow({
  track,
  onDelete,
  onStartEdit,
  isEditing,
  editingTitle,
  onEditingTitleChange,
  onCommitEdit,
  onCancelEdit,
  canReorder,
  deleting,
  isCurrentTrack,
}: {
  track: PlaylistTrack;
  onDelete: () => void;
  onStartEdit: () => void;
  isEditing: boolean;
  editingTitle: string;
  onEditingTitleChange: (value: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  canReorder: boolean;
  deleting: boolean;
  isCurrentTrack: boolean;
}) {
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

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      className={`relative flex items-center gap-3 p-2.5 rounded-xl transition-colors ${
        isCurrentTrack ? "bg-[--color-accent-muted]" : "hover:bg-[--bg-subtle]"
      }`}
    >
      <button
        {...attributes}
        {...listeners}
        disabled={!canReorder}
        className="text-[--text-muted] hover:text-[--text-secondary] cursor-grab active:cursor-grabbing disabled:opacity-30"
        title="Reorder"
      >
        <GripVertical size={14} />
      </button>

      <div className="w-8 h-8 rounded-lg overflow-hidden flex-shrink-0 bg-[--bg-subtle]">
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
            onClick={onStartEdit}
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

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onDelete}
        title="Delete track"
        disabled={deleting}
        className="text-red-400 hover:text-red-500"
      >
        <Trash2 size={14} />
      </Button>
    </div>
  );
}

function ActiveFolderArtwork({
  color,
  onClick,
}: {
  color: FolderColorKey;
  onClick: () => void;
}) {
  const palette = FOLDER_PALETTE[color] ?? FOLDER_PALETTE.orange;

  return (
    <button
      onClick={onClick}
      className="relative w-[180px] h-[142px]"
      style={{ perspective: 900 }}
      title="Change folder color"
    >
      <div
        className="absolute right-6 top-4 w-20 h-7 rounded-t-[8px]"
        style={{ background: palette.tab }}
      />
      <div
        className="absolute left-5 right-5 top-9 h-[92px] rounded-[12px]"
        style={{ background: palette.back }}
      />
      <div
        className="absolute left-5 right-5 top-9 h-[92px] rounded-[12px]"
        style={{
          background: palette.front,
          transform: "rotateX(-22deg) rotateY(8deg) skewX(10deg)",
          transformOrigin: "right bottom",
        }}
      >
        <div
          className="absolute inset-x-6 top-10 h-4 rounded-[3px]"
          style={{ background: "rgba(255,255,255,0.12)" }}
        />
      </div>
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

  const { data: playlists = [] } = useQuery<Playlist[]>({
    queryKey: ["playlists", stationId],
    queryFn: () =>
      api.get(`/stations/${stationId}/playlists`).then((r) => r.data),
    enabled: !!stationId,
  });

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

  const { data: tracks = [], isLoading: tracksLoading } = useQuery<
    PlaylistTrack[]
  >({
    queryKey: ["playlist-tracks", selectedPlaylist?.id],
    queryFn: () =>
      api.get(`/playlists/${selectedPlaylist?.id}/tracks`).then((r) => r.data),
    enabled: !!selectedPlaylist?.id,
  });

  useEffect(() => {
    setOrderedTracks(tracks);
    setEditingTrackId(null);
    setEditingTrackTitle("");
  }, [tracks]);

  const deleteTrackMutation = useMutation({
    mutationFn: (trackId: string) => api.delete(`/tracks/${trackId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["playlist-tracks", selectedPlaylist?.id],
      });
      queryClient.invalidateQueries({ queryKey: ["playlists", stationId] });
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
    const label = track.title ?? track.filename;
    const ok = window.confirm(`Удалить трек "${label}"?`);
    if (!ok) return;
    deleteTrackMutation.mutate(track.id);
  };

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
    const ok = window.confirm(`Удалить папку "${selectedPlaylist.name}"?`);
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
    const audio = Array.from(raw).filter((f) => f.type.startsWith("audio/"));
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

      await api.post(
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
      queryClient.invalidateQueries({
        queryKey: ["playlist-tracks", selectedPlaylist.id],
      });
      queryClient.invalidateQueries({ queryKey: ["playlists", stationId] });
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
            <ActiveFolderArtwork
              color={activeFolderColor}
              onClick={handleCycleFolderColor}
            />

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
            className="max-w-3xl"
          >
            <div>
              <div className="flex items-center gap-2 mb-6">
                <p className="text-4xl font-black text-[--text-primary] tracking-tight leading-none">
                  Publish tracks
                </p>
              </div>
              <p className="-mt-3 mb-5 text-sm text-[--text-muted]">
                Upload files to publish new tracks in this folder. Supported
                formats: MP3, FLAC, WAV, AAC.
              </p>
            </div>

            <div className="mt-5">
              <input
                ref={uploadInputRef}
                type="file"
                accept="audio/*"
                multiple
                className="hidden"
                onChange={(e) =>
                  e.target.files && addUploadFiles(e.target.files)
                }
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="!pl-0"
                onClick={() => uploadInputRef.current?.click()}
                title="Add tracks"
              >
                <Upload size={18} />
                Add tracks
              </Button>
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
                    {orderedTracks.map((track, idx) => (
                      <SortableFolderTrackRow
                        key={track.id}
                        track={track}
                        isCurrentTrack={track.id === currentTrackId}
                        canReorder={!reorderTracksMutation.isPending}
                        deleting={deleteTrackMutation.isPending}
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
            )}
          </div>
        )}
      </div>

      {isUploadMode && (
        <div
          className="px-4 py-3 flex items-center justify-between gap-2"
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
    </div>
  );
}
