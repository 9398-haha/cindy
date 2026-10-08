import type { ModelDescriptor } from '../../types/capabilities.js';

export type AcpRecord = Record<string, unknown>;
export function record(value: unknown): AcpRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as AcpRecord : {};
}
export interface CursorModelOption { id: string; name: string }
export interface CursorModelCatalog {
  models: ModelDescriptor[];
  configId?: string;
  currentModel?: string;
}

/** Only advertise models the running CLI has actually offered. No guessed AUTO catalog. */
export function readCursorModels(session: unknown): CursorModelCatalog {
  const data = record(session);
  const configs = Array.isArray(data.configOptions) ? data.configOptions : [];
  const config = configs.map(record).find(option => option.category === 'model');
  const choices: CursorModelOption[] = [];
  function collect(options: unknown): void {
    if (!Array.isArray(options)) return;
    for (const raw of options) {
      const option = record(raw);
      if (Array.isArray(option.options)) collect(option.options);
      else if (typeof option.value === 'string' && option.value.trim()) {
        choices.push({ id: option.value, name: typeof option.name === 'string' ? option.name : option.value });
      }
    }
  }
  collect(config?.options);
  // Older ACP agents expose SessionModelState. Discovery is useful even when
  // their experimental model mutation method is unavailable: don't guess it.
  const legacy = record(data.models);
  if (!choices.length && Array.isArray(legacy.availableModels)) {
    for (const raw of legacy.availableModels) {
      const item = record(raw);
      if (typeof item.modelId === 'string' && item.modelId.trim()) {
        choices.push({ id: item.modelId, name: typeof item.name === 'string' ? item.name : item.modelId });
      }
    }
  }
  const current = config?.currentValue ?? legacy.currentModelId;
  const currentModel = typeof current === 'string' && current.trim() ? current : undefined;
  return {
    configId: typeof config?.id === 'string' ? config.id : undefined,
    currentModel,
    models: [...new Map(choices.map(item => [item.id, item])).values()].map(item => ({
      id: item.id, displayName: item.name, contextWindow: 0,
      efforts: [], defaultEffort: null, supportsFastMode: false,
      ...(item.id === currentModel ? { newSessionDefault: ['cursor' as const] } : {}),
    })),
  };
}

/** A sentinel meaning “let this CLI choose”; it is not an AUTO model claim. */
export const CURSOR_DEFAULT_MODEL = 'cursor-default';
export const cursorDefaultModel: ModelDescriptor = {
  id: CURSOR_DEFAULT_MODEL, displayName: 'Cursor Default', contextWindow: 0,
  efforts: [], defaultEffort: null, supportsFastMode: false,
  newSessionDefault: ['cursor'],
};
