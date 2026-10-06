const MANAGED_MEDIA_SCHEME_RE = /^(?:cindy-media|xdt-video|cindy-remote-media):\/\//i;
const VIDEO_EXTENSION_RE = /\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i;

/**
 * Markdown image syntax is also used by generated-media replies. Keep the
 * video upgrade limited to Cindy-managed media so an arbitrary remote image
 * URL cannot silently become an autoplay-capable video surface.
 */
export function isManagedMarkdownVideoUrl(src: string | undefined): src is string {
  return Boolean(src && MANAGED_MEDIA_SCHEME_RE.test(src) && VIDEO_EXTENSION_RE.test(src));
}

/** Use the alt text for the preview label, with the managed URL as fallback. */
export function markdownMediaFilename(src: string, alt?: string): string {
  const label = alt?.trim();
  if (label) return label;

  try {
    const pathname = new URL(src).pathname;
    const filename = decodeURIComponent(pathname.split('/').pop() ?? '').trim();
    if (filename) return filename;
  } catch {
    // Keep the stable fallback below for malformed or legacy media URLs.
  }
  return 'video';
}
