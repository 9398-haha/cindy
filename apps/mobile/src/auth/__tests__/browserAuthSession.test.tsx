// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  platform: 'android',
  storage: new Map<string, string>(),
  links: new Set<(event: { url: string }) => void>(),
  open: vi.fn(),
  exchange: vi.fn(),
  state: 0,
}));

vi.mock('react-native', () => ({
  Platform: { get OS() { return native.platform; } },
  AppState: { addEventListener: () => ({ remove() {} }) },
  Linking: {
    getInitialURL: async () => null,
    addEventListener: (_: string, listener: (event: { url: string }) => void) => {
      native.links.add(listener);
      return { remove: () => native.links.delete(listener) };
    },
  },
  Keyboard: { dismiss() {} },
}));
vi.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession() {}, openAuthSessionAsync: native.open,
}));
vi.mock('expo-modules-core', () => ({ requireNativeModule: () => ({ addCustomField() {} }) }));
vi.mock('@/config/env', () => ({
  BUILD_AUTH_REGION: 'cn', MOBILE_REDIRECT_URL: 'cindycn://auth',
  IS_OTA_SELFHOST: false, MOBILE_VISUAL_MOCK_ENABLED: false,
  OAUTH_BROKER_API_BASE_URL: 'https://auth.example.invalid',
  getMobileEndpointForRealm: () => 'https://auth.example.invalid',
  getMobileEndpointRealmConfig: () => ({ crossRealmOrgLoginEnabled: false }),
  loadMobileEndpointsForRealm: async () => {},
  activateMobileSessionRealm() {}, resetMobileSessionRealm() {},
}));
vi.mock('@cindy/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/auth-client')>();
  return {
    ...actual,
    CindyAuthClient: class {
      getProviders = async () => ({ social: ['wechat'], emailCode: true, smsCode: false });
      discoverSsoOrg = async () => ({
        region: 'cn', orgName: 'Fixture Organization',
        connections: [{ connectionId: 'fixture-connection', connectionName: 'Fixture SSO', protocol: 'wecom' }],
      });
      buildAuthorizeUrl = ({ state }: { state: string }) => `https://auth.example.invalid/authorize?state=${state}`;
      exchangeAuthorizationCode = native.exchange;
    },
  };
});
vi.mock('@cindy/auth-client/fixtures', () => ({ resolveLoginScenarioFetch: () => undefined }));
vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: async (key: string) => native.storage.get(key) ?? null,
  setSecureItem: async (key: string, value: string) => { native.storage.set(key, value); },
  deleteSecureItem: async (key: string) => { native.storage.delete(key); },
}));
vi.mock('@/auth/pkce', () => ({
  createPkcePair: async () => ({ codeVerifier: 'fixture-verifier', codeChallenge: 'fixture-challenge' }),
  createState: () => `fixture-state-${++native.state}`,
}));
vi.mock('@/auth/deviceId', () => ({ ensureDeviceId: async () => 'fixture-device', hasStoredDeviceId: async () => true }));
vi.mock('@/auth/mobileAccountVault', () => ({
  readMobileAccountVault: async () => null,
  listMobileSavedAccounts: () => [],
  reconcileMobileActiveAuthSession: async () => null,
}));
vi.mock('@/api/client', () => ({ registerAccountUnavailableHandler: () => () => {} }));
vi.mock('@/auth/nativeSocial', () => ({}));
vi.mock('@/auth/ssoOrgHistory', () => ({ rememberSsoOrgIdentifier: async () => {} }));
vi.mock('@/auth/canaryChannelSync', () => ({}));
vi.mock('@/auth/xdOrgBetaDefault', () => ({}));
vi.mock('@/analytics/mobileTapdb', () => ({ clearTapdbUser: async () => {} }));
vi.mock('@/analytics/analyticsConsentStore', () => ({}));
vi.mock('@/notifications/pushNotifications', () => ({}));
vi.mock('@/session/agentCapabilitiesCache', () => ({}));
vi.mock('@/session/composerPaletteCache', () => ({}));
vi.mock('@/device-link/remoteResourceCache', () => ({}));
vi.mock('@/session/mobileHomeListCache', () => ({}));
vi.mock('@/device-link/clipboardInvitationHistory', () => ({}));
vi.mock('@/remote-desktop/credentialIdentity', () => ({}));
vi.mock('@/session/mobileSessionMessageCache', () => ({}));
vi.mock('@/session/remoteHistoryDiskCache', () => ({}));
vi.mock('@/session/mobileVoiceCredentialStore', () => ({ clearAllMobileVoiceCredentials: async () => {} }));
vi.mock('@/session/mobileVoiceDictionaryCache', () => ({ setMobileVoiceDictionaryAccountScope() {} }));
vi.mock('@/session/mobileVoiceHistoryStore', () => ({}));
vi.mock('@/debug/visualMock', () => ({}));
vi.mock('@/update/canaryChannelStore', () => ({}));
vi.mock('@/update/betaChannelStore', () => ({ prepareBetaChannelForDevice: async () => {} }));
vi.mock('@/update/fetchLatestRelease', () => ({}));

