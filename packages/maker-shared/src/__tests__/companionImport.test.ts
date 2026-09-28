import { expect, it, vi } from 'vitest';
import { compactCompanionImportSelection, remoteCompanionImportApi, areCompanionImportEntriesSelected, toggleCompanionImportEntries, type CompanionImportEntry, type CompanionImportPreview } from '../companionImport.js';
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
