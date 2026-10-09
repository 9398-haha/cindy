// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  auth: { user: { id: 'owner' }, accountGeneration: 1, apiFetch: vi.fn(), getAccessToken: vi.fn(async () => 'fixture') },
  link: { status: 'offline', connectionEpoch: 1, presenceVersion: 1, invoke: vi.fn(), openLink: vi.fn(),
    getPresenceAvailability: () => false, onRemoteResourceChanged: () => () => {}, subscribe: vi.fn(), unsubscribe: vi.fn() },
  legacy: { items: [] as any[], loading: false, refreshing: false, error: null as string | null, isOnline: () => false, refresh: vi.fn() },
  targets: [] as { deviceId: string; deviceName: string }[],
  foreground: new Set<(state: string) => void>(),
}));
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: (_: string, fn: (state: string) => void) => { h.foreground.add(fn); return { remove: () => h.foreground.delete(fn) }; } } }));
vi.mock('expo-router', async () => { const { useEffect } = await import('react'); return { useFocusEffect: (fn: any) => useEffect(fn, [fn]) }; });
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/config/env', () => ({ getActiveMobileSessionRealm: () => 'global', getMobileEndpointForRealm: () => 'https://chat.example.invalid' }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/device-link/revokedDevicesStore', () => ({ useRevokedDevices: () => new Set() }));
vi.mock('@/session/useRemoteResourceList', () => ({ useRemoteResourceList: () => h.legacy }));
vi.mock('@/device-link/remoteStatus', () => ({ formatRemoteError: String }));
import { useBotGroupChat } from '@/session/useBotGroupChat';
import { useBotGroupRoster } from '@/session/useBotGroupRoster';
import { botGroupRoute } from '@/session/botGroupNavigation';
const id = '00000000-0000-4000-8000-000000000001';
const self = '00000000-0000-4000-8000-000000000002';
const room = { id, name: 'Discussion', kind: 'group', state: 'joined', revision: 1, archived: false,
  created_at: '2026-10-01', updated_at: '2026-10-09', response_mode: 'all', speaking_mode: 'auto' };
const host = { deviceId: '', deviceName: '' };
let root: Root | undefined;
let roster: ReturnType<typeof useBotGroupRoster>;
let chat: ReturnType<typeof useBotGroupChat>;
let showChat = false;
function Probe() { roster = useBotGroupRoster(h.targets, !showChat); chat = useBotGroupChat(host, showChat ? id : ''); return null; }
async function render() { root ??= createRoot(document.createElement('div')); await act(async () => root!.render(createElement(Probe))); }
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => {
  vi.clearAllMocks(); h.foreground.clear(); showChat = false; h.auth.accountGeneration = 1; h.legacy.items = []; h.targets = [];
  vi.stubGlobal('WebSocket', class { close() {} });
  h.auth.apiFetch.mockImplementation(async (path: string, options: any) => {
    options.assertCurrent();
    if (path.startsWith('/v1/conversations?')) return [room];
    if (path === '/v1/me') return { actor: { id: self } };
    if (path.endsWith('/snapshot')) return { room, members: [{ id: self, kind: 'human', state: 'joined', name: 'Me', ownerActorId: self, ownerName: '', role: 'member', avatar: null }], messages: [], cursor: '1' };
    if (path.includes('/messages?')) return [{ id: self, seq: '9007199254740993', authorId: self, author: { kind: 'human', name: 'Me' }, content: [{ type: 'text', text: 'Fixture message' }], createdAt: '2026-10-09', deleted: false, threadRootId: null }];
    if (path.endsWith('/messages')) return { id: self };
    throw new Error('Unexpected request');
  });
});
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.unstubAllGlobals(); });
it('lists and opens an existing joined server group with all computers and the relay offline', async () => {
  await render();
  expect(roster.items).toHaveLength(1);
  expect(botGroupRoute(roster.items[0].host, id)).toEqual({ pathname: '/companions/groups/[groupId]', params: { groupId: id } });
  showChat = true; await render();
  expect(chat.state).toMatchObject({ kind: 'ready', group: { id, messages: [{ content: 'Fixture message' }] } });
  expect(chat.online).toBe(true);
  expect(h.link.invoke).not.toHaveBeenCalled(); expect(h.link.openLink).not.toHaveBeenCalled();
  expect(h.auth.apiFetch.mock.calls.every(([, options]) => options.baseUrl === 'https://chat.example.invalid')).toBe(true);
  await act(async () => { await chat.act('send', { text: 'hello', clientId: 'fixture-operation', mentions: { all: false, botIds: [] } }); });
  expect(h.auth.apiFetch).toHaveBeenCalledWith(`/v1/conversations/${id}/messages`, expect.objectContaining({ method: 'POST', body: { operationId: 'fixture-operation', content: [{ type: 'text', text: 'hello' }], mentions: [] } }));
});
it('deduplicates server copies from multiple computers while retaining a local legacy group', async () => {
  h.legacy.items = ['mac', 'pc'].map(deviceId => ({ key: deviceId, host: { deviceId, deviceName: deviceId }, item: { ref: { collectionId: 'bot-groups', kind: 'bot-group', id }, revision: '1', display: { title: 'Discussion' }, links: [] } }));
  h.targets = ['mac', 'pc'].map(deviceId => ({ deviceId, deviceName: deviceId }));
  h.legacy.items.push({ ...h.legacy.items[0], key: 'local', item: { ...h.legacy.items[0].item, ref: { collectionId: 'bot-groups', kind: 'bot-group', id: 'old-local-group' } } });
  await render(); expect(roster.items.map(row => row.item.ref.id)).toEqual([id, 'old-local-group']);
  expect(roster.items[0].host.deviceId).toBe('');
  h.auth.apiFetch.mockImplementation(async path => path === '/v1/me' ? { actor: { id: self } } : []);
  await act(async () => { await roster.refresh(); });
  expect(roster.items.map(row => row.item.ref.id)).toEqual(['old-local-group']);
});
it('clears removed membership, exposes first-read failures and recovers on foreground', async () => {
  showChat = true; h.auth.apiFetch.mockRejectedValue(new Error('offline'));
  await render(); expect(chat.state.kind).toBe('error');
  h.auth.apiFetch.mockImplementation(async path => path === '/v1/me' ? { actor: { id: self } } : path.endsWith('/snapshot') ? { room, members: [], messages: [], cursor: '1' } : []);
  await act(async () => h.foreground.forEach(fn => fn('active')));
  expect(chat.state.kind).toBe('ready');
  h.auth.apiFetch.mockRejectedValue(Object.assign(new Error('NOT_MEMBER'), { status: 403 }));
  await act(async () => { chat.reload(); }); expect(chat.state.kind).toBe('missing');
});
it('ignores an old account response after switching accounts', async () => {
  let finish!: (value: unknown) => void;
  h.auth.apiFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render(); h.auth.accountGeneration++; h.auth.apiFetch.mockResolvedValue([]); await render();
  await act(async () => finish([room])); expect(roster.items).toEqual([]);
});
