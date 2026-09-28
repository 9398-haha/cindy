import { expect, it } from 'vitest';
import { importedProcessEnvironment, redactEnvironmentData, redactEnvironmentValues } from '../process.js';
import { previewImportRedactions } from '../environmentSelection.js';
import { connectionRedactions, importedContentRedactions, redactImportedResult } from '../connectionCatalog.js';

it('preserves native boolean switches, local bind addresses and transport/policy enums without exempting credentials', () => {
  const env = { BLUEBUBBLES_SEND_READ_RECEIPTS: 'false', BLUEBUBBLES_WEBHOOK_HOST: '192.168.10.100', AWS_BEDROCK_FORCE_HTTP1: '1', BROWSERBASE_PROXIES: 'true', BROWSERBASE_ADVANCED_STEALTH: 'false',
    TELEGRAM_REQUIRE_MENTION: 'true', TELEGRAM_OBSERVE_UNMENTIONED_GROUP_MESSAGES: 'true', FEISHU_ALLOW_ALL_USERS: 'false',
    WEB_TOOLS_DEBUG: 'false', API_SERVER_HOST: '127.0.0.1', API_SERVER_PORT: '8080', FEISHU_CONNECTION_MODE: 'websocket', FEISHU_GROUP_POLICY: 'allowlist', FEISHU_BOT_NAME: 'Fixture', FEISHU_DOMAIN: 'feishu' };
  const text = '192.168.10.100 sys.exit(1) action="store_true" <path d="M1 1"/> false 127.0.0.1 8080 websocket allowlist Fixture feishu';
  expect(redactEnvironmentValues(text, env)).toBe(text);
  expect(redactEnvironmentValues('1 true websocket', { ...env, API_KEY: '1', AUTH_ALLOW_DEBUG: 'true', SECRET_MODE: 'websocket' })).toBe('[API_KEY] [AUTH_ALLOW_DEBUG] [SECRET_MODE]');
  const secrets = importedContentRedactions({ env, mcp: [{ name: 'fixture', headers: { Authorization: 'Bearer true' } }], credentials: [] });
  expect(redactEnvironmentValues('true', secrets)).not.toBe('true');
  expect(redactEnvironmentValues('private-endpoint', { API_SERVER_HOST: 'private-endpoint' })).toBe('[API_SERVER_HOST]');
});

it('masks encoded and decoded URL credentials without mutating the private connection', () => {
  const url = 'https://fake%2Fuser:fake%2Bpassword@example.invalid/fake%2Fpath?token=fake%2Bquery';
  const values = [url, 'fake%2Fuser', 'fake/user', 'fake%2Bpassword', 'fake+password', 'fake%2Fpath', 'fake/path', 'fake%2Bquery', 'fake+query'];
  const secrets = importedContentRedactions({ env: { DATA_TOKEN: 'fake-env-token', LANG: 'en', imported_credential_0: 'fake-collision-token' }, mcp: [], credentials: [] }, [url]);
  const output = redactEnvironmentValues(`Ordinary content en. ${values.join(' ')} fake-env-token fake-collision-token`, secrets);
  for (const value of values) expect(output).not.toContain(value);
  expect(output).toContain('Ordinary content en.');
  expect(output).toContain('[DATA_TOKEN]');
  expect(output).not.toContain('fake-collision-token');
});

it('keeps credential context through array and object values without masking ordinary siblings', () => {
  const original = {
    token: ['fixture-first-secret', ['fixture-second-secret', { value: 'fixture-third-secret' }]],
    profile: { api_key: { current: ['fixture-fourth-secret'] }, cities: ['Paris', 'London'] },
    features: ['true', 'false'], count: 7,
  };
  const before = JSON.stringify(original);
  const masks = importedContentRedactions({ env: {}, mcp: [], credentials: [{ id: 'fixture', format: 'json', value: original }] });
  const output = redactEnvironmentValues('fixture-first-secret fixture-second-secret fixture-third-secret fixture-fourth-secret Paris London true false 7', masks);
  for (const secret of ['fixture-first-secret', 'fixture-second-secret', 'fixture-third-secret', 'fixture-fourth-secret']) expect(output).not.toContain(secret);
  expect(output).toContain('Paris London true false 7');
  expect(JSON.stringify(original)).toBe(before);
});

