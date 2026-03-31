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
  displayDuration?: number
  isPaused: boolean
  isPlaying: boolean
  listenerCount: number
  stationName: string
  stationCode: string
  audioNeedsRestart: boolean
  audioConnectionState: 'idle' | 'connecting' | 'buffering' | 'reconnecting' | 'playing' | 'paused' | 'blocked'
  audioConnectionMessage: string | null
  audioDiagnostics: {
    driftMs: number | null
    targetPosition: number | null
    actualPosition: number | null
    syncType: string | null
    rttMs: number | null
    updatedAt: number
  } | null
  onRestartAudio: () => void
}

export function ListenOnlyPlayerCard({
  track,
  currentPosition,
  displayDuration,
  isPaused,
  isPlaying,
  listenerCount,
  stationName,
  stationCode,
  audioNeedsRestart,
  audioConnectionState,
  audioConnectionMessage,
  audioDiagnostics,
  onRestartAudio,
}: ListenOnlyPlayerCardProps) {
  return (
    <div className="mt-2 w-full">
      <div
        className="h-[320px] lg:h-[425px]"
        style={{
          borderRadius: 16,
          overflow: 'hidden',
          background: 'var(--bg-elevated)',
        }}
      >
        <TrackInfo
          track={track}
          currentPosition={currentPosition}
          displayDuration={displayDuration}
          isPaused={isPaused}
          isPlaying={isPlaying}
          listenerCount={listenerCount}
          stationName={stationName}
          stationCode={stationCode}
          canControl={false}
          audioNeedsRestart={audioNeedsRestart}
          audioConnectionState={audioConnectionState}
          audioConnectionMessage={audioConnectionMessage}
          audioDiagnostics={audioDiagnostics}
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
