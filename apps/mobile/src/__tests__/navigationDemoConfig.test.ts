import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { applyNavigationDemoConfig } = require('../../scripts/navigation-demo-config.cjs');
const base = { name: 'Cindy', scheme: 'cindy', ios: { bundleIdentifier: 'com.xd.cindy' }, android: { package: 'com.xd.cindy' }, updates: { url: 'https://updates.example.test', enabled: true }, extra: {} };
describe('isolated navigation demo configuration', () => {
  it('leaves ordinary builds untouched, including object identity', () => {
    expect(applyNavigationDemoConfig(base, {})).toBe(base);
  });
  it.each(['cn', 'global'])('uses a separate install, callback and no OTA feed for %s', region => {
    const result = applyNavigationDemoConfig(base, { EXPO_PUBLIC_CINDY_NAV_DEMO: '1', EXPO_PUBLIC_CINDY_AUTH_REGION: region });
    const id = region === 'cn' ? 'com.xd.cindycn.navdemo' : 'com.xd.cindy.navdemo';
    expect(result.ios.bundleIdentifier).toBe(id); expect(result.android.package).toBe(id);
    expect(result.scheme).toBe(region === 'cn' ? 'cindycnnavdemo' : 'cindynavdemo');
    expect(result.updates).toEqual({ enabled: false, checkAutomatically: 'NEVER' });
    expect(result.extra.navigationDemo).toBe(true);
    expect(result.ios.associatedDomains).toEqual([]); expect(result.android.intentFilters).toEqual([]);
    expect(base.ios.bundleIdentifier).toBe('com.xd.cindy');
  });
  it.each([
    { EXPO_PUBLIC_XDT_OTA_SELFHOST: '1' }, { EAS_PROJECT_ID: 'production-project' },
    { EAS_BUILD_PROFILE: 'production' }, { CINDY_USE_LOCAL_REGION_CONFIG: '1' },
    { EXPO_PUBLIC_CINDY_WECHAT_APP_ID: 'wx-production' }, { EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME: 'production-callback' },
  ])('rejects existing distribution/provider configuration %j', extra => {
    expect(() => applyNavigationDemoConfig(base, { EXPO_PUBLIC_CINDY_NAV_DEMO: '1', EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn', ...extra })).toThrow();
  });
  it('requires an explicit supported region', () => {
    expect(() => applyNavigationDemoConfig(base, { EXPO_PUBLIC_CINDY_NAV_DEMO: '1' })).toThrow();
  });
});
