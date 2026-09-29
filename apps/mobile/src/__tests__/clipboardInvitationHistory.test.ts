import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ values: new Map<string, string>(), getItem: vi.fn(), setItem: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));
import { __testing, hasSeenClipboardInvitation, invitationDigest, rememberClipboardInvitation } from '@/device-link/clipboardInvitationHistory';

const account = '["global","guest"]';
const key = __testing.storageKey(account);
const token = 'A'.repeat(43);
const digest = invitationDigest(token);
const day = 24 * 60 * 60_000;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-29T00:00:00Z'));
  __testing.reset(); storage.values.clear();
  storage.getItem.mockReset().mockImplementation(async (k: string) => storage.values.get(k) ?? null);
  storage.setItem.mockReset().mockImplementation(async (k: string, value: string) => { storage.values.set(k, value); });
});
afterEach(async () => { await __testing.flush(); vi.useRealTimers(); });

it('stores only SHA-256 digests and timestamps and reloads them after losing all memory', async () => {
  await rememberClipboardInvitation(account, digest);
  const raw = storage.values.get(key)!;
  expect(raw).not.toContain(token);
  expect(JSON.parse(raw)).toEqual({ version: 1, entries: [{ digest, seenAt: Date.now() }] });
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  __testing.reset();
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(true);
  expect(await hasSeenClipboardInvitation('["cn","guest"]', digest)).toBe(false);
});

it('expires records at 30 days without extending TTL on reads', async () => {
  await rememberClipboardInvitation(account, digest);
  vi.setSystemTime(Date.now() + 29 * day);
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(true);
  vi.setSystemTime(Date.now() + day);
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(false);
  __testing.reset();
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(false);
  await rememberClipboardInvitation(account, invitationDigest('new'));
  expect(JSON.parse(storage.values.get(key)!).entries).toHaveLength(1);
});

it('keeps only the most recent 16 distinct invitations in memory and on disk', async () => {
  for (let i = 0; i < 17; i++) {
    vi.setSystemTime(Date.now() + 1);
    await rememberClipboardInvitation(account, invitationDigest(String(i)));
  }
  expect(await hasSeenClipboardInvitation(account, invitationDigest('0'))).toBe(false);
  expect(JSON.parse(storage.values.get(key)!).entries).toHaveLength(16);
  __testing.reset();
  expect(await hasSeenClipboardInvitation(account, invitationDigest('0'))).toBe(false);
  expect(await hasSeenClipboardInvitation(account, invitationDigest('16'))).toBe(true);
});

it('merges concurrent discoveries with a delayed disk read and serializes writes', async () => {
  const saved = invitationDigest('saved');
  let finish!: (raw: string) => void;
  storage.getItem.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let releaseWrite!: () => void;
  storage.setItem.mockImplementationOnce(async (k: string, value: string) => {
    await new Promise<void>(resolve => { releaseWrite = resolve; });
    storage.values.set(k, value);
  });
  const first = rememberClipboardInvitation(account, digest);
  await vi.waitFor(() => expect(storage.getItem).toHaveBeenCalledTimes(1));
  const secondDigest = invitationDigest('second');
  const second = rememberClipboardInvitation(account, secondDigest);
  finish(JSON.stringify({ version: 1, entries: [{ digest: saved, seenAt: Date.now() - 1 }] }));
  await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledTimes(1));
  const thirdDigest = invitationDigest('third');
  const third = rememberClipboardInvitation(account, thirdDigest);
  await Promise.resolve();
  expect(storage.setItem).toHaveBeenCalledTimes(1);
  releaseWrite(); await Promise.all([first, second, third]);
  __testing.reset();
  for (const item of [saved, digest, secondDigest, thirdDigest]) {
    expect(await hasSeenClipboardInvitation(account, item)).toBe(true);
  }
});

it('does not overwrite unread disk data and merges it after a read retry', async () => {
  const saved = invitationDigest('saved');
  const original = JSON.stringify({ version: 1, entries: [{ digest: saved, seenAt: Date.now() - 1 }] });
  storage.values.set(key, original);
  storage.getItem.mockRejectedValueOnce(new Error('unavailable'));
  await rememberClipboardInvitation(account, digest);
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(storage.values.get(key)).toBe(original);
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(true);
  await rememberClipboardInvitation(account, invitationDigest('new'));
  __testing.reset();
  expect(await hasSeenClipboardInvitation(account, saved)).toBe(true);
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(true);
});

it('keeps failed writes in memory and allows later writes to recover', async () => {
  storage.setItem.mockRejectedValueOnce(new Error('unavailable'));
  await rememberClipboardInvitation(account, digest);
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(true);
  await rememberClipboardInvitation(account, invitationDigest('new'));
  __testing.reset();
  expect(await hasSeenClipboardInvitation(account, digest)).toBe(true);
});

it.each(['broken json', 'null', '{"version":1,"entries":[null,{}, {"digest":"plaintext","seenAt":0}]}'])(
  'ignores corrupt records: %s', async raw => {
    storage.values.set(key, raw);
    expect(await hasSeenClipboardInvitation(account, digest)).toBe(false);
    await rememberClipboardInvitation(account, digest);
    expect(JSON.parse(storage.values.get(key)!).entries).toEqual([{ digest, seenAt: Date.now() }]);
  },
);

it('never stores an invitation before an account is known', async () => {
  await rememberClipboardInvitation('', digest);
  expect(await hasSeenClipboardInvitation('', digest)).toBe(false);
  expect(storage.getItem).not.toHaveBeenCalled();
  expect(storage.setItem).not.toHaveBeenCalled();
});
