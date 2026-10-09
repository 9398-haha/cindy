import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@/lib/ccAgent.types';
import * as sessionService from '@/lib/sessionService';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { onPatch, onRefresh } from '@/lib/sessionsBus';
import { sessionsStore } from '@/lib/sessionsStore';

const PAGE_SIZE = 200;
/** Bounded local reads; a full page never means all history has loaded. */
export function useWorkbenchSessionPages(
  scope: string,
  status: 'active' | 'archived',
  enabled: boolean,
) {
  const [rows, setRows] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const cursor = useRef<{ updatedAt: number; id: string } | undefined>(undefined);
  const busy = useRef(false);
  const generation = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const started = useRef(false);
  const load = useCallback(async () => {
    if (busy.current) return;
    started.current = true;
    busy.current = true;
    setLoading(true);
    setError(false);
    const version = generation.current;
    const owner = getDataOwnerGeneration();
    try {
      const page = await sessionService.list(PAGE_SIZE, status, {
        fresh: true,
        before: cursor.current,
      });
      if (version !== generation.current || !isDataOwnerGenerationCurrent(owner)) return;
      setRows((previous) => [
        ...new Map([...previous, ...page].map((row) => [row.id, row])).values(),
      ]);
      setHasMore(page.length === PAGE_SIZE);
      const tail = page.at(-1);
      if (tail) cursor.current = { updatedAt: Date.parse(tail.updatedAt), id: tail.id };
    } catch {
      if (version === generation.current && isDataOwnerGenerationCurrent(owner)) setError(true);
    } finally {
      if (version === generation.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  }, [status]);
  useEffect(() => {
    generation.current++;
    started.current = false;
    cursor.current = undefined;
    busy.current = false;
    setRows([]);
    setHasMore(true);
    setError(false);
    setLoading(false);
    if (enabledRef.current) void load();
    const offPatch = onPatch((id, patch) =>
      setRows((previous) => previous.map((row) => (row.id === id ? { ...row, ...patch } : row))),
    );
    const unsubscribe = sessionsStore.subscribe((change) => {
      if (change !== 'reset') return;
      started.current = false;
      generation.current++;
      cursor.current = undefined;
      busy.current = false;
      setRows([]);
      setHasMore(true);
      setError(false);
      setLoading(false);
      if (enabledRef.current) void load();
    });
    const offRefresh = onRefresh(() => {
      if (!enabledRef.current || busy.current) return;
      const version = generation.current;
      const owner = getDataOwnerGeneration();
      // Refresh only the head; loaded older pages and their continuation stay in place.
      void sessionService
        .list(PAGE_SIZE, status, { fresh: true })
        .then((page) => {
          if (version !== generation.current || !isDataOwnerGenerationCurrent(owner)) return;
          setRows((previous) => {
            const latest = new Map(page.map((row) => [row.id, row]));
            const ids = new Set(previous.map((row) => row.id));
            return [
              ...page.filter((row) => !ids.has(row.id)),
              ...previous.map((row) => latest.get(row.id) ?? row),
            ];
          });
        })
        .catch(() => {});
    });
    return () => {
      offRefresh();
      generation.current++;
      unsubscribe();
      offPatch();
    };
  }, [scope, status, load]);
  useEffect(() => {
    if (enabled && !started.current) void load();
  }, [enabled, load]);
  return { rows, loading, error, hasMore, load };
}
