import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ upload: vi.fn(async () => []), download: vi.fn(), packaged: true, urls: [] as string[], wsUrls: [] as string[], exists: vi.fn(), config: '', handle: vi.fn(), profiles: [] as unknown[], sockets: [] as import('ws').WebSocket[] }));
vi.mock('../../authManager.js', () => ({ getAccessToken: () => 'isolated-test-token', refresh: vi.fn(async () => true) }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://chat.cindy.app' }));
vi.mock('../chatServerMedia.js', () => ({ createChatMedia: () => ({ upload: fixture.upload, download: fixture.download }) }));
vi.mock('../chatServerWorkspaces.js', () => ({ chatServerWorkspaces: () => ({ read: () => null, save: vi.fn() }) }));
vi.mock('../chatMigrationReceipts.js', () => ({ chatMigrationReceipts: () => ({ read: () => null, save: vi.fn() }) }));
vi.mock('electron', () => ({ app: { get isPackaged() { return fixture.packaged; }, getPath: () => '/isolated' } }));
vi.mock('node:fs', () => ({ existsSync: fixture.exists, readFileSync: () => fixture.config || '{"baseUrl":"https://example.com","token":"test"}' }));
vi.mock('../botGroupChatService.js', () => ({ readPersistedReplyText: vi.fn() }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: {
  select: () => ({ from: () => ({ where: () => Object.assign(Promise.resolve(fixture.profiles), { limit: async () => [{ id: 'existing-local-group' }] }) }) }),
  insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
} }) }));
vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events');
  return { request: (url: string, options: { method: string }, callback: (response: unknown) => void) => {
    fixture.urls.push(String(url));
    const req = Object.assign(new EventEmitter(), {
      end: (data?: string) => {
        void Promise.resolve().then(() => fixture.handle(new URL(url).pathname.slice(3) + new URL(url).search, options.method, data ? JSON.parse(data) : undefined))
          .then(result => {
            const response = Object.assign(new EventEmitter(), { statusCode: result?.status ?? 200 });
            callback(response);
            response.emit('data', Buffer.from(JSON.stringify(result?.body ?? {})));
            response.emit('end');
          }, error => req.emit('error', error));
      },
      destroy: (error: Error) => req.emit('error', error),
    });
    return req;
  } };
});
vi.mock('node:https', async () => ({ request: (await import('node:http')).request }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    static OPEN = 1; readyState = 0; send = vi.fn();
    constructor(url: URL) { super(); fixture.wsUrls.push(String(url)); fixture.sockets.push(this as unknown as import('ws').WebSocket); }
    close() { this.emit('close'); }
  } };
});
import { withChatServer } from '../chatServer.js';
import type { BotGroupChatService, BotGroupChatServiceDeps } from '../botGroupChatService.js';

