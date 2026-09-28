// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { useClipboardSharedTaskInvitation } from '@/device-link/useClipboardSharedTaskInvitation';
import { clearSharedTaskInvitationIntent, getPendingSharedTaskInvitationIntent, receiveSharedTaskInvitationIntent } from '@/device-link/sharedTaskInvitationIntent';

const h = vi.hoisted(() => ({ read: vi.fn(), state: 'active', listener: null as null | ((state: string) => void) }));
vi.mock('expo-clipboard', () => ({ getStringAsync: h.read }));
vi.mock('@/config/env', () => ({ DEVICE_LINK_API_BASE_URL: 'https://relay.example.test' }));
vi.mock('react-native', () => ({ AppState: {
  get currentState() { return h.state; },
  addEventListener: (_event: string, listener: (state: string) => void) => {
    h.listener = listener; return { remove: () => { if (h.listener === listener) h.listener = null; } };
  },
} }));
const token = 'A'.repeat(43);
const link = 'https://relay.example.test/shared-task/join#' + token;
let root: Root;
function Harness({ enabled, joining }: { enabled: boolean; joining: boolean }) {
  useClipboardSharedTaskInvitation(enabled, joining); return null;
}
async function render(enabled = true, joining = false) {
  await act(async () => root.render(createElement(Harness, { enabled, joining })));
}
async function state(next: string) { await act(async () => { h.state = next; h.listener?.(next); }); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); h.read.mockReset(); h.read.mockResolvedValue(link); h.state = 'active';
  clearSharedTaskInvitationIntent(); setMobileAuthOwner('guest');
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => root.unmount()); clearSharedTaskInvitationIntent(); vi.useRealTimers(); });

it('reads on startup and identifies the invitation as clipboard admission', async () => {
  await render();
  expect(h.read).toHaveBeenCalledTimes(1);
  expect(getPendingSharedTaskInvitationIntent()).toMatchObject({ invitation: token, source: 'clipboard' });
});
it('reads on foreground, deduplicates consumed links, and detects a newly copied link', async () => {
  await render(); clearSharedTaskInvitationIntent();
  await state('background'); await state('active');
  expect(getPendingSharedTaskInvitationIntent()).toBeNull();
  h.read.mockResolvedValue(link.replace(token, 'B'.repeat(43)));
  await state('background'); await state('active');
  expect(getPendingSharedTaskInvitationIntent()?.invitation).toBe('B'.repeat(43));
  clearSharedTaskInvitationIntent(); h.read.mockResolvedValue(link);
  await state('background'); await state('active');
  expect(getPendingSharedTaskInvitationIntent()).toBeNull();
});
it.each(['hello', token, link.replace('relay.example.test', 'other.example.test'), link + '?app=unknown'])('ignores ordinary or incompatible clipboard content: %s', async text => {
  h.read.mockResolvedValue(text); await render(); expect(getPendingSharedTaskInvitationIntent()).toBeNull();
});
it('does not reread after an inactive/active permission prompt', async () => {
  await render(); clearSharedTaskInvitationIntent();
  await state('inactive'); await state('active'); expect(h.read).toHaveBeenCalledTimes(1);
});
it('waits for login and leaves an open admission form alone', async () => {
  await render(false); expect(h.read).not.toHaveBeenCalled();
  await render(true, true); expect(h.read).not.toHaveBeenCalled();
});
it.each(['account', 'manual', 'link'] as const)('discards delayed clipboard results superseded by %s', async reason => {
  let finish!: (text: string) => void;
  h.read.mockImplementation(() => new Promise(resolve => { finish = resolve; })); await render();
  if (reason === 'account') setMobileAuthOwner('another');
  if (reason === 'manual') await render(true, true);
  if (reason === 'link') {
    receiveSharedTaskInvitationIntent('cindy://shared-session?invitation=' + 'B'.repeat(43) + '&server=https%3A%2F%2Frelay.example.test');
    clearSharedTaskInvitationIntent();
  }
  await act(async () => finish(link)); expect(getPendingSharedTaskInvitationIntent()).toBeNull();
});
it('ignores clipboard denial without interrupting the app', async () => {
  h.read.mockRejectedValue(new Error('Clipboard unavailable')); await render();
  expect(getPendingSharedTaskInvitationIntent()).toBeNull();
});
