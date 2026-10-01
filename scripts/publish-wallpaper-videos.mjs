#!/usr/bin/env node
// Videos stay outside the application bundle. Publish exact reviewed bytes only.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createOSSClient, resolveOssConfig, uploadToOSS } from './shared/oss.mjs';

const args = process.argv.slice(2);
const region = args.find(arg => arg.startsWith('--region='))?.slice(9) ?? 'global';
const directory = args.find(arg => arg.startsWith('--directory='))?.slice(12);
const verifyOnly = args.includes('--verify-only');
if (!directory || !['global', 'cn'].includes(region)) {
  throw new Error('Usage: node [--env-file=...] scripts/publish-wallpaper-videos.mjs --directory=<videos> --region=global|cn [--verify-only]');
}
const manifest = JSON.parse(await fs.readFile(new URL('../apps/desktop/src/shared/wallpaper-video-manifest.json', import.meta.url), 'utf8'));
const assets = [];
for (const [id, asset] of Object.entries(manifest)) {
  const file = path.resolve(directory, id + '-hd.mp4');
  const bytes = await fs.readFile(file);
  if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new Error('Video differs from reviewed manifest: ' + id);
  }
  assets.push({ file, ...asset });
  console.log(id + ': ' + asset.width + 'x' + asset.height + ', ' + asset.bytes + ' bytes');
}
console.log('Total: ' + assets.reduce((sum, asset) => sum + asset.bytes, 0) + ' bytes');
if (!verifyOnly) {
  // Missing publication configuration must never redirect to another region.
  const config = resolveOssConfig(region);
  const client = createOSSClient(region);
  for (const asset of assets) {
    const relative = 'wallpapers/' + asset.sha256 + '.mp4';
    await uploadToOSS(client, config.prefix.replace(/\/+$/, '') + '/' + relative, asset.file, {
      headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
    const response = await fetch(config.cdnBase + '/' + relative, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error('Published CDN resource is not readable: ' + response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
      throw new Error('CDN resource integrity mismatch');
    console.log('Verified ' + relative);
  }
}