describe('server group feature parity', () => {
  const roomId = '10000000-0000-4000-8000-000000000001';
  const botId = '20000000-0000-4000-8000-000000000001';
  const selfId = '30000000-0000-4000-8000-000000000001';
  const execution = { id: '40000000-0000-4000-8000-000000000001', conversation_id: roomId,
    source_message_id: '50000000-0000-4000-8000-000000000001', bot_id: botId,
    context_seq: '100', epoch: 1, status: 'running', access_mode: 'chat', access_revision: 1 };
  const room = (id: string) => ({ id, name: 'Room', state: 'joined', response_mode: 'all', speaking_mode: 'auto',
    created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-03T00:00:00Z', revision: 1, archived: false });
  let service: BotGroupChatService;
  let deps: BotGroupChatServiceDeps;
  let claimed = false;
  function response(route: string) {
    if (route === '/me') return { body: { actor: { id: selfId } } };
    if (route === '/actors') return { body: [{ id: botId, kind: 'bot', externalId: 'local-bot', name: 'Bot' }] };
    if (route === '/executions/claim') {
      const next = claimed ? null : execution; claimed = true;
      return { body: { execution: next } };
    }
    if (route.endsWith('/snapshot')) return { body: { room: room(route.split('/')[2]), members: [], messages: [], cursor: '1' } };
    if (route.includes('/messages?') || route.endsWith('/executions') || route.includes('/plans')) return { body: [] };
    return { body: {} };
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-03T00:00:00Z'));
    fixture.packaged = false; fixture.exists.mockReturnValue(true); fixture.profiles = []; fixture.sockets = []; claimed = false;
    fixture.config = '{"baseUrl":"http://127.0.0.1:3018","auth":"cindy"}';
    vi.stubEnv('XDT_ISOLATED', '1');
    fixture.handle.mockImplementation(response);
    deps = { ensureLane: vi.fn(async () => ({ ok: true, sessionId: 'lane' })), abortLane: vi.fn(async () => {}),
      dispatch: vi.fn(async (input: Parameters<BotGroupChatServiceDeps['dispatch']>[0]) => { await input.onAccepted?.(); return { ok: true }; }),
      onChanged: vi.fn(),
    } as unknown as BotGroupChatServiceDeps;
    service = withChatServer({ listGroups: vi.fn(async () => ({ ok: true, groups: [] })), settleLaneTurn: vi.fn(async () => false), dispose: vi.fn() } as unknown as BotGroupChatService, deps);
  });
  afterEach(() => { service.dispose(); vi.useRealTimers(); vi.unstubAllEnvs(); fixture.config = ''; vi.clearAllMocks(); });
  const secondBotId = '20000000-0000-4000-8000-000000000002';
  const planId = '70000000-0000-4000-8000-000000000001';
  const members = [botId, secondBotId].map(id => ({ id, kind: 'bot', name: id === botId ? 'Bot' : 'Peer',
    state: 'joined', role: 'member', ownerActorId: selfId, ownerName: 'Me', guestAccess: 'chat' }));
  const steps = members.map((m, position) => ({ position, botId: m.id, botName: m.name, task: 'Make a draft', status: 'pending' }));
  const proposed = { id: planId, revision: 1, source_message_id: execution.source_message_id, request_text: 'Make a draft',
    organizer_id: botId, creator_id: selfId, status: 'proposed', current_step: null, steps,
    created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-03T00:00:00Z' };
  const send = (overrides = {}) => service.sendMessage({ groupId: roomId, text: 'Make a draft', clientId: 'parity:message:1',
    mentions: { all: false, botIds: [] }, ...overrides });
  const planPosts = () => fixture.handle.mock.calls.filter(([route, method]) => route === `/conversations/${roomId}/plans` && method === 'POST');
  function arrange(plan?: typeof proposed, roomMembers = members) {
    deps.decidePlan = vi.fn(async () => ({ needsPlan: true, steps: steps.map(({ botId, task }) => ({ botId, task })) }));
    fixture.handle.mockImplementation((route, method) => {
      if (route.endsWith('/snapshot')) return { body: { room: room(roomId), members: roomMembers, messages: [], cursor: '1' } };
      if (route.endsWith('/members')) return { body: roomMembers };
      if (route.includes('/plans') && method === 'GET') return { body: plan ? [plan] : [] };
      if (route.endsWith('/messages') && method === 'POST') return { body: { id: execution.source_message_id } };
      return response(route);
    });
  }
  async function flush() { await vi.advanceTimersByTimeAsync(0); }
  it.each([
    ['ordinary request', {}, undefined],
    ['@all', { mentions: { all: true, botIds: [] } }, undefined],
    ['one available member', {}, members.slice(0, 1)],
  ])('asks the organizer for %s without changing server mentions', async (_name, input, roster) => {
    arrange(undefined, roster);
    expect((await send(input)).ok).toBe(true); await flush();
    expect(deps.decidePlan).toHaveBeenCalledWith(expect.objectContaining({ mode: 'auto' }), expect.any(AbortSignal));
    expect(planPosts()).toHaveLength(1);
    const posted = fixture.handle.mock.calls.find(([route, method]) => route.endsWith('/messages') && method === 'POST')![2];
    expect(posted.deferExecution).toBe(true);
    expect(posted.mentions).toEqual(_name === '@all' ? [botId, secondBotId] : []);
  });
  it.each([false, true])('revises a proposed plan, including forced=%s, without losing its steps', async division => {
    arrange(proposed);
    expect((await send({ division })).ok).toBe(true); await flush();
    expect(deps.decidePlan).toHaveBeenCalledWith(expect.objectContaining({ mode: 'revise', currentSteps: steps }), expect.any(AbortSignal));
    expect(planPosts()).toHaveLength(1);
  });
  it('does not replace another person’s proposed plan or auto-plan around an active plan', async () => {
    for (const plan of [{ ...proposed, creator_id: 'someone-else' }, { ...proposed, status: 'running' }]) {
      arrange(plan);
      expect((await send()).ok).toBe(true); await flush();
      expect(deps.decidePlan).not.toHaveBeenCalled();
      expect((await send({ division: true })).ok).toBe(false);
    }
    expect(planPosts()).toHaveLength(0);
  });
  it.each(['mention', 'stop', 'dismiss', 'start', 'edit'])('invalidates a pending decision on %s', async action => {
    arrange(proposed);
    let finish!: (value: { needsPlan: true; steps: typeof steps }) => void;
    deps.decidePlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    await send(); await flush();
    const signal = vi.mocked(deps.decidePlan).mock.calls[0][1];
    if (action === 'mention') await send({ clientId: 'parity:message:2', mentions: { all: false, botIds: [botId] } });
    else if (action === 'stop') await service.stopRound(roomId);
    else if (action === 'dismiss') await service.dismissPlan({ groupId: roomId, planId });
    else if (action === 'start') await service.startPlan({ groupId: roomId, planId });
    else await service.editPlanStep({ groupId: roomId, planId, position: 0, action: 'reassign', botId });
    expect(signal.aborted).toBe(true);
    finish({ needsPlan: true, steps }); await flush();
    expect(planPosts()).toHaveLength(0);
    const view = await service.getGroup(roomId);
    expect(view.ok && view.group.planningBotId).toBeNull();
  });
  it('keeps @all on an existing proposal as discussion, not a revision', async () => {
    arrange(proposed);
    await send({ mentions: { all: true, botIds: [] } }); await flush();
    expect(deps.decidePlan).not.toHaveBeenCalled();
    expect(planPosts()).toHaveLength(0);
  });
  it('does not resurrect planning when a cancelled send gets a late upload receipt', async () => {
    arrange();
    let finishUpload!: () => void;
    fixture.upload.mockImplementationOnce(() => new Promise(resolve => { finishUpload = () => resolve([]); }));
    const first = send(); await flush();
    await service.stopRound(roomId);
    finishUpload(); expect((await first).ok).toBe(true); await flush();
    expect(deps.decidePlan).not.toHaveBeenCalled();
    expect(planPosts()).toHaveLength(0);
  });
  it('delivers up to forty ordinary discussion attachments and preserves the silent reply option', async () => {
    arrange();
    fixture.profiles = [{ id: 'local-bot', displayName: 'Bot', avatar: null, status: 'active' }];
    const messages = Array.from({ length: 45 }, (_, n) => ({ id: `message-${n}`, seq: String(n + 1), authorId: selfId,
      author: { kind: 'human', name: 'Me' }, deleted: false, threadRootId: null,
      content: [{ type: 'media', mediaId: `60000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`, caption: `file-${n}` }] })).reverse();
    fixture.download.mockImplementation(async (_room, id) => ({ id, name: id, category: 'file', path: '/test/file', url: null }));
    const base = fixture.handle.getMockImplementation()!;
    fixture.handle.mockImplementation((route, ...args) => route.includes('/messages?') ? { body: messages } : base(route, ...args));
    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.dispatch).toHaveBeenCalledOnce();
    const input = vi.mocked(deps.dispatch).mock.calls[0][0];
    expect(input.attachments).toHaveLength(40);
    expect(input.message).toContain('NO_REPLY');
    expect(input.message).toContain('attachment limit');
    expect(input.message).toContain('file-0');
    expect(input.attachments![0].id).toBe(messages[0].content[0].mediaId);
  });
});
