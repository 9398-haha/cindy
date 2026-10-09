// @vitest-environment jsdom
import React, { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  platform: 'android',
  storage: new Map<string, string>(),
  links: new Set<(event: { url: string }) => void>(),
  open: vi.fn(),
  exchange: vi.fn(),
  selectAccount: vi.fn(),
  requestBinding: vi.fn(),
  requestVerification: vi.fn(),
  providers: vi.fn(),
  initialUrl: vi.fn(),
  requestCode: vi.fn(),
  discoverOrganization: vi.fn(),
  crossRealm: false,
  state: 0,
}));

vi.mock('react-native', () => ({
  Platform: { get OS() { return native.platform; } },
  AppState: { addEventListener: () => ({ remove() {} }) },
  Linking: {
    getInitialURL: native.initialUrl,
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
  getMobileEndpointRealmConfig: () => ({ crossRealmOrgLoginEnabled: native.crossRealm }),
  loadMobileEndpointsForRealm: async () => {},
  activateMobileSessionRealm() {}, resetMobileSessionRealm() {},
}));
vi.mock('@cindy/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/auth-client')>();
  return {
    ...actual,
    CindyAuthClient: class {
      getProviders = native.providers;
      requestCode = native.requestCode;
      discoverSsoOrg = native.discoverOrganization;
      buildAuthorizeUrl = ({ state }: { state: string }) => `https://auth.example.invalid/authorize?state=${state}`;
      exchangeAuthorizationCode = native.exchange;
      selectAccount = native.selectAccount;
      requestBindingCode = native.requestBinding;
      requestSsoVerificationCode = native.requestVerification;
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

function LoginScreenLifecycle() {
  const value = useAuth();
  const initialized = useRef(false);
  useEffect(() => {
    if (!value.initialized || value.isAuthenticated || initialized.current) return;
    initialized.current = true;
    void value.dispatchLoginAction({ type: 'initialize' });
  }, [value]);
  return null;
}

async function mountLoginScreen(key: string) {
  await act(async () => {
    root.render(<AuthProvider><Probe /><LoginScreenLifecycle key={key} /></AuthProvider>);
  });
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
    native.crossRealm = false;
    native.discoverOrganization.mockReset().mockResolvedValue({
      region: 'cn', orgName: 'Fixture Organization',
      connections: [{ connectionId: 'fixture-connection', connectionName: 'Fixture SSO', protocol: 'wecom' }],
    });
    native.providers.mockReset().mockResolvedValue({ social: ['wechat'], emailCode: true, smsCode: false });
    native.initialUrl.mockReset().mockResolvedValue(null);
    native.requestCode.mockReset().mockResolvedValue(undefined);
    native.storage.clear();
    native.state = 0;
    native.open.mockReset().mockResolvedValue({ type: 'dismiss' });
    native.exchange.mockReset().mockResolvedValue(verifiedOutcome);
    native.selectAccount.mockReset().mockResolvedValue(verifiedOutcome);
    native.requestBinding.mockReset().mockResolvedValue(undefined);
    native.requestVerification.mockReset().mockResolvedValue(undefined);
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

  it.each(['before-callback', 'during-exchange'] as const)(
    'preserves browser login when the login screen remounts %s', async timing => {
      await mountLoginScreen('initial');
      await start();
      const url = callbackUrl();
      const pending = native.storage.get(pendingKey);
      let complete!: (value: typeof verifiedOutcome) => void;
      native.exchange.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
      if (timing === 'during-exchange') await emitLink(url);
      await mountLoginScreen('remounted-after-deep-link');
      expect(auth.loginState?.step).toBe('browser-redirect');
      expect(native.storage.get(pendingKey)).toBe(pending);
      if (timing === 'before-callback') await emitLink(url);
      expect(native.exchange).toHaveBeenCalledExactlyOnceWith('fixture-code', 'fixture-verifier');
      await act(async () => { complete(verifiedOutcome); });
      expect(auth.loginState?.step).toBe('sso-verification');
      expect(auth.authError).toBeNull();
      expect(native.storage.has(pendingKey)).toBe(false);
    },
  );

  it('still cancels and retries explicitly after the login screen has remounted', async () => {
    await mountLoginScreen('initial');
    await start();
    const oldUrl = callbackUrl();
    await mountLoginScreen('remounted-after-deep-link');
    await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    expect(auth.loginState?.step).toBe('identifier');
    expect(native.storage.has(pendingKey)).toBe(false);
    await start();
    await emitLink(oldUrl);
    expect(native.exchange).not.toHaveBeenCalled();
    await emitLink(callbackUrl());
    expect(native.exchange).toHaveBeenCalledTimes(1);
    expect(auth.loginState?.step).toBe('sso-verification');
    expect(auth.authError).toBeNull();
  });

  describe.each(['android', 'ios'])('completed browser exchange on %s', platform => {
    it.each([
      { outcome: { status: 'select_account', loginTicket: 'fixture-login-ticket', accounts: [] }, step: 'account-selection',
        action: { type: 'select-account', accountId: 'fixture-account' }, request: native.selectAccount,
        args: ['fixture-login-ticket', 'fixture-account'] },
      { outcome: { status: 'binding_required', bindType: 'email', bindTicket: 'fixture-bind-ticket' }, step: 'binding',
        action: { type: 'request-binding-code', contact: 'user@example.invalid' }, request: native.requestBinding,
        args: ['fixture-bind-ticket', 'email', 'user@example.invalid'] },
      { outcome: verifiedOutcome, step: 'sso-verification',
        action: { type: 'request-sso-verification-code' }, request: native.requestVerification,
        args: ['fixture-ticket'] },
    ] as const)('preserves $step and its ticket when navigation remounts the screen', async fixture => {
      native.platform = platform;
      native.exchange.mockResolvedValue(fixture.outcome);
      native.open.mockImplementation(async () => ({ type: 'success', url: callbackUrl() }));
      await mountLoginScreen('initial');
      await start();
      expect(auth.loginState?.step).toBe(fixture.step);
      expect(native.storage.has(pendingKey)).toBe(false);
      await mountLoginScreen('remounted-after-exchange');
      expect(auth.loginState?.step).toBe(fixture.step);
      await act(async () => { expect(await auth.dispatchLoginAction(fixture.action)).toBe(true); });
      expect(fixture.request).toHaveBeenCalledExactlyOnceWith(...fixture.args);
      expect(auth.authError).toBeNull();
      // An explicit cancellation must still clear the retained continuation ticket.
      await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
      fixture.request.mockClear();
      await act(async () => { expect(await auth.dispatchLoginAction(fixture.action)).toBe(false); });
      expect(fixture.request).not.toHaveBeenCalled();
    });
  });

  it.each(['android', 'ios'])('retains the personal OAuth organization confirmation on %s', async platform => {
    native.platform = platform;
    native.exchange.mockResolvedValueOnce({
      status: 'ok', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresIn: 3600,
      membership: { id: 'fixture-personal', kind: 'personal', role: 'owner', displayName: 'Fixture',
        email: 'user@example.invalid', orgId: null, orgName: null },
    });
    native.open.mockImplementation(async () => ({ type: 'success', url: callbackUrl() }));
    await mountLoginScreen('initial');
    await start('social');
    expect(auth.loginState).toMatchObject({ step: 'realm-confirmation', personalLoginAvailable: true });
    await mountLoginScreen('remounted-after-personal-exchange');
    expect(auth.loginState).toMatchObject({ step: 'realm-confirmation', personalLoginAvailable: true });
    await act(async () => { expect(await auth.dispatchLoginAction({ type: 'confirm-sso-realm' })).toBe(true); });
    expect(native.open).toHaveBeenCalledTimes(2);
    expect(auth.loginState?.step).toBe('sso-verification');
  });

  it('initializes an empty flow once without consuming persisted OAuth', async () => {
    await act(async () => { await auth.cancelAddAccount(); });
    const pending = JSON.stringify({ state: 'fixture-cold-state', codeVerifier: 'fixture-verifier',
      deviceId: 'fixture-device', realm: 'cn', label: 'Fixture SSO', createdAt: Date.now() });
    native.storage.set(pendingKey, pending);
    native.providers.mockClear();
    await mountLoginScreen('initial');
    expect(auth.loginState?.step).toBe('identifier');
    expect(native.storage.get(pendingKey)).toBe(pending);
    await mountLoginScreen('remounted');
    expect(native.providers).toHaveBeenCalledTimes(1);
    await emitLink(callbackUrl());
    expect(auth.loginState?.step).toBe('sso-verification');
  });

  it.each(['pending', 'finished', 'failed-provider'] as const)(
    'does not let slow initialization overwrite a cold callback (%s)', async timing => {
      await act(async () => { await auth.cancelAddAccount(); });
      native.storage.set(pendingKey, JSON.stringify({ state: 'fixture-cold-state', codeVerifier: 'fixture-verifier',
        deviceId: 'fixture-device', realm: 'cn', label: 'Fixture SSO', createdAt: Date.now() }));
      let finishProviders!: (value: unknown) => void;
      let failProviders!: (error: Error) => void;
      native.providers.mockImplementationOnce(() => new Promise((resolve, reject) => {
        finishProviders = resolve; failProviders = reject;
      }));
      let complete!: (value: typeof verifiedOutcome) => void;
      native.exchange.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
      await mountLoginScreen('initial');
      await emitLink(callbackUrl());
      expect(native.exchange).toHaveBeenCalledTimes(1);
      if (timing !== 'pending') await act(async () => { complete(verifiedOutcome); });
      await act(async () => {
        if (timing === 'failed-provider') failProviders(new Error('fixture network failure'));
        else finishProviders({ social: ['wechat'], emailCode: true, smsCode: false });
      });
      if (timing === 'pending') {
        expect(auth.isBusy).toBe(true);
        expect(auth.loginState).toBeNull();
        await act(async () => { complete(verifiedOutcome); });
      }
      expect(auth.loginState?.step).toBe('sso-verification');
      expect(auth.authError).toBeNull();
      expect(auth.isBusy).toBe(false);
    },
  );

  it('keeps a cold getInitialURL callback alive when the login screen mounts during exchange', async () => {
    await act(async () => root.unmount());
    native.storage.set(pendingKey, JSON.stringify({ state: 'fixture-cold-state', codeVerifier: 'fixture-verifier',
      deviceId: 'fixture-device', realm: 'cn', label: 'Fixture SSO', createdAt: Date.now() }));
    native.initialUrl.mockResolvedValue(callbackUrl());
    let complete!: (value: typeof verifiedOutcome) => void;
    native.exchange.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    root = createRoot(document.createElement('div'));
    await mountLoginScreen('cold-start');
    expect(native.exchange).toHaveBeenCalledTimes(1);
    expect(native.storage.has(pendingKey)).toBe(true);
    await act(async () => { complete(verifiedOutcome); });
    expect(auth.loginState?.step).toBe('sso-verification');
    expect(auth.authError).toBeNull();
  });

  it('preserves personal verification-code state and explicitly resets it', async () => {
    await act(async () => { expect(await auth.dispatchLoginAction({
      type: 'request-code', kind: 'email', identifier: 'user@example.invalid',
    })).toBe(true); });
    const before = auth.loginState;
    expect(before?.step).toBe('verification-code');
    await mountLoginScreen('remounted-code-entry');
    expect(auth.loginState).toBe(before);
    await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    expect(auth.loginState?.step).toBe('identifier');
  });

  it('keeps add-account initialization and cancellation as explicit lifecycle boundaries', async () => {
    await start();
    const oldUrl = callbackUrl();
    await act(async () => { await auth.beginAddAccount(); });
    expect(auth.loginState?.step).toBe('identifier');
    expect(native.storage.has(pendingKey)).toBe(false);
    await start();
    await mountLoginScreen('add-account-remount');
    await emitLink(oldUrl);
    expect(native.exchange).not.toHaveBeenCalled();
    await emitLink(callbackUrl());
    expect(auth.loginState?.step).toBe('sso-verification');
    await act(async () => { await auth.cancelAddAccount(); });
    expect(auth.loginState).toBeNull();
    await act(async () => { expect(await auth.dispatchLoginAction({ type: 'request-sso-verification-code' })).toBe(false); });
    expect(native.requestVerification).not.toHaveBeenCalled();
  });

  it.each(['method-choice', 'realm-confirmation'] as const)('preserves %s before starting browser authorization', async step => {
    native.crossRealm = true;
    native.discoverOrganization.mockResolvedValue({
      region: step === 'realm-confirmation' ? 'global' : 'cn', orgName: 'Fixture Organization',
      connections: [
        { connectionId: 'fixture-one', connectionName: 'Fixture One', protocol: 'wecom' },
        { connectionId: 'fixture-two', connectionName: 'Fixture Two', protocol: 'oidc' },
      ],
    });
    await start();
    const state = auth.loginState;
    expect(state?.step).toBe(step);
    await mountLoginScreen('remounted-discovery');
    expect(auth.loginState).toBe(state);
    expect(native.open).not.toHaveBeenCalled();
    if (step === 'realm-confirmation') {
      await act(async () => { expect(await auth.dispatchLoginAction({ type: 'cancel-sso-realm' })).toBe(true); });
    } else {
      await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    }
    expect(auth.loginState?.step).toBe('identifier');
  });

  it('reports initial provider failures without deleting pending OAuth and allows retry', async () => {
    await act(async () => { await auth.cancelAddAccount(); });
    native.storage.set(pendingKey, 'fixture-pending-record');
    native.providers.mockRejectedValueOnce(new Error('fixture provider unavailable'));
    await mountLoginScreen('failed-initialization');
    expect(auth.loginState).toBeNull();
    expect(auth.authError).not.toBeNull();
    expect(auth.isBusy).toBe(false);
    expect(native.storage.get(pendingKey)).toBe('fixture-pending-record');
    await mountLoginScreen('retried-initialization');
    expect(auth.loginState?.step).toBe('identifier');
    expect(auth.authError).toBeNull();
  });

  it.each([
    { name: 'select-account', outcome: { status: 'select_account', loginTicket: 'fixture-select', accounts: [] },
      action: { type: 'select-account', accountId: 'fixture-account' }, request: native.selectAccount },
    { name: 'binding', outcome: { status: 'binding_required', bindType: 'email', bindTicket: 'fixture-bind' },
      action: { type: 'request-binding-code', contact: 'user@example.invalid' }, request: native.requestBinding },
    { name: 'verification', outcome: verifiedOutcome,
      action: { type: 'request-sso-verification-code' }, request: native.requestVerification },
    { name: 'back', outcome: verifiedOutcome, action: { type: 'reset' }, request: native.providers },
  ] as const)('executes $name immediately while initialization is still awaiting providers', async fixture => {
    await act(async () => { await auth.cancelAddAccount(); });
    native.storage.set(pendingKey, JSON.stringify({ state: 'fixture-cold-state', codeVerifier: 'fixture-verifier',
      deviceId: 'fixture-device', realm: 'cn', label: 'Fixture SSO', createdAt: Date.now() }));
    let finishProviders!: (value: unknown) => void;
    native.providers.mockImplementationOnce(() => new Promise(resolve => { finishProviders = resolve; }));
    native.exchange.mockResolvedValueOnce(fixture.outcome);
    await mountLoginScreen('initial');
    await emitLink(callbackUrl());
    expect(auth.isBusy).toBe(false);
    fixture.request.mockClear();
    let actionFinished = false;
    await act(async () => {
      void auth.dispatchLoginAction(fixture.action).then(result => { actionFinished = result; });
    });
    expect(fixture.request).toHaveBeenCalledTimes(1);
    expect(actionFinished).toBe(true);
    const state = auth.loginState;
    await act(async () => { finishProviders({ social: ['wechat'], emailCode: true, smsCode: false }); });
    expect(auth.loginState).toBe(state);
    expect(auth.authError).toBeNull();
  });

  it.each(['success', 'failure'] as const)('ignores late initialization %s while the next user request is running', async result => {
    await act(async () => { await auth.cancelAddAccount(); });
    native.storage.set(pendingKey, JSON.stringify({ state: 'fixture-cold-state', codeVerifier: 'fixture-verifier',
      deviceId: 'fixture-device', realm: 'cn', label: 'Fixture SSO', createdAt: Date.now() }));
    let finish!: (value: unknown) => void;
    let fail!: (error: Error) => void;
    native.providers.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    await mountLoginScreen('initial');
    await emitLink(callbackUrl());
    let finishCode!: () => void;
    native.requestVerification.mockImplementationOnce(() => new Promise<void>(resolve => { finishCode = resolve; }));
    let codeRequest!: Promise<boolean>;
    await act(async () => { codeRequest = auth.dispatchLoginAction({ type: 'request-sso-verification-code' }); });
    expect(native.requestVerification).toHaveBeenCalledTimes(1);
    expect(auth.isBusy).toBe(true);
    const state = auth.loginState;
    await act(async () => {
      if (result === 'success') finish({ social: ['wechat'], emailCode: true, smsCode: false });
      else fail(new Error('fixture obsolete initialization failure'));
    });
    expect(auth.loginState).toBe(state);
    expect(auth.isBusy).toBe(true);
    expect(auth.authError).toBeNull();
    await act(async () => { finishCode(); expect(await codeRequest).toBe(true); });
    expect(auth.loginState).toMatchObject({ step: 'sso-verification', codeRequested: true });
    expect(auth.isBusy).toBe(false);
  });

  it('deduplicates initialization independently and abandons it on explicit reset', async () => {
    await act(async () => { await auth.cancelAddAccount(); });
    let finish!: (value: unknown) => void;
    native.providers.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    let first!: Promise<boolean>;
    await act(async () => {
      first = auth.dispatchLoginAction({ type: 'initialize' });
      expect(auth.dispatchLoginAction({ type: 'initialize' })).toBe(first);
    });
    await act(async () => { expect(await auth.dispatchLoginAction({ type: 'reset' })).toBe(true); });
    expect(auth.loginState?.step).toBe('identifier');
    const state = auth.loginState;
    await act(async () => { finish({ social: [], emailCode: false, smsCode: true }); expect(await first).toBe(false); });
    expect(auth.loginState).toBe(state);
    expect(auth.isBusy).toBe(false);
  });

  it('does not reuse or clear a new initialization after add-account cancellation changes the epoch', async () => {
    await act(async () => { await auth.cancelAddAccount(); });
    let finishOld!: (value: unknown) => void;
    let finishNew!: (value: unknown) => void;
    native.providers
      .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
    let old!: Promise<boolean>;
    let current!: Promise<boolean>;
    await act(async () => { old = auth.dispatchLoginAction({ type: 'initialize' }); });
    await act(async () => { await auth.cancelAddAccount(); });
    await act(async () => { current = auth.dispatchLoginAction({ type: 'initialize' }); });
    expect(current).not.toBe(old);
    await act(async () => { finishOld({ social: [], emailCode: true, smsCode: false }); expect(await old).toBe(false); });
    expect(auth.loginState).toBeNull();
    expect(auth.isBusy).toBe(true);
    await act(async () => { finishNew({ social: ['wechat'], emailCode: true, smsCode: false }); expect(await current).toBe(true); });
    expect(auth.loginState?.step).toBe('identifier');
    expect(auth.isBusy).toBe(false);
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
