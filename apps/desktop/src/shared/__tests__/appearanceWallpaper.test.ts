import { describe, expect, it } from 'vitest';
import { normalizeAppearanceSettings } from '../appearanceSettings';

describe('wallpaper catalog compatibility', () => {
  it.each(['cindy', 'cindy-portrait', 'aurora', 'sunset', 'paper', 'custom'])(
    'disables retired %s without resetting other appearance preferences',
    (wallpaperId) => {
      const settings = normalizeAppearanceSettings({
        wallpaperId,
        wallpaperPath: '/previous/image.png',
        wallpaperFit: 'contain',
        wallpaperMotion: 'dynamic',
        wallpaperOverlay: 0.35,
        uiFamily: 'Example Sans',
        codeFamily: 'Example Mono',
        uiSize: 18,
        codeSize: 16,
        windowZoom: 1.2,
      });
      expect(settings).toEqual({
        wallpaperId: 'none',
        wallpaperMotion: 'dynamic',
        wallpaperOverlay: 0.35,
        uiFamily: 'Example Sans',
        codeFamily: 'Example Mono',
        uiSize: 18,
        codeSize: 16,
        windowZoom: 1.2,
      });
    },
  );
  it.each(['cindy-window', 'cindy-studio', 'cindy-dream'])(
    'preserves both display modes for %s',
    (wallpaperId) => {
      for (const wallpaperMotion of ['static', 'dynamic']) {
        expect(normalizeAppearanceSettings({ wallpaperId, wallpaperMotion })).toMatchObject({
          wallpaperId,
          wallpaperMotion,
        });
      }
    },
  );
});
