import { describe, expect, it, vi } from 'vitest';
import { CursorAgent, CURSOR_DEFAULT_MODEL, type CursorAgentDeps } from './index.js';
import { PINNED_SKILL_INVOCATION } from '../base-agent.js';
import { LIBRARY_READ_ROOT } from '../shared/library-native-read.js';
import type { AcpTransport } from '../acp/transport.js';
import type { AgentEvent } from '../../types/events.js';
import { readCursorModels } from './models.js';
import { cursorAnswers } from './questions.js';
import { createConsoleLogger } from '../../interfaces/logger.js';
import { CursorTranslator } from './translator.js';

class FakeTransport implements AcpTransport {
  lines = new Set<(line: string) => void>();
  closes = new Set<(info: { reason: string }) => void>();
  written: any[] = [];
  failClose = false;
  closeCount = 0;
  session = { sessionId: 'native-1', modes: { availableModes: [{ id: 'agent' }, { id: 'plan' }] },
    configOptions: [{ id: 'native-model-picker', category: 'model', currentValue: 'auto-native',
      options: [{ value: 'auto-native', name: 'Auto' }, { value: 'model-b', name: 'Model B' }] }] };
  held = new Set<string>(['session/prompt']);
  loadReplay = false;
  onWrite?: (message: any) => void;
  async writeLine(line: string) {
    const message = JSON.parse(line);
    this.written.push(message);
    this.onWrite?.(message);
    if (!message.method || message.id === undefined || this.held.has(message.method)) return;
    let result: unknown = {};
    if (message.method === 'initialize') result = { protocolVersion: 1,
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } }, authMethods: [{ id: 'cursor_login' }] };
    if (message.method === 'session/new' || message.method === 'session/load') {
      if (message.method === 'session/load' && this.loadReplay) this.update('agent_message_chunk', { content: { type: 'text', text: 'old' } });
      result = this.session;
    }
    queueMicrotask(() => this.emit({ jsonrpc: '2.0', id: message.id, result }));
  }
  emit(message: unknown) { for (const listener of this.lines) listener(JSON.stringify(message)); }
  update(sessionUpdate: string, data = {}) { this.emit({ jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: 'native-1', update: { sessionUpdate, ...data } } }); }
  finish() { const request = this.written.filter(item => item.method === 'session/prompt').at(-1);
    this.emit({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } }); }
  onLine(handler: (line: string) => void) { this.lines.add(handler); return () => { this.lines.delete(handler); }; }
  onClose(handler: (info: { reason: string }) => void) { this.closes.add(handler); return () => { this.closes.delete(handler); }; }
  async close() { this.closeCount++; if (this.failClose) throw new Error('exit unconfirmed');
    for (const listener of this.closes) listener({ reason: 'closed' }); }
}
function create(fake = new FakeTransport(), extra: Partial<CursorAgentDeps> = {}) {
  const agent = new CursorAgent({ binaryPath: '/fake/cursor-agent', runtimeConfig: {},
    auth: { getState: vi.fn(async () => ({ authenticated: true })), getAuthEnv: vi.fn(async () => ({})),
      triggerLogin: vi.fn(async () => ({ authenticated: true })), logout: vi.fn(async () => {}) },
    logger: createConsoleLogger('cursor-test'),
    createCursorTransport: () => fake, ...extra,
  });
  return { fake, agent, start: (options = {}) => agent.startSession({ workingDir: '/tmp', model: CURSOR_DEFAULT_MODEL, ...options }) };
}
async function tick() { await new Promise(resolve => setTimeout(resolve, 0)); }

