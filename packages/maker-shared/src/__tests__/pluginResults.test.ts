import { describe, it, expect } from 'vitest';
import { extractPayloadToolResultMedia as media, extractPayloadToolResultFiles as files, extractPayloadToolCardIds as cards } from '../payloadSummary.js';
import { hasVisibleHistoryResult } from '../historyViewProjection.js';
const blob = (ext: string) => `cindy-media://blobs/${'a'.repeat(64)}.${ext}`;

describe('portable plugin results', () => {
  it('reads host ledger images, video and audio and deduplicates declarations', () => {
    const result = JSON.stringify({ xdt_image_urls: [blob('png')], xdt_media_produced: [blob('png'), blob('mp4'), blob('mp3'), blob('glb'), 'file:///secret.png', 'https://external/p.png', 'cindy-media://other/p.png'] });
    expect(media(result).map(({ kind, url }) => [kind, url])).toEqual([['image', blob('png')], ['video', blob('mp4')], ['audio', blob('mp3')]]);
    expect(files(result)).toEqual([{ url: blob('glb'), title: `${'a'.repeat(64)}.glb` }]);
    expect(hasVisibleHistoryResult(result)).toBe(true);
  });
  it('reads the old ghost envelope, including singular fields and card anchors', () => {
    const result = JSON.stringify({ ok: true, result: { xdt_image_url: blob('png'), xdt_video_url: blob('mp4'), xdt_card_id: 'c', xdt_anchor_card_id: 'c' } });
    expect(media(result).map((m) => m.kind)).toEqual(['image', 'video']);
    expect(cards(result)).toEqual(['c']);
    expect(media(JSON.stringify({ arbitrary: { xdt_image_url: blob('png') } }))).toEqual([]);
  });
  it('respects suppression in either envelope and never revives failed nested results', () => {
    for (const result of [
      { ok: true, _xdt_render_image: false, result: { xdt_image_url: blob('png') } },
      { ok: true, result: { _xdt_render_image: false }, xdt_media_produced: [blob('png')] },
      { ok: false, result: { xdt_image_url: blob('png') } },
    ]) expect(media(JSON.stringify(result))).toEqual([]);
  });
  it('retains managed file and model entries without inventing arbitrary local-path access', () => {
    const result = JSON.stringify({ ok: true, result: { _xdt_model_files: [{ url: blob('glb'), name: 'scene.glb' }, { url: 'file:///secret' }], note: 'Saved xdt-file://open?path=%2Ftmp%2Freport.pdf' } });
    expect(files(result)).toEqual([{ url: blob('glb'), title: 'scene.glb' }, { url: 'xdt-file://open?path=%2Ftmp%2Freport.pdf', title: 'report.pdf' }]);
    expect(files('Saved xdt-file://open?path=%2Ftmp%2Freport.pdf')[0].title).toBe('report.pdf');
    expect(hasVisibleHistoryResult(JSON.stringify({ ok: true, result: { xdt_card_id: 'c' } }))).toBe(true);
  });
  it('ignores quoted protocol URLs when a tool prints source code or test fixtures', () => {
    const source = [
      "const urls = ['xdt-file://open?path=%2Ftmp%2Freport.pdf', 'xdt-file://open?path=%2Ftmp%2Findex.html'];",
      "const template = `xdt-file://open?path=${encodeURIComponent(absPath)}`;",
    ].join('\n');
    expect(files(source)).toEqual([]);
    expect(files('Saved xdt-file://open?path=%2Ftmp%2Freport.pdf')).toEqual([
      { url: 'xdt-file://open?path=%2Ftmp%2Freport.pdf', title: 'report.pdf' },
    ]);
  });
  it.each([
    ['xdt-file:///tmp/report.pdf', 'report.pdf'],
    ['xdt-file:///C:/reports/report.pdf', 'report.pdf'],
    ['xdt-file:///tmp/report%20final.pdf', 'report final.pdf'],
    ['xdt-file://open?path=%2Ftmp%2Freport.pdf', 'report.pdf'],
    ['xdt-file://local/?path=C%3A%5Creports%5Creport.pdf', 'report.pdf'],
  ])('retains absolute file references in both supported URL forms: %s', (url, title) => {
    expect(files(`Saved [report](${url})`)).toEqual([{ url, title }]);
    expect(files(JSON.stringify({ _xdt_model_files: [{ url, name: title }] }))).toEqual([{ url, title }]);
    expect(files(JSON.stringify({ xdt_media_produced: [url] }))).toEqual([{ url, title }]);
  });
  it.each(['note', 'text', 'output'])('ignores source literals inside JSON %s while retaining real links', (field) => {
    const source = [
      "const a = 'xdt-file://open?path=%2Ftmp%2Ffixture.pdf';",
      'const b = "xdt-file:///tmp/fixture.html";',
      'const c = `xdt-file://open?path=${encodeURIComponent(absPath)}`;',
    ].join('\n');
    const url = 'xdt-file://open?path=%2Ftmp%2Factual.pdf';
    for (const wrap of [
      (text: string) => ({ [field]: text }),
      (text: string) => ({ ok: true, result: { [field]: text } }),
      (text: string) => ({ content: [{ type: 'text', text }] }),
    ]) {
      expect(files(JSON.stringify(wrap(source)))).toEqual([]);
      expect(files(JSON.stringify(wrap(`${source}\nSaved ${url}`)))).toEqual([{ url, title: 'actual.pdf' }]);
    }
  });
  it('keeps explicit file declarations when neighboring JSON text contains source examples', () => {
    const url = 'xdt-file:///tmp/report.pdf';
    expect(files(JSON.stringify({ ok: true, result: {
      _xdt_model_files: [{ url, name: 'Report' }],
      text: `const example = '${url}';`,
    } }))).toEqual([{ url, title: 'Report' }]);
  });
  it.each([
    'xdt-file://report.pdf',
    'xdt-file://open?path=relative%2Freport.pdf',
    'xdt-file://open?path=${encodeURIComponent(absPath)}',
    'xdt-file://open?path=',
  ])('rejects incomplete or non-absolute file references: %s', (url) => {
    expect(files(`Saved ${url}`)).toEqual([]);
    expect(files(JSON.stringify({ _xdt_model_files: [{ url }] }))).toEqual([]);
  });
});
