import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelDescriptor } from '@cindy/maker-core';
import { BUNDLED_CATALOG } from '@cindy/model-providers';
const state = vi.hoisted(() => ({ owner: 'owner-a' }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => state.owner }));
import { clearCursorDiscoveredModels, getCursorDiscoveredModel, hasCursorDiscoveredModels, setCursorDiscoveredModels, withCursorDiscoveredModels } from '../cursor-model-catalog.js';

describe('Cursor ACP catalog projection', () => {
  beforeEach(() => { state.owner = 'owner-a'; clearCursorDiscoveredModels(); });
  const discovered: ModelDescriptor = { id: 'account-native-model', displayName: 'Native model',
    contextWindow: 0, efforts: [], defaultEffort: null, newSessionDefault: ['cursor'] };
  it('never fabricates an Auto or fallback model before discovery', () => {
    expect(withCursorDiscoveredModels(BUNDLED_CATALOG).providers.find(p => p.id === 'cursor')?.models.cursor).toEqual([]);
    expect(hasCursorDiscoveredModels()).toBe(false);
  });
  it('preserves discovered identity and native default even when the server catalog predates Cursor', () => {
    setCursorDiscoveredModels([discovered], state.owner);
    const catalog = { ...BUNDLED_CATALOG, providers: BUNDLED_CATALOG.providers.filter(p => p.id !== 'cursor') };
    const result = withCursorDiscoveredModels(catalog);
    expect(result.providers.find(p => p.id === 'cursor')?.models.cursor).toEqual([
      { id: discovered.id, name: discovered.displayName, contextWindow: 0, efforts: [], defaultEffort: null, newSessionDefault: ['cursor'] },
    ]);
    expect(catalog.providers.some(p => p.id === 'cursor')).toBe(false);
  });
  it('drops late discoveries and never reuses a different owner snapshot', () => {
    setCursorDiscoveredModels([discovered], state.owner);
    expect(getCursorDiscoveredModel(discovered.id)).toEqual(discovered);
    expect(getCursorDiscoveredModel('missing')).toBeUndefined();
    state.owner = 'owner-b';
    expect(hasCursorDiscoveredModels()).toBe(false);
    expect(getCursorDiscoveredModel(discovered.id)).toBeUndefined();
    setCursorDiscoveredModels([discovered], 'owner-a');
    expect(getCursorDiscoveredModel(discovered.id)).toBeUndefined();
    expect(withCursorDiscoveredModels(BUNDLED_CATALOG).providers.find(p => p.id === 'cursor')?.models.cursor).toEqual([]);
  });
  it('projects native per-model effort and Fast capabilities for desktop and mobile pickers', () => {
    setCursorDiscoveredModels([{ ...discovered, efforts: ['low', 'high', 'max'], defaultEffort: 'high', supportsFastMode: true }], state.owner);
    expect(withCursorDiscoveredModels(BUNDLED_CATALOG).providers.find(p => p.id === 'cursor')?.models.cursor?.[0])
      .toMatchObject({ efforts: ['low', 'high', 'max'], defaultEffort: 'high', supportsFastMode: true });
  });
});
