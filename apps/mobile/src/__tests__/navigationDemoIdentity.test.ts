import { afterEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ applicationId: 'com.xd.cindy', marked: true }));
vi.mock('expo-application', () => ({ nativeApplicationVersion: '0.1.0', get applicationId() { return fixture.applicationId; } }));
vi.mock('expo-constants', () => ({ default: { get expoConfig() { return { extra: { navigationDemo: fixture.marked } }; } } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => undefined } }));
afterEach(() => vi.unstubAllEnvs());
describe('navigation demo installation boundary', () => {
  it.each([
    ['com.xd.cindy', true, '1', false],
    ['com.xd.cindycn', true, '1', false],
    ['com.xd.cindy.navdemo', false, '1', false],
    ['com.xd.cindy.navdemo', true, '0', false],
    ['com.xd.cindy.navdemo', true, '1', true],
    ['com.xd.cindycn.navdemo', true, '1', true],
  ])('checks native ID %s, marker %s and opt-in %s', async (id, marked, flag, expected) => {
    vi.resetModules(); fixture.applicationId = id; fixture.marked = marked;
    vi.stubEnv('EXPO_PUBLIC_CINDY_NAV_DEMO', flag);
    const config = await import('@/config/navigationDemo');
    expect(config.IS_NAVIGATION_DEMO).toBe(expected);
    if (expected) expect(config.NAVIGATION_DEMO_SCHEME).toBe(id.includes('cindycn') ? 'cindycnnavdemo' : 'cindynavdemo');
  });
});

describe('navigation trial browser login redirect', () => {
  it.each([
    ['cn', 'ios', 'com.xd.cindycn.navdemo', 'cindycnnavdemo', 'cindycn://auth'],
    ['global', 'ios', 'com.xd.cindy.navdemo', 'cindynavdemo', 'cindy://auth'],
    ['cn', 'android', 'com.xd.cindycn.navdemo', 'cindycnnavdemo', 'cindycnnavdemo://auth'],
    ['global', 'android', 'com.xd.cindy.navdemo', 'cindynavdemo', 'cindynavdemo://auth'],
    ['cn', 'ios', 'com.xd.cindycn', 'cindycn', 'cindycn://auth'],
    ['global', 'ios', 'com.xd.cindy', 'cindy', 'cindy://auth'],
  ])('keeps %s %s install %s isolated while choosing the supported browser callback', async (region, platform, id, scheme, callback) => {
    vi.resetModules(); fixture.applicationId = id; fixture.marked = true;
    vi.stubEnv('EXPO_PUBLIC_CINDY_NAV_DEMO', '1');
    vi.stubEnv('EXPO_PUBLIC_CINDY_AUTH_REGION', region);
    vi.stubEnv('EXPO_OS', platform);
    const config = await import('@/config/env');
    expect(config.APP_SCHEME).toBe(scheme);
    expect(config.MOBILE_REDIRECT_URL).toBe(callback);
    const { matchesOAuthCallbackUrl } = await import('@/auth/oauthCallback');
    expect(matchesOAuthCallbackUrl(callback + '?code=test-only&state=test-only', config.MOBILE_REDIRECT_URL)).toBe(true);
    expect(matchesOAuthCallbackUrl(callback + '/other?code=test-only&state=test-only', config.MOBILE_REDIRECT_URL)).toBe(false);
  });
});