it.each(['credential', 'credentials', 'clientCredentials', 'tokens', 'access_tokens', 'refreshTokens',
  'secrets', 'passwords', 'passwds', 'keys', 'api_keys', 'API-KEYS', 'auth', 'authorization', 'cookies'])(
  'masks scalar and nested string descendants of the %s credential field', field => {
    const original = { [field]: ['fixture-container-secret', { nested: ['fixture-nested-secret'] }],
      scalar: { [field]: 'fixture-scalar-secret' }, cities: ['Paris', 'London'], monkeys: ['capuchin'] };
    const before = JSON.stringify(original);
    const masks = importedContentRedactions({ env: {}, mcp: [], credentials: [{ id: 'fixture', format: 'json', value: original }] });
    const output = redactEnvironmentValues('fixture-container-secret fixture-nested-secret fixture-scalar-secret Paris London capuchin', masks);
    for (const secret of ['fixture-container-secret', 'fixture-nested-secret', 'fixture-scalar-secret']) expect(output).not.toContain(secret);
    expect(output).toContain('Paris London capuchin');
    expect(JSON.stringify(original)).toBe(before);
  },
);

it('keeps locale/region configuration and ordinary words intact while masking unknown short credentials as tokens', () => {
  const env = { REGION: 'us', LANG: 'en', LC_ALL: 'en_US.UTF-8', AWS_REGION: 'us-east-1', PRIVATE: 'xy', ARBITRARY: 'fixture-private-value' };
  const value = { status: 'success', language: 'en', region: 'us', detail: 'English status in us-east-1; private xy / fixture-private-value' };
  expect(redactEnvironmentData(value, env)).toEqual({ ...value, detail: 'English status in us-east-1; private [PRIVATE] / [ARBITRARY]' });
  expect(redactEnvironmentValues('status open username us en', { PRIVATE: 'us', UNKNOWN: 'en' })).toBe('status open username [PRIVATE] [UNKNOWN]');
  expect(redactEnvironmentValues('xy_read read_xy xylophone', { PRIVATE: 'xy' })).toBe('[PRIVATE]_read read_[PRIVATE] xylophone');
  // A known locale value does not override an explicit connection credential.
  expect(redactEnvironmentValues('en', connectionRedactions({ name: 'fixture', headers: { Authorization: 'Bearer en' } }, { LANG: 'en' }))).not.toBe('en');
});
it.each(['darwin', 'win32'] as const)('inherits only OS basics and explicit imports on %s', platform => {
  const result = importedProcessEnvironment({ DATA_TOKEN: 'fixture-import-token', HTTPS_PROXY: 'fixture-selected-proxy', PATH: 'selected-bin' }, {
    [platform === 'win32' ? 'Path' : 'PATH']: 'host-bin', HOME: 'fixture-home', SystemRoot: 'fixture-system',
    GITHUB_TOKEN: 'fixture-host-token', HTTPS_PROXY: 'fixture-host-proxy', NODE_OPTIONS: '--require=private.js', PYTHONPATH: 'host-private-code',
  }, platform);
  expect(result).toMatchObject({ HOME: 'fixture-home', PATH: 'selected-bin', DATA_TOKEN: 'fixture-import-token', HTTPS_PROXY: 'fixture-selected-proxy' });
  expect(result).not.toHaveProperty('GITHUB_TOKEN');
  expect(result).not.toHaveProperty('NODE_OPTIONS');
  expect(result).not.toHaveProperty('PYTHONPATH');
  if (platform === 'win32') { expect(result.SYSTEMROOT).toBe('fixture-system'); expect(result).not.toHaveProperty('Path'); }
});

