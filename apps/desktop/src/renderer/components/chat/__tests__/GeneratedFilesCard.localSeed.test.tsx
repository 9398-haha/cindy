// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatSessionFileProvider } from '../ChatSessionFileContext';
import {
  _clearLocalGeneratedFileStatCache,
  GeneratedFilesCard,
  seedLocalGeneratedFilesFromStatCache,
} from '../GeneratedFilesCard';
import type { GeneratedFileRef } from '@/lib/generatedFiles';

vi.mock('../useFileChipContextMenu', () => ({
  useFileChipContextMenu: () => ({ menu: null, onContextMenu: vi.fn() }),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const START = 1_000_000;
const report: GeneratedFileRef = {
  path: 'C:\\work\\report.md',
  name: 'report.md',
  source: 'tool',
  ready: true,
};

function stubStat(statPath: ReturnType<typeof vi.fn>) {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { fsBrowse: { statPath } },
  });
}

function renderCard(props: {
  renderItemKey: string;
  files?: readonly GeneratedFileRef[];
  turnStartMs: number;
  turnEndMs?: number | null;
}) {
  return render(cardElement(props));
}

function cardElement(props: {
  renderItemKey: string;
  files?: readonly GeneratedFileRef[];
  turnStartMs: number;
  turnEndMs?: number | null;
}) {
  return (
    <ChatSessionFileProvider
      value={{ sessionId: 'local-task', workingDir: 'C:\\work', origin: { kind: 'local' } }}
    >
      <GeneratedFilesCard
        renderItemKey={props.renderItemKey}
        files={props.files ?? [report]}
        turnStartMs={props.turnStartMs}
        turnEndMs={props.turnEndMs ?? null}
      />
    </ChatSessionFileProvider>
  );
}

afterEach(() => {
  cleanup();
  _clearLocalGeneratedFileStatCache();
  vi.unstubAllGlobals();
});

describe('local generated files remount', () => {
  it('keeps the first paint empty until a path has been checked once', async () => {
    const statPath = vi
      .fn()
      .mockResolvedValue({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 });
    stubStat(statPath);
    renderCard({ renderItemKey: 'genfiles-a', turnStartMs: START });
    expect(screen.queryByText('report.md')).toBeNull();
    await waitFor(() => expect(screen.getByText('report.md')).toBeTruthy());
  });

  it('renders a remounted card immediately when an earlier history page moves the turn start', async () => {
    const statPath = vi
      .fn()
      .mockResolvedValue({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 });
    stubStat(statPath);
    const first = renderCard({ renderItemKey: 'genfiles-a', turnStartMs: START });
    await waitFor(() => expect(screen.getByText('report.md')).toBeTruthy());
    first.unmount();

    // Prepending older rows of the same open turn changes its key and widens the window.
    renderCard({ renderItemKey: 'genfiles-older', turnStartMs: START - 60_000 });
    expect(screen.getByText('report.md')).toBeTruthy();
    // The cached conclusion only bridges the paint; the new instance still re-checks.
    await waitFor(() => expect(statPath).toHaveBeenCalledTimes(2));
  });

  it('removes a seeded chip when the re-check finds the file gone', async () => {
    const statPath = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 })
      .mockResolvedValueOnce({ kind: 'missing' });
    stubStat(statPath);
    const first = renderCard({ renderItemKey: 'genfiles-a', turnStartMs: START });
    await waitFor(() => expect(screen.getByText('report.md')).toBeTruthy());
    first.unmount();

    renderCard({ renderItemKey: 'genfiles-a', turnStartMs: START });
    expect(screen.getByText('report.md')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('report.md')).toBeNull());
  });

  it('re-checks a seeded path when another file finishes during the first check', async () => {
    const notes: GeneratedFileRef = {
      path: 'C:\\work\\notes.md',
      name: 'notes.md',
      source: 'tool',
      ready: true,
    };
    const pending: Array<(stat: unknown) => void> = [];
    const statPath = vi.fn((path: string) =>
      path === notes.path
        ? Promise.resolve({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 })
        : new Promise((resolve) => {
            pending.push(resolve);
          }),
    );
    stubStat(statPath);
    const first = renderCard({ renderItemKey: 'genfiles-a', turnStartMs: START });
    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0]({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 });
    await waitFor(() => expect(screen.getByText('report.md')).toBeTruthy());
    first.unmount();

    // Remount seeds report.md from the stat cache; its re-check hangs mid-turn.
    const second = renderCard({ renderItemKey: 'genfiles-a', turnStartMs: START });
    expect(screen.getByText('report.md')).toBeTruthy();
    await waitFor(() => expect(pending).toHaveLength(2));
    // notes.md finishes while the seeded re-check is still in flight. The check
    // fingerprint changes and cancels that run before its verdict can land.
    second.rerender(cardElement({ renderItemKey: 'genfiles-a', turnStartMs: START, files: [report, notes] }));
    await waitFor(() => expect(pending).toHaveLength(3));
    // The replacement re-check still verifies the seeded path and finds it gone.
    pending[2]({ kind: 'missing' });
    await waitFor(() => expect(screen.queryByText('report.md')).toBeNull());
    expect(screen.getByText('notes.md')).toBeTruthy();
  });

  it('applies the current turn window to cached stats', async () => {
    const statPath = vi
      .fn()
      .mockResolvedValue({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 });
    stubStat(statPath);
    const first = renderCard({
      renderItemKey: 'genfiles-a',
      turnStartMs: START,
      turnEndMs: START + 60_000,
    });
    await waitFor(() => expect(screen.getByText('report.md')).toBeTruthy());
    first.unmount();

    // A later turn that touches the same path must not inherit the earlier turn's file.
    expect(seedLocalGeneratedFilesFromStatCache([report], START + 120_000, null)).toBeNull();
    expect(seedLocalGeneratedFilesFromStatCache([report], START - 60_000, START + 60_000)).toEqual([
      report,
    ]);
  });

  it('does not seed from local stats for remote sessions', async () => {
    const statPath = vi
      .fn()
      .mockResolvedValue({ kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 });
    const chatStat = vi.fn(() => new Promise(() => {}));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { fsBrowse: { statPath }, fileBrowser: { chatStat } },
    });
    const first = renderCard({ renderItemKey: 'genfiles-a', turnStartMs: START });
    await waitFor(() => expect(screen.getByText('report.md')).toBeTruthy());
    first.unmount();

    render(
      <ChatSessionFileProvider
        value={{
          sessionId: 'remote-task',
          workingDir: 'C:\\work',
          origin: { kind: 'device', deviceId: 'host' },
        }}
      >
        <GeneratedFilesCard
          renderItemKey="genfiles-a"
          files={[report]}
          turnStartMs={START}
          turnEndMs={null}
        />
      </ChatSessionFileProvider>,
    );
    expect(screen.queryByText('report.md')).toBeNull();
  });
});
