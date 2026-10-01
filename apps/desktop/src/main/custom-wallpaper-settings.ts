import { normalizeCustomWallpaperUrl } from '../shared/appearanceSettings.js';
import {
  activeOwnerScopeKey,
  getActiveAppSession,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from './appSessionState.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { createLogger } from './logger.js';

// Artwork is private to the active data owner, unlike the machine's theme/font choices.
export const customWallpaperStore = createOverrideSettingsFile<{ url: string }>({
  filePath: () => ownerScopedUserDataPath('custom-wallpaper.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { url: '' },
  normalize: (raw) => ({ url: normalizeCustomWallpaperUrl((raw as { url?: unknown })?.url) }),
  log: createLogger('custom-wallpaper-settings'),
  label: 'custom-wallpaper',
  maxBytes: 4096,
  preserveUnreadableFile: true,
  logLoadedValue: false,
  logReadErrorDetails: false,
});

export function readCustomWallpaperUrl(): string {
  if (!getActiveAppSession().dataOwnerId || isAppSessionBoundaryPending()) return '';
  customWallpaperStore.invalidateIfChanged();
  return customWallpaperStore.read().url;
}