it('preserves bounded ordinary settings even when deselected, while explicit same-value credentials stay masked', () => {
  const env = { DEBUG: 'true', PORT: '3000', NODE_ENV: 'production', LOG_LEVEL: 'info', VERBOSE: 'false' };
  const text = 'true false 3000 production info';
  const secrets = previewImportRedactions([{ view: { id: 'config', name: 'config', category: 'connections', selected: false }, env }]);
  expect(redactEnvironmentValues(text, secrets)).toBe(text);
  expect(redactEnvironmentData({ true: 'true', port: '3000', number: 3000 }, env)).toEqual({ true: 'true', port: '3000', number: 3000 });
  const privateValues = importedContentRedactions({ env: { ...env, API_KEY: '3000' }, mcp: [{ name: 'data', headers: { Authorization: 'Bearer true' } }], credentials: [] });
  expect(redactEnvironmentValues('true 3000', privateValues)).not.toContain('true');
  expect(redactEnvironmentValues('true 3000', privateValues)).not.toContain('3000');
  expect(redactEnvironmentValues('fixture-private-value', { DEBUG: 'fixture-private-value' })).toBe('[DEBUG]');
});

it('does not turn ordinary scalar settings or MCP endpoint names into content credentials', () => {
  const env = { SOME_FEATURE_ENABLED: 'true', RETRY_COUNT: '1', TEMPERATURE: '0.5' };
  const secrets = importedContentRedactions({ env, mcp: [{ name: 'native-mcp', url: 'http://localhost:9000/native-mcp?enabled=true&retry=1' }, { name: 'touchdesigner-mcp', url: 'http://localhost:9001/touchdesigner-mcp' }], credentials: [] });
  const text = '192.168.10.100 sys.exit(1) action="store_true" <path d="M1 0.5"/> native-mcp touchdesigner-mcp';
  expect(redactEnvironmentValues(text, secrets)).toBe(text);
  expect(redactEnvironmentValues('secret=1', { API_KEY: '1' })).toBe('secret=[API_KEY]');
});

it.each(['abcdefghijklmnop', 'abc', 'mcp', 'native-mcp', 'fake%2Ftoken'])('masks capability path %s in results, errors and readable imports', credential => {
  const server = { name: 'fixture', url: `https://example.invalid/hooks/${credential}` };
  const decoded = decodeURIComponent(credential);
  const result = { isError: true, content: [{ type: 'text', text: `Credential: ${credential}; decoded: ${decoded}` }] };
  for (const masks of [connectionRedactions(server, {}), importedContentRedactions({ env: {}, mcp: [server], credentials: [] })]) {
    const output = JSON.stringify(redactImportedResult(result, masks));
    expect(output).not.toContain(credential);
    expect(output).not.toContain(decoded);
    expect(redactEnvironmentValues(decoded, masks)).not.toBe(decoded);
  }
  expect(server.url).toBe(`https://example.invalid/hooks/${credential}`);
});

it('only exempts explicit routing paths, not arbitrary local or remote path shapes', () => {
  for (const origin of ['http://localhost:9000', 'https://example.invalid']) {
    const masks = connectionRedactions({ name: 'fixture', url: `${origin}/api/v1/mcp/abcdefghijklmnop` }, {});
    expect(redactEnvironmentValues('api v1 mcp', masks)).toBe('api v1 mcp');
    expect(redactEnvironmentValues('abcdefghijklmnop', masks)).not.toBe('abcdefghijklmnop');
  }
  const encodedRoute = connectionRedactions({ name: 'fixture', url: 'https://example.invalid/%68ooks/mcp' }, {});
  expect(redactEnvironmentValues('mcp', encodedRoute)).not.toBe('mcp');
  const explicit = connectionRedactions({ name: 'fixture', url: 'http://localhost:9000/native-mcp', headers: { Authorization: 'Bearer native-mcp' } }, {});
  expect(redactEnvironmentValues('native-mcp', explicit)).not.toBe('native-mcp');
});
