"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Volume2, VolumeX } from "lucide-react";
import { useAudioStore } from "@/stores/audio.store";
import { Button } from "@/components/ui/button";

export function HeaderVolumeControl() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const volume = useAudioStore((s) => s.volume);
  const setVolume = useAudioStore((s) => s.setVolume);

  useEffect(() => {
    const onDocClick = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  return (
    <div className="relative" ref={rootRef}>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setOpen((v) => !v)}
        aria-label="Volume"
      >
        {volume <= 0.001 ? <VolumeX size={14} /> : <Volume2 size={14} />}
      </Button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ width: 0, opacity: 0, x: 8 }}
            animate={{ width: 164, opacity: 1, x: 0 }}
            exit={{ width: 0, opacity: 0, x: 8 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="absolute right-full top-1/2 -translate-y-1/2 h-8 overflow-hidden flex items-center"
          >
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(volume * 100)}
              onChange={(event) => setVolume(Number(event.target.value) / 100)}
              className="header-volume-slider w-[148px] bg-transparent"
              style={{ accentColor: "#E8440F" }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
