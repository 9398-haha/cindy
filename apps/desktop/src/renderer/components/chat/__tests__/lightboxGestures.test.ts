import { describe, expect, it } from 'vitest';
import {
  LIGHTBOX_MAX_SCALE,
  LIGHTBOX_MIN_SCALE,
  LIGHTBOX_WHEEL_DELTA_CLAMP,
  LIGHTBOX_ZOOM_WHEEL_SENSITIVITY,
  clampScale,
  wheelZoomFactor,
  zoomAtPoint,
  imageLightboxWheelIntent,
} from '../lightboxGestures';

describe('lightboxGestures', () => {
  it('clamps scale to the configured bounds', () => {
    expect(clampScale(0)).toBe(LIGHTBOX_MIN_SCALE);
    expect(clampScale(1)).toBe(1);
    expect(clampScale(100)).toBe(LIGHTBOX_MAX_SCALE);
  });

  it('keeps the content point under the cursor fixed while zooming', () => {
    const viewport = { scale: 2, tx: 30, ty: -20 };
    const point = { cx: 140, cy: 80 };
    const beforeX = (point.cx - viewport.tx) / viewport.scale;
    const beforeY = (point.cy - viewport.ty) / viewport.scale;

    const next = zoomAtPoint(viewport, point, 1.4);

    expect((point.cx - next.tx) / next.scale).toBeCloseTo(beforeX, 12);
    expect((point.cy - next.ty) / next.scale).toBeCloseTo(beforeY, 12);
  });

  it('does not move translate when zoom is clamped at a scale boundary', () => {
    const viewport = { scale: LIGHTBOX_MAX_SCALE, tx: 30, ty: -20 };

    const next = zoomAtPoint(viewport, { cx: 140, cy: 80 }, 1.4);

    expect(next).toBe(viewport);
  });

  it('maps negative wheel delta to zoom in and positive delta to zoom out', () => {
    expect(wheelZoomFactor(-10)).toBeGreaterThan(1);
    expect(wheelZoomFactor(10)).toBeLessThan(1);
  });

  it('clamps large wheel deltas before applying the exponential factor', () => {
    expect(wheelZoomFactor(400)).toBeCloseTo(wheelZoomFactor(40), 12);
    expect(wheelZoomFactor(-400)).toBeCloseTo(wheelZoomFactor(-40), 12);
  });

  it('applies the exponential factor at the clamped delta boundary', () => {
    const boundary =
      LIGHTBOX_WHEEL_DELTA_CLAMP * LIGHTBOX_ZOOM_WHEEL_SENSITIVITY;
    expect(wheelZoomFactor(-LIGHTBOX_WHEEL_DELTA_CLAMP)).toBeCloseTo(
      Math.exp(boundary),
      12,
    );
    expect(wheelZoomFactor(LIGHTBOX_WHEEL_DELTA_CLAMP)).toBeCloseTo(
      Math.exp(-boundary),
      12,
    );
  });

  it('normalizes line-mode wheel deltas before clamping', () => {
    expect(wheelZoomFactor(1, 1)).toBeCloseTo(wheelZoomFactor(16), 12);
  });
});

describe('imageLightboxWheelIntent', () => {
  const wheel = (over: Partial<{ ctrlKey: boolean; metaKey: boolean; deltaX: number; deltaY: number }>) => ({
    ctrlKey: false,
    metaKey: false,
    deltaX: 0,
    deltaY: 0,
    ...over,
  });

  it('macOS: pinch (ctrl) and ⌘ + wheel zoom', () => {
    expect(imageLightboxWheelIntent(wheel({ ctrlKey: true, deltaY: -3 }), true, 1)).toBe('zoom');
    expect(imageLightboxWheelIntent(wheel({ metaKey: true, deltaY: 40 }), true, 2)).toBe('zoom');
    expect(imageLightboxWheelIntent(wheel({ ctrlKey: true, deltaX: 5 }), true, 2)).toBe('none');
  });

  it('macOS: two-finger scroll pans only while zoomed in', () => {
    expect(imageLightboxWheelIntent(wheel({ deltaY: 12 }), true, 1)).toBe('none');
    expect(imageLightboxWheelIntent(wheel({ deltaX: -8 }), true, 2)).toBe('pan');
    expect(imageLightboxWheelIntent(wheel({ deltaY: 12 }), true, 2)).toBe('pan');
    expect(imageLightboxWheelIntent(wheel({}), true, 2)).toBe('none');
  });

  it('other platforms: every vertical wheel zooms (unchanged)', () => {
    expect(imageLightboxWheelIntent(wheel({ deltaY: 100 }), false, 1)).toBe('zoom');
    expect(imageLightboxWheelIntent(wheel({ deltaY: -100 }), false, 3)).toBe('zoom');
    expect(imageLightboxWheelIntent(wheel({ ctrlKey: true, deltaY: -2 }), false, 1)).toBe('zoom');
    expect(imageLightboxWheelIntent(wheel({ deltaX: 30 }), false, 2)).toBe('none');
  });
});
