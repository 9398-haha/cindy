import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeCustomWallpaperUrl } from '../shared/appearanceSettings.js';
import {
  getActiveAppSession,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from './appSessionState.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { createLogger } from './logger.js';

const filePath = () => path.join(app.getPath('userData'), 'custom-wallpaper.json');

// Like theme preferences, the image is shared by accounts in this Desktop profile.
export const customWallpaperStore = createOverrideSettingsFile<{ url: string }>({
  filePath,
  defaults: { url: '' },
  normalize: (raw) => ({
    url: normalizeCustomWallpaperUrl((raw as { url?: unknown })?.url),
  }),
  log: createLogger('custom-wallpaper-settings'),
  label: 'custom-wallpaper',
  maxBytes: 4096,
  preserveUnreadableFile: true,
  logLoadedValue: false,
  logReadErrorDetails: false,
});

function migratePreviewPreference(): void {
  const target = filePath();
  if (fs.existsSync(target) || !getActiveAppSession().dataOwnerId || isAppSessionBoundaryPending())
    return;
  // Adopt only the active account's pre-release preference; never scan other accounts.
  // Exclusive creation cannot overwrite another process's shared preference.
  // Removal retains an empty file so old preferences cannot reappear.
  try {
    const source = ownerScopedUserDataPath('custom-wallpaper.json');
    if (!fs.existsSync(source) || fs.statSync(source).size > 4096) return;
    const url = normalizeCustomWallpaperUrl(JSON.parse(fs.readFileSync(source, 'utf8'))?.url);
    if (url) fs.writeFileSync(target, JSON.stringify({ url }), { encoding: 'utf8', flag: 'wx' });
  } catch {
    // Preserve unreadable legacy files and never log their private contents.
  }
}

export function readCustomWallpaperUrl(): string {
  migratePreviewPreference();
  customWallpaperStore.invalidateIfChanged();
  return customWallpaperStore.read().url;
}
