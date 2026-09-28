import { expect, it, vi } from 'vitest';
import { companionImportErrorCode, companionImportReasonKey, COMPANION_IMPORT_CHUNK_LENGTH, compactCompanionImportSelection, remoteCompanionImportApi, areCompanionImportEntriesSelected, toggleCompanionImportEntries, type CompanionImportEntry, type CompanionImportPreview } from '../companionImport.js';
const entries: CompanionImportEntry[] = [
  { id: 'work', name: 'Work', category: 'connections', selected: false, exclusiveWith: ['personal'] },
  { id: 'personal', name: 'Personal', category: 'connections', selected: false, exclusiveWith: ['work'] },
  { id: 'other', name: 'Other', category: 'connections', selected: true },
];
it('switches credentials in the existing selection and keeps bulk selection unambiguous', () => {
  const all = entries.map(entry => entry.id);
  expect(toggleCompanionImportEntries(entries, [], all, true)).toEqual(['other']);
  const work = toggleCompanionImportEntries(entries, ['other'], ['work'], true);
  expect(work).toEqual(['other', 'work']);
  expect(areCompanionImportEntriesSelected(entries, work)).toBe(true);
  expect(areCompanionImportEntriesSelected(entries, ['other'])).toBe(false);
  expect(toggleCompanionImportEntries(entries, work, all, true)).toEqual(work);
  const personal = toggleCompanionImportEntries(entries, work, ['personal'], true);
  expect(personal).toEqual(['other', 'personal']);
  expect(toggleCompanionImportEntries(entries, personal, ['personal'], false)).toEqual(['other']);
  expect(toggleCompanionImportEntries(entries, personal, all, false)).toEqual([]);
});

it.each([false, true])('negotiates compact selections only when the host advertises support (%s)', async supported => {
  const many = Array.from({ length: 2100 }, (_, index) => ({ id: `memory-${index}`, name: `Memory ${index}`, category: 'memory' as const, selected: true }));
  const preview: CompanionImportPreview = { id: 'preview', source: { id: 'source', name: 'Ada', kind: 'hermes' }, name: 'Ada', entries: many, ...(supported ? { selectionRanges: true as const } : {}) };
  const result = { requestId: 'compat-request-12345', botId: 'bot', canonicalSessionId: 'chat', status: 'complete', checks: [] };
  const invoke = vi.fn<Parameters<typeof remoteCompanionImportApi>[1]>(async () => ({}));
  const api = remoteCompanionImportApi(async id => ({ blocks: [{ primitive: 'companion-import', data: id.startsWith('preview:') ? { preview } : { result } }] }), invoke);
  const received = await api.preview('source');
  const chosen = many.filter((_, index) => index !== 100).map(entry => entry.id);
  await expect(api.start({ previewId: received.id, requestId: result.requestId, name: 'Ada', takeover: false, ...compactCompanionImportSelection(received, chosen) })).resolves.toEqual(result);
  expect(invoke).toHaveBeenCalledWith('source', expect.objectContaining(supported ? { entryIds: [], entryRanges: [[0, 99], [101, 2099]] } : { entryIds: chosen }));
  if (!supported) expect(invoke.mock.calls[0]?.[1]).not.toHaveProperty('entryRanges');
});

it('reassembles source and result reads without dropping saved IDs or checks', async () => {
  const sources = Array.from({ length: 3000 }, (_, index) => ({ id: `source-${index}`, kind: 'hermes', name: 'Name'.repeat(20) }));
  const result = { requestId: 'request-1234567890', botId: 'bot', status: 'complete', checks: sources.map(source => ({ entryId: source.id, status: 'copied' })), savedEntryIds: sources.map(source => source.id) };
  let text = '';
  const api = remoteCompanionImportApi(async id => {
    if (!id.startsWith('chunk:')) text = JSON.stringify(id === 'sources' ? { sources } : { result });
    const offset = id.startsWith('chunk:') ? Number(id.split(':')[2]) : 0;
    return { blocks: [{ primitive: 'companion-import', data: { chunk: { id: 'token', offset, total: text.length, text: text.slice(offset, offset + COMPANION_IMPORT_CHUNK_LENGTH) } } }] };
  }, async () => {});
  expect(await api.sources()).toEqual(sources);
  expect(await api.status(result.requestId)).toEqual(result);
});

it.each(['token', 'offset', 'total', 'missing', 'disconnect'])('rejects %s drift during chunk reads without publishing a partial preview', async mode => {
  const first = { id: 'stable', offset: 0, total: COMPANION_IMPORT_CHUNK_LENGTH + 10, text: 'x'.repeat(COMPANION_IMPORT_CHUNK_LENGTH) };
  const read = vi.fn(async (id: string) => {
    if (id.startsWith('chunk:') && mode === 'disconnect') throw new Error('DISCONNECTED');
    const chunk = !id.startsWith('chunk:') ? first : { ...first, offset: COMPANION_IMPORT_CHUNK_LENGTH, text: 'x'.repeat(10),
      ...(mode === 'token' ? { id: 'changed' } : {}), ...(mode === 'offset' ? { offset: 0 } : {}), ...(mode === 'total' ? { total: first.total + 1 } : {}),
    };
    return { blocks: [{ primitive: 'companion-import', data: mode === 'missing' && id.startsWith('chunk:') ? {} : { chunk } }] };
  });
  const api = remoteCompanionImportApi(read, async () => {});
  await expect(api.preview('source')).rejects.toThrow(mode === 'disconnect' ? 'DISCONNECTED' : 'INVALID_IMPORT_RESPONSE');
  expect(read).toHaveBeenCalledTimes(2);
});


it('keeps concrete import failures through IPC wrappers without displaying private exception text', () => {
  const error = { code: 'INVALID_PARAMS', message: '[INVALID_PARAMS] SOURCE_DATABASE_DRIVER_UNAVAILABLE private path' };
  expect(companionImportErrorCode(error)).toBe('SOURCE_DATABASE_DRIVER_UNAVAILABLE');
  expect(companionImportReasonKey(companionImportErrorCode(error))).toBe('databaseDriver');
  expect(companionImportReasonKey('PRIVATE_UNKNOWN')).toBe('itemFailed');
  expect(companionImportErrorCode(new Error('private source contents'))).toBeUndefined();
});