import { AuthProvider, useAuth } from '../AuthContext';

const pendingKey = 'cindy.mobile.auth.pendingOAuth';
const verifiedOutcome = {
  status: 'sso_verification_required', verificationTicket: 'fixture-ticket',
  channel: 'email', targetMasked: 'u***@example.invalid',
};
let auth: ReturnType<typeof useAuth>;
let root: Root;

function Probe() {
  auth = useAuth();
  return null;
}

function callbackUrl(state = JSON.parse(native.storage.get(pendingKey)!).state as string) {
  return `cindycn://auth?code=fixture-code&state=${state}`;
}

async function start(kind: 'sso' | 'social' = 'sso') {
  await act(async () => {
    await auth.dispatchLoginAction(kind === 'sso'
      ? { type: 'discover-sso-org', org: 'example.invalid' }
      : { type: 'start-social-browser', provider: 'wechat', label: 'WeChat' });
  });
}

async function emitLink(url: string) {
  await act(async () => {
    for (const listener of native.links) listener({ url });
  });
}

describe('browser auth session lifecycle (real AuthProvider, mocked native/network boundaries)', () => {
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    native.platform = 'android';
    native.storage.clear();
    native.state = 0;
    native.open.mockReset().mockResolvedValue({ type: 'dismiss' });
    native.exchange.mockReset().mockResolvedValue(verifiedOutcome);
    root = createRoot(document.createElement('div'));
    await act(async () => { root.render(<AuthProvider><Probe /></AuthProvider>); });
    expect(auth.initialized).toBe(true);
    await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    expect(native.links.size).toBe(0);
    vi.restoreAllMocks();
  });

  it.each(['sso', 'social'] as const)('retains %s login on Android dismiss and accepts a delayed deep link', async (kind) => {
    await start(kind);
    expect(auth.loginState?.step).toBe('browser-redirect');
    expect(auth.isBusy).toBe(false); // The existing Cancel button must be usable.
    expect(auth.authError).toBeNull();
    expect(native.storage.has(pendingKey)).toBe(true);
    expect(native.exchange).not.toHaveBeenCalled();

    await emitLink(callbackUrl());
    expect(native.exchange).toHaveBeenCalledExactlyOnceWith('fixture-code', 'fixture-verifier');
    expect(auth.loginState?.step).toBe('sso-verification');
    expect(native.storage.has(pendingKey)).toBe(false);
  });

  it('explicit reset cancels the pending login; its late callback cannot authenticate', async () => {
    await start();
    const oldCallback = callbackUrl();
    await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    expect(native.storage.has(pendingKey)).toBe(false);
    expect(auth.loginState?.step).toBe('identifier');
    await emitLink(oldCallback);
    expect(native.exchange).not.toHaveBeenCalled();
    expect(auth.authError).toBe('INVALID_AUTH_CODE');
    await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    await start();
    await emitLink(callbackUrl());
    expect(native.exchange).toHaveBeenCalledTimes(1);
  });

  it('an earlier attempt cannot consume the new attempt after cancel and retry', async () => {
    await start();
    const oldCallback = callbackUrl();
    await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    await start();
    const pending = native.storage.get(pendingKey);
    await emitLink(oldCallback);
    expect(native.exchange).not.toHaveBeenCalled();
    expect(auth.authError).toBe('STATE_MISMATCH');
    expect(native.storage.get(pendingKey)).toBe(pending);
    await emitLink(callbackUrl());
    expect(native.exchange).toHaveBeenCalledTimes(1);
    expect(auth.authError).toBeNull();
  });

  it('retaining the attempt does not extend its existing ten-minute PKCE lifetime', async () => {
    await start();
    const url = callbackUrl();
    const pending = JSON.parse(native.storage.get(pendingKey)!);
    vi.spyOn(Date, 'now').mockReturnValue(pending.createdAt + 10 * 60_000 + 1);
    await emitLink(url);
    expect(native.exchange).not.toHaveBeenCalled();
    expect(auth.authError).toBe('INVALID_AUTH_CODE');
    expect(native.storage.has(pendingKey)).toBe(false);
  });

  it.each(['android', 'ios'])('preserves normal successful browser callbacks on %s', async (platform) => {
    native.platform = platform;
    native.open.mockImplementation(async () => ({ type: 'success', url: callbackUrl() }));
    await start();
    expect(native.exchange).toHaveBeenCalledExactlyOnceWith('fixture-code', 'fixture-verifier');
    expect(auth.loginState?.step).toBe('sso-verification');
    expect(native.storage.has(pendingKey)).toBe(false);
  });

  it.each([['ios', 'cancel'], ['ios', 'dismiss'], ['android', 'cancel']])('preserves cleanup for %s %s', async (platform, type) => {
    native.platform = platform;
    native.open.mockResolvedValue({ type });
    // Existing non-dismiss cancellation rejects at the browser boundary.
    await act(async () => {
      await expect(auth.dispatchLoginAction({ type: 'discover-sso-org', org: 'example.invalid' }))
        .rejects.toMatchObject({ code: 'USER_CANCELLED' });
    });
    expect(native.storage.has(pendingKey)).toBe(false);
    expect(auth.loginState).toBeNull();
    expect(native.exchange).not.toHaveBeenCalled();
  });

  it('does not erase PKCE when Linking begins exchanging before Android dismiss resolves', async () => {
    let resolveExchange!: (value: typeof verifiedOutcome) => void;
    native.exchange.mockImplementation(() => new Promise((resolve) => { resolveExchange = resolve; }));
    native.open.mockImplementation(async () => {
      for (const listener of native.links) listener({ url: callbackUrl() });
      return { type: 'dismiss' };
    });
    await start();
    expect(native.exchange).toHaveBeenCalledTimes(1);
    expect(native.storage.has(pendingKey)).toBe(true);
    expect(auth.isBusy).toBe(true);
    await act(async () => { resolveExchange(verifiedOutcome); });
    expect(auth.loginState?.step).toBe('sso-verification');
    expect(auth.authError).toBeNull();
    expect(native.storage.has(pendingKey)).toBe(false);
  });

  it('retains in-flight deduplication for reset outside browser authorization', async () => {
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    await act(async () => {
      first = auth.dispatchLoginAction({ type: 'reset' });
      second = auth.dispatchLoginAction({ type: 'reset' });
      expect(second).toBe(first);
      await first;
    });
    expect(auth.loginState?.step).toBe('identifier');
    expect(auth.isBusy).toBe(false);
    expect(native.exchange).not.toHaveBeenCalled();
  });

  it('invalidates an iOS browser callback on explicit reset without changing successful return handling', async () => {
    native.platform = 'ios';
    let complete!: (value: typeof verifiedOutcome) => void;
    native.exchange.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    native.open.mockImplementation(async () => ({ type: 'success', url: callbackUrl() }));
    let cancelled!: Promise<unknown>;
    await act(async () => {
      cancelled = auth.dispatchLoginAction({ type: 'discover-sso-org', org: 'example.invalid' })
        .catch(error => error);
    });
    expect(native.exchange).toHaveBeenCalledTimes(1);
    await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    await act(async () => { complete(verifiedOutcome); await cancelled; });
    expect(auth.loginState?.step).toBe('identifier');
    expect(auth.authError).toBeNull();
    expect(auth.isBusy).toBe(false);
    expect(native.storage.has(pendingKey)).toBe(false);
  });

  it('keeps callback busy when Android dismiss arrives after the exchange has started', async () => {
    let dismiss!: (value: { type: string }) => void;
    let complete!: (value: typeof verifiedOutcome) => void;
    native.open.mockImplementation(() => new Promise(resolve => { dismiss = resolve; }));
    native.exchange.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    let action!: Promise<boolean>;
    await act(async () => {
      action = auth.dispatchLoginAction({ type: 'discover-sso-org', org: 'example.invalid' });
    });
    await emitLink(callbackUrl());
    expect(native.exchange).toHaveBeenCalledTimes(1);
    expect(auth.isBusy).toBe(true);
    await act(async () => { dismiss({ type: 'dismiss' }); await action; });
    expect(auth.isBusy).toBe(true);
    expect(native.storage.has(pendingKey)).toBe(true);
    await act(async () => { complete(verifiedOutcome); });
    expect(auth.isBusy).toBe(false);
    expect(auth.loginState?.step).toBe('sso-verification');
  });

  it.each(['success', 'failure'] as const)('reset and retry ignore the old exchange %s while the new exchange is running', async result => {
    let completeOld!: (value: typeof verifiedOutcome) => void;
    let rejectOld!: (error: Error) => void;
    let completeNew!: (value: typeof verifiedOutcome) => void;
    native.exchange
      .mockImplementationOnce(() => new Promise((resolve, reject) => { completeOld = resolve; rejectOld = reject; }))
      .mockImplementationOnce(() => new Promise(resolve => { completeNew = resolve; }));
    await start();
    await emitLink(callbackUrl());
    expect(native.exchange).toHaveBeenCalledTimes(1);
    // Exercise the cancellation boundary directly, including an already queued
    // reset event; disabling the rendered button is not an invalidation fence.
    await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    expect(auth.loginState?.step).toBe('identifier');
    await start();
    const pending = native.storage.get(pendingKey);
    await emitLink(callbackUrl());
    expect(native.exchange).toHaveBeenCalledTimes(2);
    expect(auth.isBusy).toBe(true);
    await act(async () => {
      if (result === 'success') completeOld(verifiedOutcome);
      else rejectOld(new Error('fixture exchange failure'));
    });
    expect(auth.loginState?.step).toBe('browser-redirect');
    expect(auth.authError).toBeNull();
    expect(auth.isBusy).toBe(true);
    expect(native.storage.get(pendingKey)).toBe(pending);
    await act(async () => { completeNew(verifiedOutcome); });
    expect(auth.loginState?.step).toBe('sso-verification');
    expect(auth.isBusy).toBe(false);
    expect(native.storage.has(pendingKey)).toBe(false);
  });

  it('still exchanges only once when Linking and the browser both report success', async () => {
    native.open.mockImplementation(async () => {
      const url = callbackUrl();
      for (const listener of native.links) listener({ url });
      return { type: 'success', url };
    });
    await start();
    expect(native.exchange).toHaveBeenCalledExactlyOnceWith('fixture-code', 'fixture-verifier');
    expect(auth.loginState?.step).toBe('sso-verification');
    expect(auth.authError).toBeNull();
  });
});
