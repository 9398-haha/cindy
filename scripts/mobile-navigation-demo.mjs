#!/usr/bin/env node
// Local-only trial entry. No dev server, distribution signing, publishing or OTA upload.
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { podInstallBounded } from '../apps/mobile/scripts/sim-pod-install.mjs';
import { computeSimulatorNativeFingerprint, inspectSimulatorNativeIdentity } from '../apps/mobile/scripts/lib/sim-native-identity.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mobile = resolve(root, 'apps/mobile');
const args = process.argv.slice(2);
const command = args[0] ?? 'inspect';
const region = args.find(arg => arg.startsWith('--region='))?.slice(9);
const platform = args.find(arg => arg.startsWith('--platform='))?.slice(11);
const udid = args.find(arg => arg.startsWith('--udid='))?.slice(7);
if (!['inspect', 'export', 'simulator'].includes(command) || !['cn', 'global'].includes(region)
  || args.some((arg, index) => index > 0 && !arg.startsWith('--region=') && !arg.startsWith('--platform=') && !arg.startsWith('--udid='))
  || (command === 'export' && !['ios', 'android'].includes(platform))
  || (command === 'simulator' && (process.platform !== 'darwin' || !/^[A-Fa-f0-9-]{36}$/.test(udid ?? '')))) {
  throw new Error('Usage: inspect --region=cn|global; export --region=cn|global --platform=ios|android; simulator --region=cn|global --udid=<booted simulator UUID>');
}
const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
if (branch !== 'experiment/mobile-bottom-navigation') throw new Error('This entry belongs to experiment/mobile-bottom-navigation only');
execFileSync('git', ['merge-base', '--is-ancestor', 'c2dd5e0c5669420a785c1dfe2edd6bcc660afb9c', 'HEAD'], { cwd: root });

// No .env or production provider registrations are borrowed from other worktrees.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('EXPO_PUBLIC_CINDY_GOOGLE_') || key.startsWith('EXPO_PUBLIC_CINDY_WECHAT_')
    || key.startsWith('EAS_') || key === 'CINDY_SELF_HOST_REGIONS_FILE'
    || key === 'CINDY_MOBILE_UPDATES_URL' || key === 'CINDY_MOBILE_OTA_NATIVE'
    || key === 'EXPO_PUBLIC_APP_VARIANT' || key === 'EXPO_PUBLIC_BETA_DEV') delete process.env[key];
}
Object.assign(process.env, {
  EXPO_PUBLIC_CINDY_NAV_DEMO: '1', EXPO_PUBLIC_CINDY_AUTH_REGION: region,
  EXPO_PUBLIC_XDT_OTA_SELFHOST: '0', CINDY_USE_LOCAL_REGION_CONFIG: '0',
  EXPO_NO_DOTENV: '1', EXPO_NO_TELEMETRY: '1',
});
const require = createRequire(import.meta.url);
const config = require(resolve(mobile, 'app.config.js'))();
const expectedId = region === 'cn' ? 'com.xd.cindycn.navdemo' : 'com.xd.cindy.navdemo';
if (config.ios.bundleIdentifier !== expectedId || config.android.package !== expectedId
  || config.updates.enabled !== false || config.updates.url || config.extra.eas) {
  throw new Error('Trial isolation check failed');
}
console.log(JSON.stringify({ directory: root, branch, baseline: 'c2dd5e0c56', region,
  applicationId: expectedId, scheme: config.scheme, automaticUpdates: false,
  nativeInstallVerified: false }, null, 2));
