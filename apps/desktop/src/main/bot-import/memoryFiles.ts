import { isUtf8 } from 'node:buffer';
import type { ImportFile } from './types.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';

/** Memory trees also contain JSON, backups and extensionless notes. Classify
 * their bytes, not their suffix; empty delivery/lock markers carry no memory. */
export function memoryFileContent(file: ImportFile): { kind: 'empty' } | { kind: 'text'; text: string } | { kind: 'attachment' } {
  if (!file.bytes.length) return { kind: 'empty' };
  if (sniffMediaMime(file.bytes)) return { kind: 'attachment' };
  // Control bytes distinguish binary formats even when all bytes happen to be
  // valid UTF-8. Keep original whitespace/BOM in the persisted text.
  if (isUtf8(file.bytes) && !file.bytes.some(byte => byte < 32 && ![9, 10, 13].includes(byte))) {
    const text = file.bytes.toString('utf8');
    return text.trim() ? { kind: 'text', text } : { kind: 'empty' };
  }
  return { kind: 'attachment' };
}
