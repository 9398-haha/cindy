import type { CompanionImportResult, CompanionImportSelection } from '@cindy/maker-shared/companion-import';
import type { RoutineInput } from '@cindy/maker-scheduler';
import { createImportBudget, fingerprint, readImportFile, readImportTree, reserveSnapshotItems } from './files.js';
import { CompanionImportError, type ImportItem, type ImportSnapshot } from './types.js';
import { resolveImportEnvironmentDependencies, selectedImportEnvironment } from './environmentSelection.js';

export interface ImportReceipt {
  selectionHash: string;
  result: CompanionImportResult;
  copied: string[];
  environmentSaved?: boolean;
  checkpointSaved?: boolean;
  companionCreated?: true;
  /** Terminal, non-secret rejection; retained so lost acknowledgements unlock callers. */
  creationRejected?: 'IMPORT_NAME_EXISTS';
  /** Current bindings carry explicit handover markers; old receipts upgrade once. */
  handoverMarkers?: true;
  /** Durable fence: a deleted companion's old preview/request must never recreate it. */
  cancelled?: boolean;
  routines: Record<string, { id: string; phase: 'created' | 'verified' | 'pausing-source' | 'source-paused' | 'complete'; sourceRestored?: boolean }>;
}

export interface TransferDeps {
  assertOwner(): void;
  readReceipt(requestId: string): Promise<ImportReceipt | undefined>;
  saveReceipt(receipt: ImportReceipt): Promise<void>;
  createCompanion(botId: string, selection: CompanionImportSelection): Promise<void>;
  validateItems?(items: ImportItem[]): void;
  importItem(botId: string, item: ImportItem, snapshot: ImportSnapshot): Promise<void>;
  saveEnvironment(botId: string, items: ImportItem[]): Promise<void>;
  saveCheckpoint(botId: string, items: ImportItem[]): Promise<void>;
  createConversation(botId: string): Promise<string>;
  createRoutine(botId: string, input: RoutineInput, creationId: string, item: ImportItem): Promise<string>;
  /** Success requires actual read evidence from the target environment, not just presence of keys. */
  verifyAutomation(botId: string, item: ImportItem): Promise<{ verified: boolean; reason?: string }>;
  pauseSource(item: ImportItem, snapshot: ImportSnapshot, resumeInterruptedPause: boolean): Promise<void>;
  resumeSource(item: ImportItem, snapshot: ImportSnapshot): Promise<void>;
  enableRoutine(botId: string, routineId: string, item: ImportItem): Promise<void>;
}

export function validateImportSelection(value: CompanionImportSelection, snapshot: ImportSnapshot): ImportItem[] {
  if (!value || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(value.requestId) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || typeof value.takeover !== 'boolean' || value.deferSetup !== undefined && typeof value.deferSetup !== 'boolean'
    || !Array.isArray(value.entryIds) || value.entryIds.some(id => typeof id !== 'string') || new Set(value.entryIds).size !== value.entryIds.length
    || value.avatarImageBase64 !== undefined && (typeof value.avatarImageBase64 !== 'string' || !value.avatarImageBase64.length || value.avatarImageBase64.length > 2_000_000))
    throw new CompanionImportError('INVALID_SELECTION');
  const selected = new Set(value.entryIds);
  let ranges: Array<[number, number]> | undefined;
  if (value.entryRanges !== undefined) {
    if (value.entryIds.length || !Array.isArray(value.entryRanges)) throw new CompanionImportError('INVALID_SELECTION');
    let previous = -1;
    for (const range of value.entryRanges) {
      if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) || range[0] <= previous || range[1] < range[0]) throw new CompanionImportError('INVALID_SELECTION');
      previous = range[1];
    }
    ranges = value.entryRanges;
  }
  const items = snapshot.items.filter(item => ranges ? item.sourceIndex !== undefined && ranges.some(([first, last]) => item.sourceIndex! >= first && item.sourceIndex! <= last) : selected.has(item.view.id));
  const count = ranges ? ranges.reduce((sum, [first, last]) => sum + last - first + 1, 0) : selected.size;
  if (!Number.isSafeInteger(count) || items.length !== count) throw new CompanionImportError('SELECTION_CHANGED');
  selectedImportEnvironment(items);
  return resolveImportEnvironmentDependencies(items);
}

