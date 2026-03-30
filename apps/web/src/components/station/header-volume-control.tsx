"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Volume1, Volume2, VolumeX } from "lucide-react";
import { useAudioStore } from "@/stores/audio.store";
import { Button } from "@/components/ui/button";

const VOLUME_STEP_PERCENT = 25;

export function HeaderVolumeControl() {
  const [isHovering, setIsHovering] = useState(false);
  const volume = useAudioStore((s) => s.volume);
  const setVolume = useAudioStore((s) => s.setVolume);
  const volumePercent = Math.round(volume * 100);

  const VolumeIcon = useMemo(() => {
    if (volumePercent <= 0) return VolumeX;
    if (volumePercent <= 34) return Volume1;
    return Volume2;
  }, [volumePercent]);

  const handleVolumeStep = () => {
    const stepped = Math.round(volumePercent / VOLUME_STEP_PERCENT) * VOLUME_STEP_PERCENT;
    const next = stepped >= 100 ? 0 : stepped + VOLUME_STEP_PERCENT;
    setVolume(next / 100);
  };

  return (
    <div
      className="relative flex items-center"
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      <motion.span
        key={volumePercent}
        initial={false}
        animate={{
          width: isHovering ? 42 : 0,
          opacity: isHovering ? 1 : 0,
          marginRight: isHovering ? 4 : 0,
        }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        className="inline-block overflow-hidden whitespace-nowrap text-right text-[11px] tabular-nums text-[--text-secondary]"
      >
        {volumePercent}%
      </motion.span>

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={handleVolumeStep}
        aria-label={`Volume ${volumePercent}%`}
      >
        <VolumeIcon size={14} />
      </Button>
    </div>
  );
}
