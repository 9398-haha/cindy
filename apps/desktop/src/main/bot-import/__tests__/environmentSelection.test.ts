import { expect, it } from 'vitest';
import { previewImportRedactions, resolveImportReferences, selectedImportRedactions } from '../environmentSelection.js';
import { redactEnvironmentValues } from '../process.js';
import type { ImportItem } from '../types.js';
import { commandArgumentRedactions } from '../commandRedactions.js';

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

it.each([
  ['-H', 'Authorization: Bearer fixture-header-token'],
  ['--header', 'authorization:   bearer fixture-header-token  '],
  ['--header=Authorization: Bearer fixture-header-token'],
  ['-HAuthorization: Bearer fixture-header-token'],
  ['--proxy-header', 'Proxy-Authorization: Bearer fixture-header-token'],
  ['-H', 'Authorization: Basic fixture-header-token'],
  ['-H', 'X-API-Key: fixture-header-token'],
  ['--header', 'x-auth-token: fixture-header-token'],
  ['--header=X-API-Key: fixture-header-token'],
  ['-HX-API-Key: fixture-header-token'],
  ['--proxy-header', 'X-API-Key: fixture-header-token'],
  ['-H', 'Cookie: session=fixture-header-token; other=fixture-second-cookie'],
  ['--header=Cookie: session="fixture-header-token"; empty='],
])('masks the credential payload in command headers %j without masking public header settings', (...args) => {
  const payload = { kind: 'command', argv: ['curl', ...args, '-H', 'Accept: application/json', '--header=Content-Type: application/json'] };
  const items: ImportItem[] = [{ view: { id: 'job', category: 'automations', name: 'Job', selected: true },
    automation: { sourceId: 'job', fingerprint: 'fixture', original: { payload } } }];
  const before = structuredClone(items);
  for (const collect of [previewImportRedactions, selectedImportRedactions]) {
    const readable = redactEnvironmentValues('fixture-header-token curl -H --header Authorization Bearer Basic Accept: application/json Content-Type: application/json', collect(items));
    expect(readable).not.toContain('fixture-header-token');
    expect(readable).toContain('curl -H --header Authorization Bearer Basic Accept: application/json Content-Type: application/json');
  }
  expect(items).toEqual(before);
});

it.each(['command', 'mcp'])('masks individual %s cookies before publication without changing original headers', source => {
  const header = 'session=fixture-cookie%2Fone==; repeat="fixture-cookie-two"; repeat=fixture-cookie+three; empty=; emptyQuoted=""; malformed; broken=fixture%not-encoded';
  const items: ImportItem[] = [{ view: { id: 'entry', category: source === 'mcp' ? 'connections' : 'automations', name: 'Job', selected: true },
    ...(source === 'mcp' ? { mcp: { name: 'data', headers: { cOoKiE: header }, url: 'https://example.invalid/mcp' } }
      : { automation: { sourceId: 'job', fingerprint: 'fixture', original: { payload: { kind: 'command', argv: ['curl', '-H', 'Cookie: ' + header] } } } }) }];
  const original = structuredClone(items);
  const secrets = ['fixture-cookie%2Fone==', 'fixture-cookie/one==', 'fixture-cookie-two', 'fixture-cookie+three', 'fixture%not-encoded'];
  for (const collect of [previewImportRedactions, selectedImportRedactions]) {
    const result = redactEnvironmentValues(`${secrets.join('\n')}\npublic report Cookie Accept Content-Type application/json ""`, collect(items));
    for (const secret of secrets) expect(result).not.toContain(secret);
    expect(result).toContain('public report Cookie Accept Content-Type application/json ""');
  }
  expect(items).toEqual(original);
});

it.each(['stdin', 'argv', 'assignment', 'env'])('masks credential fields in form-encoded command %s while retaining public values', source => {
  const form = 'access_token=fixture-form%2Fsecret%2Bvalue&access_token=fixture+second+secret&%70assword=fixture%3Dpassword&city=Paris&days=7&token_type=Bearer';
  const payload = { kind: 'command', argv: ['curl', '--data', ...(source === 'argv' ? [form] : source === 'assignment' ? [`--config=${form}`] : [])],
    ...(source === 'stdin' ? { input: form } : {}), ...(source === 'env' ? { env: { CONFIG: form } } : {}) };
  const items: ImportItem[] = [{ view: { id: 'job', category: 'automations', name: 'Job', selected: true },
    automation: { sourceId: 'job', fingerprint: 'fixture', original: { payload } } }];
  const before = structuredClone(items);
  const secrets = ['fixture-form/secret+value', 'fixture-form%2Fsecret%2Bvalue', 'fixture second secret', 'fixture+second+secret', 'fixture=password', 'fixture%3Dpassword'];
  for (const collect of [previewImportRedactions, selectedImportRedactions]) {
    const readable = redactEnvironmentValues(`${secrets.join('\n')}\nParis 7 Bearer curl --data`, collect(items));
    for (const secret of secrets) expect(readable).not.toContain(secret);
    expect(readable).toContain('Paris 7 Bearer curl --data');
  }
  expect(items).toEqual(before);
});

it.each(['-u', '--user', '-U', '--proxy-user', '-ujoined', '-Ujoined', '--user=', '--proxy-user='])
('masks only the password in curl %s userinfo before publication', option => {
  const password = 'fixture-curl:password-"quoted"'; const userinfo = `alice:${password}`;
  const args = option.endsWith('joined') ? [option.slice(0, 2) + userinfo] : option.endsWith('=') ? [option + userinfo] : [option, userinfo];
  const items: ImportItem[] = [{ view: { id: 'job', category: 'automations', name: 'Job', selected: true },
    automation: { sourceId: 'job', fingerprint: 'fixture', original: { payload: { kind: 'command', argv: ['/usr/bin/curl', ...args] } } } }];
  const original = structuredClone(items);
  for (const collect of [previewImportRedactions, selectedImportRedactions]) {
    const output = redactEnvironmentValues(`${password}\n${JSON.stringify(password)}\nalice ordinary:value --user`, collect(items));
    expect(output).not.toContain(password);
    expect(output).not.toContain(JSON.stringify(password).slice(1, -1));
    expect(output).toContain('alice ordinary:value --user');
  }
  expect(items).toEqual(original);
});

it('scopes curl userinfo parsing to its executable and options, retaining usernames and ordinary colons', () => {
  for (const exe of ['curl', 'curl.exe', 'C:\\Windows\\System32\\curl.exe']) {
    expect(Object.values(commandArgumentRedactions([exe, '-u', 'alice:fixture-curl-password']))).toContain('fixture-curl-password');
  }
  for (const args of [['node', '-u', 'alice:fixture-public'], ['curl', '--', '-u', 'alice:fixture-public'],
    ['curl', '--user', 'alice'], ['curl', '--user', 'alice:'], ['curl', 'ordinary:fixture-public']]) {
    expect(redactEnvironmentValues('alice ordinary:fixture-public', commandArgumentRedactions(args))).toBe('alice ordinary:fixture-public');
  }
});
