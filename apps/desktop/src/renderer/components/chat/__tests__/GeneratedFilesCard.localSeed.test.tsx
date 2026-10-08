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
  turnStartMs: number;
  turnEndMs?: number | null;
}) {
  return render(
    <ChatSessionFileProvider
      value={{ sessionId: 'local-task', workingDir: 'C:\\work', origin: { kind: 'local' } }}
    >
      <GeneratedFilesCard
        renderItemKey={props.renderItemKey}
        files={[report]}
        turnStartMs={props.turnStartMs}
        turnEndMs={props.turnEndMs ?? null}
      />
    </ChatSessionFileProvider>,
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
