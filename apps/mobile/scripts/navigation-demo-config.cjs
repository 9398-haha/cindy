// Branch-local trial identity. Never reuse a production installation or OTA feed.
function applyNavigationDemoConfig(config, env = process.env) {
  if (env.EXPO_PUBLIC_CINDY_NAV_DEMO !== '1') return config;
  const region = env.EXPO_PUBLIC_CINDY_AUTH_REGION;
  if (region !== 'global' && region !== 'cn') throw new Error('Navigation demo requires an explicit cn/global region');
  if (env.EXPO_PUBLIC_XDT_OTA_SELFHOST === '1' || env.EAS_PROJECT_ID || env.EAS_BUILD_PROFILE || env.CINDY_USE_LOCAL_REGION_CONFIG === '1') {
    throw new Error('Navigation demo cannot use existing self-host, EAS project or release profiles');
  }
  // Provider callbacks must be provisioned for this separate app before use. Do
  // not let a developer shell accidentally embed the production registrations.
  for (const key of ['EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME', 'EXPO_PUBLIC_CINDY_WECHAT_APP_ID']) {
    if (env[key]?.trim()) throw new Error(`Navigation demo requires separate login provisioning: ${key}`);
  }
  const identity = region === 'cn' ? 'com.xd.cindycn.navdemo' : 'com.xd.cindy.navdemo';
  const scheme = region === 'cn' ? 'cindycnnavdemo' : 'cindynavdemo';
  return {
    ...config,
    name: region === 'cn' ? 'Cindy 导航试用 CN' : 'Cindy Navigation Demo',
    slug: region === 'cn' ? 'cindy-navigation-demo-cn' : 'cindy-navigation-demo',
    scheme,
    ios: { ...config.ios, bundleIdentifier: identity, associatedDomains: [] },
    android: { ...config.android, package: identity, intentFilters: [] },
    updates: { enabled: false, checkAutomatically: 'NEVER' },
    extra: { ...config.extra, navigationDemo: true },
  };
}
module.exports = { applyNavigationDemoConfig };
