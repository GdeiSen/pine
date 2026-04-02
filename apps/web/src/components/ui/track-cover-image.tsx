"use client";

import { useEffect, useState } from "react";
import { Music2 } from "lucide-react";

interface TrackCoverImageProps {
  src?: string | null;
  alt?: string;
  imageClassName?: string;
  fallbackClassName?: string;
  fallbackIconSize?: number;
}

export function TrackCoverImage({
  src,
  alt = "",
  imageClassName = "w-full h-full object-cover",
  fallbackClassName = "w-full h-full flex items-center justify-center",
  fallbackIconSize = 14,
}: TrackCoverImageProps) {
  const [failed, setFailed] = useState(false);
  const hasImage = !!src && !failed;

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!hasImage) {
    return (
      <div className={fallbackClassName}>
        <Music2 size={fallbackIconSize} className="text-[--text-muted]" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={imageClassName}
      onError={() => setFailed(true)}
    />
  );
}
