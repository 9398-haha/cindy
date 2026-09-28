import { expect, it } from 'vitest';
import { previewImportRedactions, resolveImportReferences, selectedImportRedactions } from '../environmentSelection.js';
import { redactEnvironmentValues } from '../process.js';
import type { ImportItem } from '../types.js';

it('resolves mixed-case Windows references throughout selected MCP and delivery settings', () => {
  const env = { api_key: 'fixture-key', Empty: '' };
  const value = { headers: { Authorization: 'Bearer ${API_KEY}' }, args: ['${Api_Key}', '${EMPTY}'], token: '${api_KEY}', number: 1 };
  expect(resolveImportReferences(value, env, false, 'win32')).toEqual({ headers: { Authorization: 'Bearer fixture-key' }, args: ['fixture-key', ''], token: 'fixture-key', number: 1 });
  expect(env).toEqual({ api_key: 'fixture-key', Empty: '' });
  expect(value.token).toBe('${api_KEY}');
});

it.each(['darwin', 'linux'] as const)('keeps %s environment references case-sensitive', platform => {
  const env = { api_key: 'lower', API_KEY: 'upper' };
  expect(resolveImportReferences(['${api_key}', '${API_KEY}'], env, false, platform)).toEqual(['lower', 'upper']);
  expect(() => resolveImportReferences('${Api_Key}', env, false, platform)).toThrow('AUTOMATION_DEPENDENCY_NOT_SELECTED');
});

it.each(['win32', 'darwin'] as const)('does not resolve absent or inherited variables on %s', platform => {
  const env = Object.assign(Object.create({ TOKEN: 'not-selected' }), { api_key: 'fixture-key' });
  expect(() => resolveImportReferences('${TOKEN}', env, false, platform)).toThrow('AUTOMATION_DEPENDENCY_NOT_SELECTED');
  expect(resolveImportReferences(['${TOKEN}', '${MISSING}', '$(not-executed)'], env, true, platform)).toEqual(['${TOKEN}', '${MISSING}', '$(not-executed)']);
});

it.each(['stdin-object', 'stdin-string', 'argv-json', 'argv-assignment', 'argv-value', 'nested-url'])
('masks command %s credentials before publication without altering originals or command syntax', kind => {
  const secret = 'fixture-private-"quoted"\nvalue';
  const encoded = JSON.stringify(secret).slice(1, -1);
  const structured = JSON.stringify({ credentials: [{ privateKeyPem: secret }], city: 'Paris', active: true });
  const payload: Record<string, unknown> = { kind: 'command', argv: ['node', '-e', '--mode', 'markdown', '--days', '7', 'sessions', 'history'] };
  if (kind === 'stdin-object') payload.input = structured;
  if (kind === 'stdin-string') payload.input = JSON.stringify(secret);
  if (kind === 'argv-json') payload.argv = ['node', '--config', structured];
  if (kind === 'argv-assignment') payload.argv = ['node', `--config=${structured}`];
  if (kind === 'argv-value') payload.argv = ['node', '--token', secret];
  if (kind === 'nested-url') payload.input = JSON.stringify({ endpoint: `https://host/hooks/${encodeURIComponent(secret)}` });
  const items: ImportItem[] = [{ view: { id: 'job', category: 'automations', name: 'Job', selected: true },
    automation: { sourceId: 'job', fingerprint: 'fixture', original: { payload } } }];
  const before = structuredClone(items);
  for (const collect of [previewImportRedactions, selectedImportRedactions]) {
    const masks = collect(items);
    const readable = redactEnvironmentValues(`node -e --mode --token Paris true 7 markdown sessions history ${secret} ${encoded}`, masks);
    expect(readable).not.toContain(secret);
    expect(readable).not.toContain(encoded);
    expect(readable).toContain('node -e --mode --token Paris true 7 markdown sessions history');
  }
  expect(items).toEqual(before);
});
