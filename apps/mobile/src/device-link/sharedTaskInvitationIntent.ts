import { useSyncExternalStore } from 'react';
import { parseSharedTaskInvitationIntent, type SharedTaskInvitationIntent } from '@cindy/device-link';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';

let pending: (SharedTaskInvitationIntent & { id: number; source: 'link' | 'clipboard' }) | null = null;
let sequence = 0;
let stopWatching: (() => void) | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

/** Memory-only intent: login can continue it, but account switching cannot inherit it. */
export function clearSharedTaskInvitationIntent(): void {
  pending = null;
  stopWatching?.(); stopWatching = undefined;
  clearTimeout(expiry); expiry = undefined;
  notify();
}

export function receiveSharedTaskInvitationIntent(url: string, source: 'link' | 'clipboard' = 'link'): boolean {
  const value = parseSharedTaskInvitationIntent(url);
  if (!value) return false;
  clearSharedTaskInvitationIntent();
  let owner = getMobileAuthOwner();
  if (owner.switching) return true;
  pending = { ...value, id: ++sequence, source };
  stopWatching = subscribeMobileAuthOwner(() => {
    const next = getMobileAuthOwner();
    if (next.switching || (owner.accountKey && !isMobileAuthOwnerCurrent(owner))) clearSharedTaskInvitationIntent();
    else if (next.accountKey) owner = next; // The first login claims an unsigned intent.
  });
  expiry = setTimeout(clearSharedTaskInvitationIntent, 15 * 60_000);
  notify();
  return true;
}

export const getPendingSharedTaskInvitationIntent = () => pending;
export const getSharedTaskInvitationIntentSequence = () => sequence;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const usePendingSharedTaskInvitationIntent = () => useSyncExternalStore(subscribe, getPendingSharedTaskInvitationIntent, getPendingSharedTaskInvitationIntent);
