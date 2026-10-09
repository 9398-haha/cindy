// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrcaWorkerPanel } from '../OrcaWorkerPanel';
import { requestNewWorkerFromShortcut } from '../lib/newWorkerShortcut';

const mocks = vi.hoisted(() => ({
  hardLimit: 2,
  refreshCreationState: vi.fn(),
  setCreateOpen: vi.fn(),
  toastError: vi.fn(),
  toolbarProps: {} as Record<string, unknown>,
  createProps: {} as Record<string, unknown>,
  sessionViewProps: null as Record<string, unknown> | null,
  remotePaneProps: null as Record<string, unknown> | null,
  selection: {} as Record<string, unknown>,
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useAgentIslandSettings', () => ({ isAgentIslandSupported: () => false }));
vi.mock('@/lib/sidebarWindow', () => ({ isSidebarWindow: () => false }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.toastError } }));
vi.mock('../CCAgentSessionView', () => ({
  CCAgentSessionView: (props: Record<string, unknown>) => {
    mocks.sessionViewProps = props;
    return null;
  },
}));
vi.mock('../CreateWorkerPopover', () => ({
  CreateWorkerPopover: (props: Record<string, unknown>) => {
    mocks.createProps = props;
    return null;
  },
}));
vi.mock('../RemoteWorkerSessionPane', () => ({
  RemoteWorkerSessionPane: (props: Record<string, unknown>) => {
    mocks.remotePaneProps = props;
    return null;
  },
}));
vi.mock('../RolePillDropdown', () => ({
  WorkerListToolbar: (props: Record<string, unknown>) => {
    mocks.toolbarProps = props;
    return null;
  },
}));
vi.mock('../hooks/useOrcaWorkerSelection', () => ({
  useOrcaWorkerSelection: () => ({
    workers: [],
    focusedWorker: null,
    activeWorkerCount: 0,
    softLimit: 1,
    hardLimit: mocks.hardLimit,
    refresh: vi.fn(),
    refreshCreationState: mocks.refreshCreationState,
    selectedWorkerRecord: null,
    selectedWorkerId: null,
    workerSessionId: null,
    createOpen: false,
    setCreateOpen: mocks.setCreateOpen,
    handleCreateWorker: vi.fn(),
    handleSwitchFocus: vi.fn(),
    handleArchiveWorker: vi.fn(),
    workerPermissionMode: 'auto',
    ...mocks.selection,
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('OrcaWorkerPanel New Maker shortcut', () => {
  beforeEach(() => {
    mocks.hardLimit = 2;
    mocks.refreshCreationState.mockReset();
    mocks.setCreateOpen.mockReset();
    mocks.toastError.mockReset();
    mocks.toolbarProps = {};
  });

  afterEach(() => {
    cleanup();
  });

  it('opens the existing create dialog only from the visible collaboration panel', async () => {
    mocks.refreshCreationState.mockResolvedValue({
      status: 'applied',
      workers: [],
      hardLimit: 2,
    });
    render(<OrcaWorkerPanel leadSessionId="lead-1" viewVisible />);

    await expect(requestNewWorkerFromShortcut()).resolves.toBe(true);
    expect(mocks.refreshCreationState).toHaveBeenCalledOnce();
    expect(mocks.setCreateOpen).toHaveBeenCalledWith(true);
  });

  it('consumes the shortcut without opening when the refreshed team is at the hard limit', async () => {
    mocks.hardLimit = 1;
    mocks.refreshCreationState.mockResolvedValue({
      status: 'applied',
      workers: [{ status: 'running' }],
      hardLimit: 1,
    });
    render(<OrcaWorkerPanel leadSessionId="lead-1" viewVisible />);

    await expect(requestNewWorkerFromShortcut()).resolves.toBe(true);
    expect(mocks.setCreateOpen).not.toHaveBeenCalled();
  });

  it('consumes the shortcut and reports an error when authoritative creation state cannot be refreshed', async () => {
    mocks.refreshCreationState.mockResolvedValue({
      status: 'failed',
      workers: [],
      hardLimit: null,
    });
    render(<OrcaWorkerPanel leadSessionId="lead-1" viewVisible />);

    await expect(requestNewWorkerFromShortcut()).resolves.toBe(true);
    expect(mocks.setCreateOpen).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      'newChat.collaboration.createWorkerRefreshFailed',
    );
  });

  it('does not retain an in-flight shortcut after the visible panel unmounts', async () => {
    const pending = deferred<{ status: 'applied'; workers: []; hardLimit: number }>();
    mocks.refreshCreationState.mockReturnValue(pending.promise);
    const panel = render(<OrcaWorkerPanel leadSessionId="lead-1" viewVisible />);

    const request = requestNewWorkerFromShortcut();
    await waitFor(() => expect(mocks.refreshCreationState).toHaveBeenCalledOnce());
    panel.unmount();
    await act(async () => pending.resolve({ status: 'applied', workers: [], hardLimit: 2 }));

    await expect(request).resolves.toBe(true);
    expect(mocks.setCreateOpen).not.toHaveBeenCalled();
    await expect(requestNewWorkerFromShortcut()).resolves.toBe(false);
  });
});

describe('OrcaWorkerPanel settings navigation wiring', () => {
  afterEach(() => {
    cleanup();
  });

  it('omits settings navigation for device-link controlled leads', () => {
    render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId="dev-1" viewVisible />);
    expect(mocks.toolbarProps.onOpenSettings).toBeUndefined();
  });

  it('wires settings navigation for local leads', () => {
    render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);
    expect(mocks.toolbarProps.onOpenSettings).toBeTypeOf('function');
  });

  it('fails closed for unresolved device ownership', () => {
    render(<OrcaWorkerPanel leadSessionId="lead-1" viewVisible />);
    expect(mocks.toolbarProps.onOpenSettings).toBeUndefined();
  });
});

describe('OrcaWorkerPanel worker on another computer', () => {
  afterEach(() => {
    cleanup();
    mocks.selection = {};
    mocks.sessionViewProps = null;
    mocks.remotePaneProps = null;
  });

  const remoteWorker = {
    workerId: 'w-1',
    sessionId: 'proxy-1',
    role: 'transcriber',
    agent: 'claude-code',
    model: 'm',
    effort: null,
    label: null,
    status: 'running',
    focused: true,
    idleSince: null,
    executionDevice: {
      deviceId: 'mac-mini',
      remoteSessionId: 'remote-1',
      deviceName: 'Mac mini',
      reachable: true,
      workingDir: '/Users/demo/Interviews',
    },
  };

  it('shows the task on the execution device instead of the local proxy task', () => {
    mocks.selection = {
      workers: [remoteWorker],
      focusedWorker: remoteWorker,
      selectedWorkerRecord: remoteWorker,
      selectedWorkerId: 'w-1',
      workerSessionId: 'proxy-1',
    };
    render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);
    expect(mocks.sessionViewProps).toBeNull();
    expect(mocks.remotePaneProps).toMatchObject({
      leadSessionId: 'lead-1',
      device: remoteWorker.executionDevice,
    });
  });

  it('keeps local workers on the local task view', () => {
    const localWorker: Record<string, unknown> = { ...remoteWorker };
    delete localWorker.executionDevice;
    mocks.selection = {
      workers: [localWorker],
      focusedWorker: localWorker,
      selectedWorkerRecord: localWorker,
      selectedWorkerId: 'w-1',
      workerSessionId: 'proxy-1',
    };
    render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);
    expect(mocks.remotePaneProps).toBeNull();
    expect(mocks.sessionViewProps).toMatchObject({ sessionIdProp: 'proxy-1' });
  });

  it('offers execution devices only for a local, non-SSH Lead', () => {
    const { rerender } = render(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} viewVisible />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(true);
    rerender(<OrcaWorkerPanel leadSessionId="lead-1" deviceId={null} sshRemote viewVisible />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(false);
    rerender(<OrcaWorkerPanel leadSessionId="lead-1" deviceId="dev-1" viewVisible />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(false);
    rerender(<OrcaWorkerPanel leadSessionId="lead-1" viewVisible />);
    expect(mocks.createProps.executionDevicesEnabled).toBe(false);
  });
});
