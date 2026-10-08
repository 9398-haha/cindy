/** Owner-scoped, in-memory ACP discovery; no invented models, account credentials, or disk cache. */
import type { ModelDescriptor } from '@cindy/maker-core';
import { BUNDLED_CATALOG, type Catalog } from '@cindy/model-providers';
import { activeOwnerScopeKey } from '../appSessionState.js';

let snapshot: { owner: string; models: ModelDescriptor[] } | null = null;
export function setCursorDiscoveredModels(models: ModelDescriptor[], owner: string): void {
  if (activeOwnerScopeKey() !== owner) return;
  snapshot = { owner, models };
}
export function clearCursorDiscoveredModels(): void { snapshot = null; }
export function hasCursorDiscoveredModels(): boolean {
  return snapshot?.owner === activeOwnerScopeKey() && snapshot.models.length > 0;
}
export function withCursorDiscoveredModels(catalog: Catalog): Catalog {
  const models = snapshot?.owner === activeOwnerScopeKey() ? snapshot.models : [];
  const builtin = BUNDLED_CATALOG.providers.find(provider => provider.id === 'cursor');
  const providers = catalog.providers.some(provider => provider.id === 'cursor') || !builtin
    ? catalog.providers : [...catalog.providers, builtin];
  return { ...catalog, providers: providers.map(provider => provider.id !== 'cursor' ? provider : {
    ...provider,
    models: { ...provider.models, cursor: models.map(model => ({
      id: model.id, name: model.displayName, contextWindow: model.contextWindow,
      efforts: model.efforts, defaultEffort: model.defaultEffort,
      ...(model.newSessionDefault ? { newSessionDefault: model.newSessionDefault } : {}),
      ...(model.description ? { description: model.description } : {}),
      ...(model.supportsImageInput !== undefined ? { supportsImageInput: model.supportsImageInput } : {}),
    })) },
  }) };
}
