import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ row: {} as Record<string, unknown>, inserted: {} as Record<string, unknown> }));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ drizzle: {
    insert: () => ({ values: async (row: Record<string, unknown>) => { h.inserted = row; h.row = row; } }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [h.row] }) }) }),
  } }),
}));
vi.mock('../../localDb/mapper.js', () => ({ normalizeRemoteHostId: (value: string | undefined) => value?.trim() || null }));
vi.mock('../../localDb/schema.js', () => ({ sessions: { id: 'id' } }));
vi.mock('../../../shared/workingDir.js', () => ({ normalizeWorkingDirForStorage: (value: string | undefined) => value ?? null }));
import { DesktopSessionStorage } from '../session-storage.js';
beforeEach(() => { h.row = {}; h.inserted = {}; });
describe('Cursor persisted session capabilities', () => {
  it('keeps the legacy NOT NULL effort storage but removes unsupported controls on reopening', async () => {
    const storage = new DesktopSessionStorage();
    await storage.create({ id: 'cursor', title: 'Task', workDir: '/project', model: 'cursor-default', agentKind: 'cursor' });
    expect(h.inserted).toMatchObject({ agentKind: 'cursor', effort: 'high' });
    h.row.fastMode = true;
    const reopened = await storage.get('cursor');
    expect(reopened).toMatchObject({ agentKind: 'cursor', model: 'cursor-default', fastMode: false });
    expect(reopened?.effort).toBeUndefined();
  });
  it('retains other harness effort and fast settings', async () => {
    h.row = { id: 'codex', agentKind: 'codex', effort: 'high', fastMode: true };
    expect(await new DesktopSessionStorage().get('codex')).toMatchObject({ effort: 'high', fastMode: true });
  });
});
