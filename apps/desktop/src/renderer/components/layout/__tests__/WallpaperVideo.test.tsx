// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WallpaperVideo } from '../WallpaperVideo';
import { HIDDEN_ANIMATION_ATTR } from '@/lib/hiddenAnimationGate';

const state = vi.hoisted(() => ({ reduced: false }));
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => state.reduced }));
vi.mock('@/lib/wallpaper', () => ({
  getWallpaperVideo: (id: string) => (id.startsWith('cindy-') ? `/${id}.mp4` : undefined),
}));

describe('dynamic wallpaper lifecycle', () => {
  beforeEach(() => {
    state.reduced = false;
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute(HIDDEN_ANIMATION_ATTR);
    vi.restoreAllMocks();
  });
  it('does not create a decoder for static, reduced motion or unsupported artwork', () => {
    const { rerender } = render(<WallpaperVideo wallpaperId="cindy-window" motion="static" />);
    expect(document.querySelector('video')).toBeNull();
    rerender(<WallpaperVideo wallpaperId="none" motion="dynamic" />);
    expect(document.querySelector('video')).toBeNull();
    state.reduced = true;
    rerender(<WallpaperVideo wallpaperId="cindy-window" motion="dynamic" />);
    expect(document.querySelector('video')).toBeNull();
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
});
