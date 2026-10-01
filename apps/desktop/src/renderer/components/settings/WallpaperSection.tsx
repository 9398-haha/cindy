import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { useWallpaperSettings } from '@/hooks/useWallpaperSettings';
import { getBuiltinWallpaperBackground, isSceneWallpaper } from '@/lib/wallpaper';
import {
  APPEARANCE_LIMITS,
  DEFAULT_APPEARANCE_SETTINGS,
  type WallpaperId,
} from '@/../shared/appearanceSettings';

const WALLPAPER_OPTIONS: Array<{ id: WallpaperId }> = [
  { id: 'none' },
  { id: 'cindy-window' },
  { id: 'cindy-studio' },
  { id: 'cindy-dream' },
];

export function WallpaperSection() {
  const { t } = useTranslation();
  const {
    wallpaperId,
    wallpaperOverlay,
    wallpaperMotion,
    setWallpaper,
    setOverlay,
    setMotion,
    resetWallpaper,
  } = useWallpaperSettings();

  return (
    <div
      id="settings-search-settings-appearance-wallpaper"
      className={cn(
        'flex flex-col gap-4 rounded-xl border p-5',
        'border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-13 font-medium text-[var(--settings-section-sublabel)]">
            {t('settings.appearance.wallpaper.title')}
          </h3>
          <p className="mt-1 text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.appearance.wallpaper.description')}
          </p>
        </div>
        <Button
          variant="secondary"
          size="lg"
          className="shrink-0 px-3"
          type="button"
          onClick={resetWallpaper}
          disabled={
            wallpaperId === DEFAULT_APPEARANCE_SETTINGS.wallpaperId &&
            wallpaperOverlay === DEFAULT_APPEARANCE_SETTINGS.wallpaperOverlay &&
            wallpaperMotion === DEFAULT_APPEARANCE_SETTINGS.wallpaperMotion
          }
        >
          <RotateCcw size={14} />
          <span>{t('settings.appearance.wallpaper.reset')}</span>
        </Button>
      </div>

      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"
        role="radiogroup"
        aria-label={t('settings.appearance.wallpaper.aria')}
      >
        {WALLPAPER_OPTIONS.map((option) => {
          const selected = wallpaperId === option.id;
          const background = getBuiltinWallpaperBackground(option.id);
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={t('settings.appearance.wallpaper.options.' + option.id)}
              onClick={() => setWallpaper(option.id)}
              className={cn(
                'flex min-w-0 flex-col gap-2 rounded-xl text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--settings-theme-icon-active)]',
              )}
            >
              <span
                className={cn(
                  'relative h-16 overflow-hidden rounded-xl border bg-[var(--settings-input-bg)]',
                  selected
                    ? 'border-2 border-[var(--settings-theme-preview-border-active)]'
                    : 'border-[var(--settings-theme-preview-border)]',
                )}
                style={{
                  backgroundImage: background,
                  backgroundPosition: 'center',
                  backgroundRepeat: 'no-repeat',
                  backgroundSize: 'cover',
                }}
              >
                {option.id === 'none' ? (
                  <span className="absolute inset-0 flex items-center justify-center text-12 text-[var(--settings-section-sublabel)]">
                    {t('settings.appearance.wallpaper.nonePreview')}
                  </span>
                ) : null}
              </span>
              <span
                className={cn(
                  'truncate text-12 font-medium',
                  selected
                    ? 'text-[var(--settings-theme-label-active)]'
                    : 'text-[var(--settings-theme-label)]',
                )}
              >
                {t('settings.appearance.wallpaper.options.' + option.id)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="h-px bg-[var(--settings-input-border)]" />

      <div className="flex flex-col gap-3">
        {isSceneWallpaper(wallpaperId) && (
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-13 font-medium text-[var(--settings-section-sublabel)]">
                {t('settings.appearance.wallpaper.motionLabel')}
              </p>
              <p className="mt-1 text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
                {t('settings.appearance.wallpaper.motionHint')}
              </p>
            </div>
            <SegmentedControl
              aria-label={t('settings.appearance.wallpaper.motionLabel')}
              value={wallpaperMotion}
              onValueChange={setMotion}
              options={[
                { value: 'static', label: t('settings.appearance.wallpaper.motionStatic') },
                { value: 'dynamic', label: t('settings.appearance.wallpaper.motionDynamic') },
              ]}
            />
          </div>
        )}
        <div className="flex items-center gap-3">
          <span className="shrink-0 text-12 text-[var(--settings-section-sublabel)]">
            {t('settings.appearance.wallpaper.overlayLabel')}
          </span>
          <Slider
            min={APPEARANCE_LIMITS.wallpaperOverlay.min}
            max={APPEARANCE_LIMITS.wallpaperOverlay.max}
            step={APPEARANCE_LIMITS.wallpaperOverlay.step}
            value={[wallpaperOverlay]}
            onValueChange={([value]) => {
              if (typeof value === 'number') setOverlay(value);
            }}
            aria-label={t('settings.appearance.wallpaper.overlayAria')}
          />
          <span className="w-10 shrink-0 text-right font-mono text-12 text-[var(--settings-section-sublabel)]">
            {Math.round(wallpaperOverlay * 100)}%
          </span>
        </div>
      </div>
    </div>
  );
}