/** One receipt is shared by GUI, remote actions and command callers. Writes are serialized by the host. */
export async function transferCompanion(snapshot: ImportSnapshot, selection: CompanionImportSelection, deps: TransferDeps, reconcileOnly = false, resumeSetup = false): Promise<CompanionImportResult> {
  const items = validateImportSelection(selection, snapshot);
  deps.assertOwner();
  const selectedIds = items.map(item => item.view.id);
  const selectionHash = fingerprint([selection.name, selection.avatarImageBase64, selectedIds.toSorted(), selection.takeover, snapshot.source.kind, snapshot.source.agentId, snapshot.source.root]);
  const existing = await deps.readReceipt(selection.requestId);
  deps.assertOwner();
  if (existing && existing.selectionHash !== selectionHash) throw new CompanionImportError('REQUEST_ALREADY_USED');
  if (existing?.creationRejected) throw new CompanionImportError(existing.creationRejected);
  if (existing?.cancelled) return existing.result;
  if (existing?.result.status === 'complete') return existing.result;
  const receipt: ImportReceipt = existing ?? { selectionHash, handoverMarkers: true, copied: [], routines: {}, result: {
    requestId: selection.requestId, botId: `import_${fingerprint(selection.requestId).slice(0, 24)}`, status: 'running', checks: [],
  } };
  const botId = receipt.result.botId;
  const save = async () => { deps.assertOwner(); await deps.saveReceipt(receipt); deps.assertOwner(); };
  const check = (entryId: string, status: CompanionImportResult['checks'][number]['status'], message?: string) => {
    receipt.result.checks = [...receipt.result.checks.filter(item => item.entryId !== entryId), { entryId, status, ...(message ? { message } : {}) }];
  };
  receipt.result.status = 'running';
  receipt.result.checks = receipt.result.checks.filter(item => item.entryId !== 'import');
  // Capture only selected resources, then publish a non-secret request index
  // before storing credentials. Acceptance still waits for the full checkpoint.
  if (!receipt.checkpointSaved || items.some(item => item.captureIssue)) {
    const budget = createImportBudget();
    reserveSnapshotItems(snapshot.items, budget);
    for (const item of items) {
      if (item.captureIssue && item.sourceDirectory && item.filesComplete && !receipt.copied.includes(item.view.id)) {
        item.files = undefined; item.filesComplete = false;
      }
      if (item.captureIssue && item.sourceFile) {
        try {
          item.text = (await readImportFile(item.sourceFile.root, item.sourceFile.file, budget)).bytes.toString('utf8');
          delete item.captureIssue;
        } catch (error) { item.captureIssue = error instanceof CompanionImportError ? error.code : 'IMPORT_ITEM_FAILED'; }
        deps.assertOwner();
      }
      if (item.sourceDirectory && !item.filesComplete) {
        const captured = item.files ?? [];
        const names = new Set(captured.map(file => file.name));
        try {
          item.files = [...captured, ...await readImportTree(item.sourceDirectory, name => !names.has(name), budget)];
          item.filesComplete = true;
          delete item.captureIssue;
        } catch (error) {
          deps.assertOwner();
          item.captureIssue = error instanceof CompanionImportError ? error.code : 'IMPORT_ITEM_FAILED';
        }
        deps.assertOwner();
      }
    }
    deps.validateItems?.(items);
    await save();
    await deps.saveCheckpoint(botId, items);
    deps.assertOwner();
    receipt.checkpointSaved = true;
  }
  await save();
  await deps.createCompanion(botId, selection);
  deps.assertOwner();
  receipt.companionCreated = true;
  await save();
  // Each selected item is a separate checkpoint. Retrying never copies unselected source files.
  for (const item of items.filter(item => item.view.category !== 'automations' && item.view.category !== 'connections')) {
    if (receipt.copied.includes(item.view.id)) continue;
    deps.assertOwner();
    try {
      if (item.captureIssue) throw new CompanionImportError(item.captureIssue);
      await deps.importItem(botId, item, snapshot);
      deps.assertOwner();
      receipt.copied.push(item.view.id);
      check(item.view.id, item.view.issues?.length ? 'needs-attention' : 'copied', item.view.issues?.[0]);
    } catch (error) {
      deps.assertOwner();
      check(item.view.id, 'needs-attention', error instanceof CompanionImportError ? error.code : 'IMPORT_ITEM_FAILED');
    }
    await save();
  }
  if (!receipt.environmentSaved) {
    await deps.saveEnvironment(botId, items);
    deps.assertOwner();
    receipt.environmentSaved = true;
    await save();
  }
  for (const item of items.filter(item => item.view.category === 'connections')) {
    const issue = item.view.dependsOn?.some(id => !selectedIds.includes(id)) ? 'AUTOMATION_DEPENDENCY_NOT_SELECTED' : item.view.issues?.[0];
    check(item.view.id, issue ? 'needs-attention' : 'copied', issue);
  }
  receipt.result.canonicalSessionId = await deps.createConversation(botId);
  await save();
  const selected = new Set(selectedIds);
  const byId = new Map(items.map(item => [item.view.id, item]));
  const missingDependency = (id: string, visited = new Set<string>()): boolean => {
    if (!selected.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    const item = byId.get(id);
    return !!item?.captureIssue || item?.view.enabled === false && (item.view.category === 'skills' || !!item.mcp) || receipt.result.checks.some(check => check.entryId === id && check.status === 'needs-attention') || !!item?.view.issues?.length || !!item?.view.dependsOn?.some(child => missingDependency(child, visited));
  };
  for (const item of items.filter(item => item.automation)) {
    // Background reconciliation repairs only interrupted work. A definitive
    // failed verification needs an explicit retry, never another model/Ask call.
    const prior = receipt.routines[item.view.id];
    if (reconcileOnly && receipt.result.checks.some(check => check.entryId === item.view.id && check.status === 'needs-attention')
      && prior?.phase !== 'pausing-source' && prior?.phase !== 'source-paused') continue;
    const automation = item.automation!;
    if (!automation.input) {
      check(item.view.id, 'needs-attention', item.view.issues?.[0] ?? 'SOURCE_AUTOMATION_INVALID');
      await save(); continue;
    }
    let record = receipt.routines[item.view.id];
    if (!record) {
      try {
        const id = await deps.createRoutine(botId, { ...automation.input, enabled: false }, fingerprint([selection.requestId, item.view.id]), item);
        deps.assertOwner();
        record = receipt.routines[item.view.id] = { id, phase: 'created' };
        await save();
      } catch (error) {
        deps.assertOwner();
        check(item.view.id, 'needs-attention', error instanceof CompanionImportError ? error.code : 'IMPORT_ITEM_FAILED');
        await save(); continue;
      }
    }
    if (record.phase === 'complete') { check(item.view.id, item.view.enabled && selection.takeover ? 'taken-over' : 'paused'); continue; }
    if (!item.view.enabled || !selection.takeover) {
      record.phase = 'complete'; check(item.view.id, 'paused'); await save(); continue;
    }
    if (item.view.issues?.length) {
      check(item.view.id, 'needs-attention', item.view.issues[0]); await save(); continue;
    }
    if (selection.deferSetup && !resumeSetup && record.phase === 'created') {
      check(item.view.id, 'needs-attention', 'IMPORT_SETUP_DEFERRED'); await save(); continue;
    }
    if (item.view.dependsOn?.some(id => missingDependency(id))) {
      check(item.view.id, 'needs-attention', 'AUTOMATION_DEPENDENCY_NOT_SELECTED'); await save(); continue;
    }
    if (record.phase === 'created') {
      try {
        const verification = await deps.verifyAutomation(botId, item);
        deps.assertOwner();
        if (!verification.verified) { check(item.view.id, 'needs-attention', verification.reason ?? 'AUTOMATION_READ_NOT_VERIFIED'); await save(); continue; }
        record.phase = 'verified'; check(item.view.id, 'verified'); await save();
      } catch (error) {
        deps.assertOwner();
        check(item.view.id, 'needs-attention', error instanceof CompanionImportError ? error.code : 'AUTOMATION_READ_NOT_VERIFIED');
        await save(); continue;
      }
    }
    try {
      if (record.phase === 'verified' || record.phase === 'pausing-source') {
        const resumeInterruptedPause = record.phase === 'pausing-source';
        // Persist intent before the native mutation. Its adapter can reconcile an interrupted pause.
        record.phase = 'pausing-source'; await save();
        await deps.pauseSource(item, snapshot, resumeInterruptedPause);
        deps.assertOwner();
        record.phase = 'source-paused'; await save();
      }
      await deps.enableRoutine(botId, record.id, item);
      deps.assertOwner();
      record.phase = 'complete'; check(item.view.id, 'taken-over'); await save();
    } catch (error) {
      deps.assertOwner();
      if (record.phase === 'pausing-source' && error instanceof CompanionImportError && !['SOURCE_HANDOVER_UNCERTAIN', 'SOURCE_HANDOVER_PENDING'].includes(error.code)) record.phase = 'verified';
      if (record.phase === 'source-paused' && !(error instanceof CompanionImportError && error.code === 'TARGET_HANDOVER_UNCERTAIN')) {
        // Only restore a source task this transaction actually paused; never alter other tasks.
        await deps.resumeSource(item, snapshot);
        deps.assertOwner();
        record.phase = 'verified';
      }
      check(item.view.id, 'needs-attention', error instanceof CompanionImportError ? error.code : 'AUTOMATION_HANDOVER_FAILED');
      await save();
    }
  }
  receipt.result.savedEntryIds = [...new Set([...receipt.copied,
    ...items.filter(item => item.view.category === 'connections' && receipt.environmentSaved).map(item => item.view.id),
    ...Object.keys(receipt.routines),
  ])];
  receipt.result.saved = true;
  receipt.result.status = Object.values(receipt.routines).some(item => item.phase === 'pausing-source' || item.phase === 'source-paused') ? 'running'
    : receipt.result.checks.some(check => check.status === 'needs-attention') ? 'needs-attention' : 'complete';
  await save();
  return receipt.result;
}