describe('Cursor native ACP lifecycle', () => {
  it('describes native approval coverage without promising a prompt for every edit', () => {
    const { agent, fake } = create();
    expect(agent.capabilities.permissionModes.map(mode => mode.id)).toEqual(['ask', 'default']);
    for (const mode of agent.capabilities.permissionModes) {
      expect(mode.description).toContain('native configured permission policy');
      expect(mode.description).toContain('only the approval requests Cursor sends');
      expect(mode.description).toContain('workspace edits may run without a prompt');
    }
    expect(agent.capabilities.turnPermissionPolicy?.supported.supported).toBe(false);
    expect(fake.written).toEqual([]);
  });
  it('starts once, persists native identity and streams multiple turns on one process', async () => {
    const { fake, agent, start } = create();
    expect(agent.capabilities.availableModels).toEqual([]);
    const handle = await start();
    const events: AgentEvent[] = [];
    const consume = (async () => { for await (const event of handle.events()) events.push(event); })();
    expect(handle.id).toBe('native-1');
    await handle.send({ type: 'user', content: 'one' });
    fake.update('agent_message_chunk', { content: { type: 'text', text: 'hello' } });
    fake.finish(); await tick();
    await handle.send({ type: 'user', content: 'two' }); fake.finish(); await tick();
    await handle.close(); await consume;
    expect(fake.written.filter(item => item.method === 'session/new')).toHaveLength(1);
    expect(fake.written.filter(item => item.method === 'session/prompt')).toHaveLength(2);
    expect(events.filter(item => item.type === 'done')).toHaveLength(2);
    expect(events.find(item => item.type === 'session_id')?.data).toBe('native-1');
    expect(events.find(item => item.type === 'text')?.data).toEqual({ text: 'hello', isFinal: false });
  });
  it('suppresses native load replay and preserves saved identity', async () => {
    const { fake, start } = create(); fake.loadReplay = true;
    const handle = await start({ resumeSessionId: 'native-1' });
    const iterator = handle.events()[Symbol.asyncIterator]();
    expect((await iterator.next()).value.type).toBe('session_id');
    await handle.close();
    expect((await iterator.next()).done).toBe(true);
    expect(fake.written.some(item => item.method === 'session/new')).toBe(false);
  });
  it('selects exact advertised config id/value and never sends default sentinel', async () => {
    const { fake, start } = create(); const handle = await start({ model: 'model-b' });
    expect(fake.written.find(item => item.method === 'session/set_config_option').params)
      .toEqual({ sessionId: 'native-1', configId: 'native-model-picker', value: 'model-b' });
    await handle.setModel!(CURSOR_DEFAULT_MODEL);
    expect(fake.written.filter(item => item.method === 'session/set_config_option').at(-1).params.value).toBe('auto-native');
    await handle.close();
  });
  it('answers approval with opaque allow_once ID, never grants always', async () => {
    const { fake, start } = create(); const handle = await start();
    handle.setInteractionResolver(async () => ({ kind: 'permission', behavior: 'allow', permissionUpdates: [{}] }));
    await handle.send({ type: 'user', content: 'do it' });
    fake.emit({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: {
      sessionId: 'native-1', toolCall: { toolCallId: 'tool1', title: 'write', kind: 'edit' },
      options: [{ kind: 'allow_always', optionId: 'global' }, { kind: 'allow_once', optionId: 'one-opaque' }],
    } });
    await tick();
    expect(fake.written.find(item => item.id === 'permission-1').result).toEqual({ outcome: { outcome: 'selected', optionId: 'one-opaque' } });
    await handle.close();
  });
  it('cancels pending permissions and waits for prompt completion', async () => {
    const { fake, start } = create(); const handle = await start();
    handle.setInteractionResolver(() => new Promise(() => {}));
    await handle.send({ type: 'user', content: 'do it' });
    fake.emit({ jsonrpc: '2.0', id: 'p', method: 'session/request_permission', params: { sessionId: 'native-1', toolCall: {}, options: [] } });
    await tick();
    const abort = handle.abort(); await tick();
    expect(fake.written.find(item => item.id === 'p').result).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(fake.written.find(item => item.method === 'session/cancel').id).toBeUndefined();
    fake.finish(); await abort; await handle.close();
  });
  it('keeps reservation and aborts preparation before any prompt is dispatched', async () => {
    const { fake, start } = create(); const handle = await start(); fake.held.add('session/set_mode');
    const first = handle.send({ type: 'user', content: 'first' }, { planMode: true });
    await expect(handle.send({ type: 'user', content: 'second' })).rejects.toThrow('active turn');
    const rejected = expect(first).rejects.toThrow();
    await handle.abort(); await rejected;
    expect(fake.written.some(item => item.method === 'session/prompt')).toBe(false);
    await handle.close();
  });
  it('permits retry of unconfirmed process close without releasing bridge prematurely', async () => {
    const dispose = vi.fn(); const { fake, start } = create(undefined, {
      preparePiExtraSpawnConfig: async () => ({ disposeSessionCtx: dispose }),
    });
    const handle = await start(); fake.failClose = true;
    await expect(handle.close()).rejects.toThrow('exit unconfirmed'); expect(dispose).not.toHaveBeenCalled();
    await expect(handle.send({ type: 'user', content: 'blocked' })).rejects.toThrow('closed');
    fake.failClose = false; await handle.close(); expect(dispose).toHaveBeenCalledTimes(1);
  });
  it('keeps native instructions intact and passes scoped Memory/context and MCP identity once', async () => {
    const prepare = vi.fn(async (..._args: unknown[]) => ({ mcpBridge: { token: 'fake-test-token', servers: [{ name: 'memory', url: 'http://127.0.0.1/mcp' }] }, disposeSessionCtx: vi.fn() }));
    const { fake, start } = create(undefined, { preparePiExtraSpawnConfig: prepare });
    const handle = await start({ sessionId: 'cindy-1', sessionInstanceId: 'instance-1', makerMemoryEnabled: true,
      makerMemoryScopeKey: 'bot:example', makerMemoryIndexSnapshot: 'Remembered context', userPrompt: 'User preference', vendorOptions: { orcaRole: 'lead' } });
    expect(prepare.mock.calls[0][1]).toMatchObject({ agentKind: 'cursor', sessionId: 'cindy-1', sessionInstanceId: 'instance-1',
      memoryScopeKey: 'bot:example', memoryEnabled: true, mcpCallerAttested: false, mcpCallerKind: 'unknown', vendorOptions: { orcaRole: 'lead' } });
    expect(fake.written.find(item => item.method === 'session/new').params.mcpServers).toEqual([
      { type: 'http', name: 'memory', url: 'http://127.0.0.1/mcp', headers: [{ name: 'Authorization', value: 'Bearer fake-test-token' }] },
    ]);
    await handle.send({ type: 'user', content: 'one' }); fake.finish(); await tick();
    await handle.send({ type: 'user', content: 'two' }); fake.finish(); await tick();
    const prompts = fake.written.filter(item => item.method === 'session/prompt');
    expect(prompts[0].params.prompt[0].text).toBe('Remembered context\n\nUser preference');
    expect(prompts[1].params.prompt).toEqual([{ type: 'text', text: 'two' }]);
    await handle.close();
  });
  it('rejects malformed prompt results instead of reporting successful completion', async () => {
    const { fake, start } = create(); const handle = await start(); const events: AgentEvent[] = [];
    const consume = (async () => { for await (const event of handle.events()) events.push(event); })();
    await handle.send({ type: 'user', content: 'one' });
    const prompt = fake.written.find(item => item.method === 'session/prompt');
    fake.emit({ jsonrpc: '2.0', id: prompt.id, result: {} }); await tick();
    await handle.close(); await consume;
    expect(events.some(event => event.type === 'done')).toBe(false);
    expect(events.find(event => event.type === 'error')?.data).toMatchObject({ reason: 'cursor_invalid_prompt_result' });
  });
  it('returns method-not-found for unsupported client requests even while idle', async () => {
    const { fake, start } = create(); const handle = await start();
    fake.emit({ jsonrpc: '2.0', id: 'unknown', method: 'fs/write_text_file', params: {} }); await tick();
    expect(fake.written.find(item => item.id === 'unknown').error.code).toBe(-32601);
    await handle.close();
  });
  it('does not auto-approve a pending plan when permission mode changes', async () => {
    const { fake, start } = create(); const handle = await start(); let answer: ((value: any) => void) | undefined;
    handle.setInteractionResolver(() => new Promise(resolve => { answer = resolve; }));
    await handle.send({ type: 'user', content: 'plan' });
    fake.emit({ jsonrpc: '2.0', id: 'plan', method: 'cursor/create_plan', params: { plan: 'Proposed changes' } }); await tick();
    await handle.setPermissionMode!('default');
    expect(fake.written.some(item => item.id === 'plan')).toBe(false);
    answer!({ kind: 'plan_review', behavior: 'deny', reason: 'Revise' }); await tick();
    expect(fake.written.find(item => item.id === 'plan').result).toEqual({ outcome: { outcome: 'rejected', reason: 'Revise' } });
    await handle.close();
  });
  it('cancels in-flight native startup when the owning agent is disposed', async () => {
    const { fake, agent, start } = create(); fake.held.add('initialize');
    const starting = start(); const rejected = expect(starting).rejects.toThrow('aborted');
    await tick(); await agent.dispose(); await rejected;
    expect(fake.closeCount).toBeGreaterThan(0);
    expect(fake.written.some(item => item.method === 'session/new')).toBe(false);
  });
  it('keeps uncertain disconnected turns running until process exit can be confirmed', async () => {
    const dispose = vi.fn(); const { fake, start } = create(undefined, { preparePiExtraSpawnConfig: async () => ({ disposeSessionCtx: dispose }) });
    const handle = await start(); const events: AgentEvent[] = [];
    const consume = (async () => { for await (const event of handle.events()) events.push(event); })();
    await handle.send({ type: 'user', content: 'work' }); fake.failClose = true;
    for (const listener of fake.closes) listener({ reason: 'lost transport' }); await tick();
    expect(handle.isTurnRunning!()).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
    expect(events.find(event => event.type === 'error')?.data).toMatchObject({ isTerminal: false, reason: 'cursor_cleanup_pending' });
    fake.failClose = false; await handle.abort(); await consume;
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  it('maps the standard authentication-required error to native login guidance', async () => {
    const { fake, start } = create(); fake.held.add('authenticate');
    fake.onWrite = message => { if (message.method === 'authenticate') fake.emit({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Authentication required' } }); };
    await expect(start()).rejects.toMatchObject({ name: 'AgentNotAuthenticatedError', agentKind: 'cursor' });
    expect(fake.closeCount).toBe(1);
  });
  it.each([{ reviewMode: true }, { botRuntimeProfile: {} }])('rejects restricted startup profiles before creating a native process: %j', async options => {
    const { fake, start } = create();
    await expect(start(options)).rejects.toThrow('restricted Reviewer or Bot runtime profiles');
    expect(fake.written).toEqual([]);
  });
  it.each([{ extraDirs: ['/read-only'] }, { writableDirs: ['/write'] }, { [LIBRARY_READ_ROOT]: '/library' }])('rejects directory grant promises it cannot enforce: %j', async options => {
    const { fake, start } = create();
    await expect(start(options)).rejects.toThrow('additional directory grants');
    expect(fake.written).toEqual([]);
  });
  it('rejects unsupported remote and per-turn policy boundaries explicitly', async () => {
    const { start } = create();
    await expect(start({ remoteHostId: 'ssh' })).rejects.toThrow('only on the task host');
    const handle = await start();
    await expect(handle.send({ type: 'user', content: 'readonly' }, { turnPermissionPolicy: { forceConfirmToolCall: () => true, origin: { kind: 'desktop' }, confirmationSurface: 'desktop' } }))
      .rejects.toThrow('Turn permission policy');
    await expect(handle.send({ type: 'user', content: '/approved-skill' }, { [PINNED_SKILL_INVOCATION]: {} as never })).rejects.toThrow('pinned Skill');
    await expect(handle.send({ type: 'user', content: 'no tools' }, { toolsDisabled: true })).rejects.toThrow('tools-disabled');
    await handle.close();
  });
});

describe('Cursor model and event contracts', () => {
  it('does not invent a model catalog or context size', () => {
    expect(readCursorModels({}).models).toEqual([]);
    const catalog = readCursorModels({ configOptions: [{ id: 'x', category: 'model', currentValue: 'runtime',
      options: [{ group: 'vendor', options: [{ value: 'runtime', name: 'Actual' }] }] }] });
    expect(catalog.models[0]).toMatchObject({ id: 'runtime', contextWindow: 0, newSessionDefault: ['cursor'] });
  });
  it('merges partial tool events without losing name/input and emits one terminal result', () => {
    const events: AgentEvent[] = []; const translator = new CursorTranslator(event => events.push(event));
    translator.update({ sessionUpdate: 'tool_call', toolCallId: '1', title: 'read', kind: 'read', rawInput: { path: 'a' } });
    translator.update({ sessionUpdate: 'tool_call_update', toolCallId: '1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'contents' } }] });
    translator.update({ sessionUpdate: 'tool_call_update', toolCallId: '1', status: 'completed' });
    expect(events.filter(event => event.type === 'tool_use')).toHaveLength(1);
    expect(events.find(event => event.type === 'tool_result_full')?.data).toEqual({ toolUseId: '1', fullText: 'contents', isError: false });
    expect(events.filter(event => event.type === 'tool_result_full')).toHaveLength(1);
  });
  it('maps desktop/mobile JSON multi-select including commas to opaque option IDs', () => {
    expect(cursorAnswers([{ id: 'q', prompt: 'Pick', allowMultiple: true, options: [
      { id: 'a', label: 'Alpha, one' }, { id: 'b', label: 'Beta' },
    ] }], { Pick: '["Alpha, one","Beta"]' })).toEqual({ outcome: { outcome: 'answered', answers: [{ questionId: 'q', selectedOptionIds: ['a', 'b'] }] } });
  });
  it('does not fabricate an answer for free text or duplicate option labels', () => {
    const question = { id: 'q', prompt: 'Pick', options: [{ id: 'a', label: 'Same' }, { id: 'b', label: 'Same' }] };
    expect(cursorAnswers([question], { Pick: 'Same' })).toMatchObject({ outcome: { outcome: 'skipped' } });
    expect(cursorAnswers([question], { Pick: 'Custom' })).toMatchObject({ outcome: { outcome: 'skipped' } });
  });
});
