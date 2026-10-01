// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WallpaperVideo } from '../WallpaperVideo';
import { HIDDEN_ANIMATION_ATTR } from '@/lib/hiddenAnimationGate';

const state = vi.hoisted(() => ({ reduced: false, tier: 'standard' }));
const ensureVideo = vi.fn();
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => state.reduced }));
vi.mock('@/hooks/useWallpaperVideoTier', () => ({ useWallpaperVideoTier: () => state.tier }));
vi.mock('@/lib/wallpaper', () => ({
  getWallpaperVideo: (id: string, tier = 'standard') =>
    (id.startsWith('cindy-') ? `/${id}${tier === 'hd' ? '-hd' : ''}.mp4` : undefined),
}));

describe('dynamic wallpaper lifecycle', () => {
  beforeEach(() => {
    state.reduced = false;
    state.tier = 'standard';
    ensureVideo.mockReset().mockResolvedValue('/cindy-window-hd.mp4');
    vi.stubGlobal('electronAPI', { appearanceSettings: { ensureWallpaperVideo: ensureVideo } });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute(HIDDEN_ANIMATION_ATTR);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('does not create a decoder for static, reduced motion or unsupported artwork', () => {
    const { rerender } = render(<WallpaperVideo wallpaperId="cindy-window" motion="static" />);
    expect(document.querySelector('video')).toBeNull();
    rerender(<WallpaperVideo wallpaperId="none" motion="dynamic" />);
    expect(document.querySelector('video')).toBeNull();
    state.reduced = true;
    rerender(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    expect(document.querySelector('video')).toBeNull();
    expect(ensureVideo).not.toHaveBeenCalled();
  });
  it('shows only decoded frames, pauses with the shared hidden gate, and releases on static', async () => {
    const { rerender } = render(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    const video = document.querySelector('video')!;
    expect(video.muted && video.loop).toBe(true);
    expect(document.documentElement.dataset.wallpaperMotion).toBeUndefined();
    fireEvent.playing(video);
    expect(document.documentElement.dataset.wallpaperMotion).toBe('dynamic');
    await act(async () => document.documentElement.setAttribute(HIDDEN_ANIMATION_ATTR, 'true'));
    expect(video.pause).toHaveBeenCalled();
    await act(async () => document.documentElement.removeAttribute(HIDDEN_ANIMATION_ATTR));
    expect(video.play).toHaveBeenCalledTimes(2);
    rerender(<WallpaperVideo wallpaperId="cindy-window" motion="static" />);
    expect(document.querySelector('video')).toBeNull();
    expect(video.getAttribute('src')).toBeNull();
    expect(video.load).toHaveBeenCalled();
    expect(document.documentElement.dataset.wallpaperMotion).toBeUndefined();
  });
  it('keeps the still fallback when decode or playback fails', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error('decode failed'));
    render(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    await waitFor(() => expect(document.querySelector('video')).toBeNull());
    expect(document.documentElement.dataset.wallpaperMotion).toBeUndefined();
  });
  it('switches scenes without retaining a second decoder', () => {
    const { rerender } = render(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    const old = document.querySelector('video')!;
    fireEvent.playing(old);
    rerender(<WallpaperVideo wallpaperId="cindy-dream" motion="dynamic" />);
    expect(document.querySelectorAll('video')).toHaveLength(1);
    expect(old.getAttribute('src')).toBeNull();
    expect(document.documentElement.dataset.wallpaperMotion).toBeUndefined();
  });
  it('releases the previous tier and keeps the still visible until the new video plays', async () => {
    const { rerender } = render(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    const standard = document.querySelector('video')!;
    fireEvent.playing(standard);
    state.tier = 'hd';
    rerender(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    await waitFor(() => expect(document.querySelector('video')!.src).toContain('-hd.mp4'));
    const hd = document.querySelector('video')!;
    expect(hd.src).toContain('cindy-window-hd.mp4');
    expect(document.querySelectorAll('video')).toHaveLength(1);
    expect(standard.getAttribute('src')).toBeNull();
    expect(document.documentElement.dataset.wallpaperMotion).toBeUndefined();
    fireEvent.playing(hd);
    expect(document.documentElement.dataset.wallpaperMotion).toBe('dynamic');
    state.tier = 'standard';
    rerender(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    expect(hd.getAttribute('src')).toBeNull();
    expect(document.querySelector('video')!.src).not.toContain('-hd');
  });
  it.each(['error', 'rejection'])('falls back from HD once on %s, then to a still if standard fails', async (failure) => {
    state.tier = 'hd';
    ensureVideo.mockImplementation(async () => {
      if (failure === 'rejection')
        vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error('unsupported HD'));
      return '/cindy-dream-hd.mp4';
    });
    const { rerender } = render(<WallpaperVideo wallpaperId="cindy-dream" motion="dynamic" />);
    if (failure === 'error') {
      await waitFor(() => expect(document.querySelector('video')!.src).toContain('-hd.mp4'));
      fireEvent.error(document.querySelector('video')!);
    }
    await act(async () => {});
    await waitFor(() => expect(document.querySelector('video')!.src).toContain('/cindy-dream.mp4'));
    const standard = document.querySelector('video')!;
    state.tier = 'standard';
    rerender(<WallpaperVideo wallpaperId="cindy-dream" motion="dynamic" />);
    state.tier = 'hd';
    rerender(<WallpaperVideo wallpaperId="cindy-dream" motion="dynamic" />);
    expect(document.querySelector('video')).toBe(standard);
    fireEvent.error(standard);
    expect(document.querySelector('video')).toBeNull();
    expect(document.documentElement.dataset.wallpaperMotion).toBeUndefined();
  });
  it.each(['missing', 'offline'])('keeps playing standard when CDN is %s', async (reason) => {
    state.tier = 'hd';
    if (reason === 'missing') ensureVideo.mockResolvedValue(null);
    else ensureVideo.mockRejectedValue(new Error('offline'));
    render(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    const standard = document.querySelector('video');
    await act(async () => {});
    expect(document.querySelector('video')).toBe(standard);
    expect(ensureVideo).toHaveBeenCalledOnce();
  });
  it('ignores a completed download after switching to static or another scene', async () => {
    state.tier = 'hd';
    let finish!: (url: string) => void;
    ensureVideo.mockReturnValue(new Promise<string>(resolve => { finish = resolve; }));
    const { rerender } = render(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    rerender(<WallpaperVideo wallpaperId="cindy-window" motion="static" />);
    await act(async () => finish('/old-hd.mp4'));
    expect(document.querySelector('video')).toBeNull();
    ensureVideo.mockResolvedValue(null);
    rerender(<WallpaperVideo wallpaperId="cindy-dream" motion="dynamic" />);
    await act(async () => {});
    expect(document.querySelector('video')!.src).toContain('/cindy-dream.mp4');
  });
});