if (command === 'export' || command === 'simulator') {
  // Metro resolves even the unused dev require. Use the public example only;
  // never copy an internal endpoint file or .env from another worktree.
  const devEndpoint = resolve(root, 'config/endpoint.dev.json');
  if (!existsSync(devEndpoint)) copyFileSync(resolve(root, 'config/endpoint.dev.json.example'), devEndpoint, constants.COPYFILE_EXCL);
}
if (command === 'export') {
  const destination = mkdtempSync(resolve(tmpdir(), 'cindy-navigation-demo-' + region + '-' + platform + '-'));
  console.log('Export destination: ' + destination);
  const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'expo', 'export', '--platform', platform, '--output-dir', destination, '--max-workers', '2'],
    { cwd: mobile, env: process.env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
if (command === 'simulator') {
  const run = (bin, argv, cwd = mobile) => execFileSync(bin, argv, { cwd, env: process.env, stdio: 'inherit' });
  const capture = (bin, argv) => execFileSync(bin, argv, { cwd: mobile, env: process.env, encoding: 'utf8' }).trim();
  const xcodeVersion = capture('xcodebuild', ['-version']);
  const version = /Xcode (\d+)\.(\d+)/.exec(xcodeVersion);
  if (!version || Number(version[1]) < 27 || (Number(version[1]) === 27 && Number(version[2]) < 1)) {
    throw new Error('Navigation trial requires Xcode 27.1+ to compile Duo reserved-region support. Set DEVELOPER_DIR explicitly.');
  }
  // Swift 6.4 in 27.1 spells private C++ names __ObjC::expo instead of
  // __ObjC.expo. Extend Expo's existing interface sanitizer for this syntax.
  // Atomic replacement breaks pnpm hardlinks: other worktrees/store stay intact.
  const jsiScript = resolve(dirname(require.resolve('expo-modules-jsi/package.json')), 'apple/scripts/build-xcframework.sh');
  const jsiSource = readFileSync(jsiScript, 'utf8');
  const oldSanitizer = String.raw`/^extension __ObjC\./`;
  const newSanitizer = '/^extension __ObjC[.:]/';
  if (jsiSource.includes(oldSanitizer)) {
    const replacement = jsiScript + '.navigation-demo-tmp';
    writeFileSync(replacement, jsiSource.replace(oldSanitizer, newSanitizer), { mode: statSync(jsiScript).mode });
    renameSync(replacement, jsiScript);
  } else if (!jsiSource.includes(newSanitizer)) {
    throw new Error('ExpoModulesJSI interface sanitizer changed; review the trial Xcode compatibility adjustment');
  }
  const devices = JSON.parse(capture('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']));
  if (!Object.values(devices.devices).flat().some(device => device.udid.toLowerCase() === udid.toLowerCase() && device.state === 'Booted')) {
    throw new Error('Select an exact booted simulator; no other device will be changed');
  }
  Object.assign(process.env, { NODE_ENV: 'production', CI: '1' });
  const ios = resolve(mobile, 'ios');
  const buildDir = resolve(ios, 'build-navigation-demo-' + region);
  const readId = path => capture('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', resolve(path, 'Info.plist')]);
  let workspace = existsSync(ios) ? readdirSync(ios).find(name => name.endsWith('.xcworkspace')) : undefined;
  const previousApp = workspace
    ? resolve(buildDir, 'Build/Products/Release-iphonesimulator', workspace.slice(0, -'.xcworkspace'.length) + '.app')
    : null;
  const reusableNativeProject = previousApp && existsSync(resolve(previousApp, 'Info.plist'))
    && readId(previousApp) === expectedId
    && inspectSimulatorNativeIdentity({ appPath: previousApp, projectDir: mobile, env: process.env }).healthy;
  if (reusableNativeProject) {
    console.log('Native inputs still match the existing build; refreshing bundled JavaScript without regenerating Pods.');
  } else {
    console.log('Generating isolated native project (no device data or existing apps are removed).');
    run('pnpm', ['exec', 'expo', 'prebuild', '--platform', 'ios', '--no-install']);
    await podInstallBounded({ iosDir: ios, env: process.env });
    workspace = readdirSync(ios).find(name => name.endsWith('.xcworkspace'));
  }
  if (!workspace) throw new Error('Native workspace missing after prebuild');
  const scheme = workspace.slice(0, -'.xcworkspace'.length);
  console.log('Building self-contained simulator app. Existing Metro services are not used.');
  run('xcodebuild', ['-workspace', resolve(ios, workspace), '-scheme', scheme,
    '-configuration', 'Release', '-sdk', 'iphonesimulator', '-destination', 'platform=iOS Simulator,id=' + udid,
    '-derivedDataPath', buildDir, '-jobs', '4', 'ONLY_ACTIVE_ARCH=YES', '-quiet', 'build']);
  const app = resolve(buildDir, 'Build/Products/Release-iphonesimulator', scheme + '.app');
  const sdk = capture('plutil', ['-extract', 'DTSDKName', 'raw', '-o', '-', resolve(app, 'Info.plist')]);
  if (!/^iphonesimulator27\.[1-9]/.test(sdk) && !/^iphonesimulator(2[8-9]|[3-9]\d)/.test(sdk)) {
    throw new Error('Built app does not contain a Duo-capable 27.1+ simulator SDK identity');
  }
  capture('plutil', ['-extract', 'UIApplicationSceneManifest', 'json', '-o', '-', resolve(app, 'Info.plist')]);
  if (readId(app) !== expectedId) throw new Error('Refusing to install a non-trial app');
  if (!existsSync(resolve(app, 'main.jsbundle'))) throw new Error('Embedded JavaScript missing; refusing to depend on another Metro');
  const expectedFingerprint = computeSimulatorNativeFingerprint(mobile, process.env);
  const beforeInstall = inspectSimulatorNativeIdentity({ appPath: app, expectedFingerprint });
  if (!beforeInstall.healthy) throw new Error('Built native runtime mismatch: ' + beforeInstall.code);
  run('xcrun', ['simctl', 'install', udid, app]);
  const installedApp = capture('xcrun', ['simctl', 'get_app_container', udid, expectedId, 'app']);
  if (readId(installedApp) !== expectedId || !inspectSimulatorNativeIdentity({ appPath: installedApp, expectedFingerprint }).healthy) {
    throw new Error('Installed trial identity/runtime did not match the build');
  }
  run('xcrun', ['simctl', 'launch', '--terminate-running-process', udid, expectedId]);
  run(process.execPath, [resolve(mobile, 'scripts/sim-open.mjs'), '--udid', udid]);
  console.log(JSON.stringify({ app, udid, applicationId: expectedId, fingerprint: expectedFingerprint,
    embeddedJavaScript: true, nativeInstallVerified: true, pageVerified: false }, null, 2));
}
