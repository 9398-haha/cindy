import { describe, expect, it } from 'vitest';

import { isManagedMarkdownVideoUrl, markdownMediaFilename } from '../markdownMedia';

describe('managed Markdown media', () => {
  it.each([
    'cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4',
    'xdt-video://local/generated.webm',
    'cindy-remote-media://device/generated.mov?range=0-1',
  ])('recognizes %s as a video target', (url) => {
    expect(isManagedMarkdownVideoUrl(url)).toBe(true);
  });

  it.each([
    'cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
    'https://example.com/generated.mp4',
    'cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    undefined,
  ])('does not upgrade %s to a video target', (url) => {
    expect(isManagedMarkdownVideoUrl(url)).toBe(false);
  });

  it('prefers the Markdown alt text and falls back to the managed filename', () => {
    const url = 'cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4';
    expect(markdownMediaFilename(url, 'Seedance 雪景版 KV 动态预览')).toBe(
      'Seedance 雪景版 KV 动态预览',
    );
    expect(markdownMediaFilename(url)).toBe(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4',
    );
  });
});
