'use client'

import { TrackInfo } from '@/components/station/track-info'

interface ListenOnlyPlayerCardProps {
  track: {
    id: string
    title: string | null
    artist: string | null
    album: string | null
    year: number | null
    genre: string | null
    duration: number
    hasCover: boolean
    quality: string
  }
  currentPosition: number
  isPaused: boolean
  isPlaying: boolean
  listenerCount: number
  stationName: string
  stationCode: string
  audioNeedsRestart: boolean
  onRestartAudio: () => void
}

export function ListenOnlyPlayerCard({
  track,
  currentPosition,
  isPaused,
  isPlaying,
  listenerCount,
  stationName,
  stationCode,
  audioNeedsRestart,
  onRestartAudio,
}: ListenOnlyPlayerCardProps) {
  return (
    <div className="mt-2 w-full">
      <div
        style={{
          borderRadius: 16,
          overflow: 'hidden',
          background: 'var(--bg-elevated)',
        }}
      >
        <TrackInfo
          track={track}
          currentQueueType={null}
          currentPosition={currentPosition}
          isPaused={isPaused}
          isPlaying={isPlaying}
          listenerCount={listenerCount}
          stationName={stationName}
          stationCode={stationCode}
          canControl={false}
          audioNeedsRestart={audioNeedsRestart}
          loopMode="none"
          shuffleEnabled={false}
          onPlayPause={() => {}}
          onRestartAudio={onRestartAudio}
          onSkip={() => {}}
          onPrev={() => {}}
          onSeek={() => {}}
          progressInteractive={false}
          onToggleLoop={() => {}}
          onToggleShuffle={() => {}}
        />
      </div>
    </div>
  )
}
