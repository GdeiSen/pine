'use client'

import { motion, AnimatePresence } from 'framer-motion'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { formatDuration } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { GripVertical, Music2 } from 'lucide-react'
import type { QueueItem } from '@web-radio/shared'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api'

function SortableQueueItem({
  item,
  isCurrentTrack,
  systemIndex,
}: {
  item: QueueItem
  isCurrentTrack: boolean
  systemIndex?: number
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const coverUrl = item.track.hasCover ? `${API_URL}/tracks/${item.track.id}/cover` : null

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 p-2.5 rounded-xl transition-colors ${
        isCurrentTrack ? 'bg-[--color-accent-muted]' : 'hover:bg-[--bg-subtle]'
      }`}
    >
      {item.queueType === 'SYSTEM' && typeof systemIndex === 'number' && (
        <span className="w-5 text-right text-xs font-semibold text-[--text-muted] tabular-nums">
          {systemIndex}
        </span>
      )}

      <button
        {...attributes}
        {...listeners}
        className="text-[--text-muted] hover:text-[--text-secondary] cursor-grab active:cursor-grabbing"
      >
        <GripVertical size={14} />
      </button>

      <div
        className={`w-8 h-8 rounded-lg overflow-hidden flex-shrink-0 ${
          coverUrl ? 'bg-[--bg-subtle]' : 'bg-gray-500/20'
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
        <p className="text-sm font-medium text-[--text-primary] truncate">
          {item.track.title ?? item.track.id}
        </p>
        <p className="text-xs text-[--text-muted] truncate">{item.track.artist ?? '—'}</p>
      </div>

      <div className="flex flex-col items-end gap-1 flex-shrink-0">
        <span className="text-xs text-[--text-muted]">{formatDuration(item.track.duration)}</span>
        {item.queueType === 'USER' && (
          <Badge variant="accent" className="text-[10px]">
            added
          </Badge>
        )}
      </div>
    </div>
  )
}

interface QueuePanelProps {
  queue: QueueItem[]
  currentTrackId?: string | null
  onReorder: (items: Array<{ id: string; position: number }>) => void
  canReorder: boolean
}

export function QueuePanel({ queue, currentTrackId, onReorder, canReorder }: QueuePanelProps) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const userQueue = queue.filter((i) => i.queueType === 'USER')
  const systemQueue = queue.filter((i) => i.queueType === 'SYSTEM')

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = queue.findIndex((i) => i.id === active.id)
    const newIndex = queue.findIndex((i) => i.id === over.id)
    const newOrder = arrayMove(queue, oldIndex, newIndex)

    onReorder(newOrder.map((item, idx) => ({ id: item.id, position: idx })))
  }

  if (queue.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-40 text-[--text-muted]">
        <Music2 size={32} className="mb-2 opacity-30" />
        <p className="text-sm">Queue is empty</p>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext
          items={canReorder ? queue.map((i) => i.id) : []}
          strategy={verticalListSortingStrategy}
        >
          {userQueue.length > 0 && (
            <>
              <p className="text-xs font-medium text-[--text-muted] px-2.5 py-1.5 uppercase tracking-wider">
                Queue ({userQueue.length})
              </p>
              {userQueue.map((item) => (
                <SortableQueueItem
                  key={item.id}
                  item={item}
                  isCurrentTrack={item.track.id === currentTrackId}
                />
              ))}
            </>
          )}

          {systemQueue.length > 0 && (
            <>
              <div className="border-t border-[--border] my-2" />
              <p className="text-xs font-medium text-[--text-muted] px-2.5 py-1.5 uppercase tracking-wider">
                Auto-play ({systemQueue.length})
              </p>
              {systemQueue.slice(0, 10).map((item, idx) => (
                <SortableQueueItem
                  key={item.id}
                  item={item}
                  isCurrentTrack={item.track.id === currentTrackId}
                  systemIndex={idx + 1}
                />
              ))}
              {systemQueue.length > 10 && (
                <p className="text-xs text-[--text-muted] text-center py-2">
                  +{systemQueue.length - 10} more
                </p>
              )}
            </>
          )}
        </SortableContext>
      </DndContext>
    </div>
  )
}
