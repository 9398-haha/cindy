import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WallpaperId, WallpaperMotion } from '@/../shared/appearanceSettings';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { HIDDEN_ANIMATION_ATTR } from '@/lib/hiddenAnimationGate';
import { getWallpaperVideo } from '@/lib/wallpaper';

/** One decoder and one viewport canvas. Static mode does not fetch any video. */
export function WallpaperVideo({
  wallpaperId,
  motion,
}: {
  wallpaperId: WallpaperId;
  motion: WallpaperMotion;
}) {
  const reducedMotion = useReducedMotion();
  const src = motion === 'dynamic' && !reducedMotion ? getWallpaperVideo(wallpaperId) : undefined;
  return src ? <PlayingWallpaper key={src} src={src} /> : null;
}

function PlayingWallpaper({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useLayoutEffect(() => {
    if (!ready || failed) return;
    document.documentElement.dataset.wallpaperMotion = 'dynamic';
    return () => {
      delete document.documentElement.dataset.wallpaperMotion;
    };
  }, [ready, failed]);

  useEffect(() => {
    const video = ref.current;
    if (!video || failed) return;
    // Effect replay (StrictMode/HMR) may follow a cleanup on the same element.
    video.src = src;
    let generation = 0;
    const sync = () => {
      const current = ++generation;
      // The shared gate also covers Electron minimize/hide with throttling disabled.
      if (document.hidden || document.documentElement.hasAttribute(HIDDEN_ANIMATION_ATTR)) {
        video.pause();
      } else {
        void video.play().catch(() => {
          if (generation === current) setFailed(true);
        });
      }
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [HIDDEN_ANIMATION_ATTR],
    });
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      generation++;
      observer.disconnect();
      document.removeEventListener('visibilitychange', sync);
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [failed, src]);

  if (failed) return null;
  return createPortal(
    <div
      className="app-wallpaper-video"
      aria-hidden="true"
      style={{ visibility: ready ? 'visible' : 'hidden' }}
    >
      <video
        ref={ref}
        src={src}
        muted
        loop
        playsInline
        preload="auto"
        disablePictureInPicture
        onPlaying={() => setReady(true)}
        onError={() => setFailed(true)}
      />
    </div>,
    document.body,
  );
}
