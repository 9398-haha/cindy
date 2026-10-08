/**
 * 设置 → 模型供应商里「分享给我的」(受邀者)。别人分享给我的供应商与自己的供应商同在左栏，
 * 单独成组、用分享者头像标明来自谁；点开后右栏显示状态、可用的模型与「退出」。
 * 组末是「粘贴分享链接」——分享链接的加入网页在唤起 Cindy 失败时会指引用户到这里粘贴。
 *
 * 模型清单读分享者电脑上分享给我的那份目录(`share:<id>`)，只读：开关与排序由分享者决定。
 */
import { Link2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ProviderShareReceived } from '@cindy/device-link';
import type { AgentKind } from '@cindy/model-providers';

import { hasProviderLogo, ProviderLogoMark } from '@/components/icons/ProviderLogoMark';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Tip } from '@/components/ui/tooltip';
import { useDeviceProviders } from '@/hooks/useDeviceProviders';
import { isDeviceModelVisible, providerMonogram } from '@/lib/providerModels';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';

import { providerShareAgentDeviceId } from './providerShareFormat';
import { ProviderSharePasteDialog } from './ProviderSharePasteDialog';
import { useProviderShareReceived } from './providerShareStore';
import { ShareAvatar } from './ShareAvatar';

type ReceivedStatus = 'active' | 'paused' | 'offline' | 'needs-update';

function receivedStatus(share: ProviderShareReceived): ReceivedStatus {
  if (share.status !== 'active') return 'paused';
  if (!share.hostOnline) return 'offline';
  return share.hostCapable ? 'active' : 'needs-update';
}

const STATUS_LABEL_KEY: Record<ReceivedStatus, string> = {
  active: 'providerShare.received.statusActive',
  paused: 'providerShare.received.statusPaused',
  offline: 'providerShare.received.hostOffline',
  'needs-update': 'providerShare.received.hostUnavailable',
};

function StatusDot({ status }: { status: ReceivedStatus }) {
  return (
    <span
      aria-hidden="true"
      className="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{
        backgroundColor: status === 'active' ? 'var(--remote-status-ready)' : 'var(--border-default)',
      }}
    />
  );
}

/** 左栏的「分享给我的供应商」一组；没有分享时只留标题、一句说明与粘贴入口。 */
export function ProviderShareReceivedRailGroup({
  selectedShareId,
  onSelect,
}: {
  selectedShareId: string | null;
  onSelect: (shareId: string) => void;
}) {
  const { t } = useTranslation();
  const { received } = useProviderShareReceived();
  const [pasteOpen, setPasteOpen] = useState(false);
  const pasteButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <div data-testid="provider-share-received" className="flex flex-col gap-0.5">
      <span
        className="truncate px-2.5 pb-1 pt-3 text-11 font-medium"
        style={{ color: 'var(--text-tertiary)' }}
      >
        {t('providerShare.received.title')}
      </span>
      {received.length === 0 ? (
        <p className="px-2.5 pb-1 text-11 leading-[1.5]" style={{ color: 'var(--text-tertiary)' }}>
          {t('providerShare.received.empty')}
        </p>
      ) : (
        received.map((share) => {
          const status = receivedStatus(share);
          const owner = t('providerShare.received.fromOwner', { name: share.owner.displayName });
          const selected = selectedShareId === share.shareId;
          return (
            <Tip
              key={share.shareId}
              text={`${owner} · ${share.deviceName}`}
              side="right"
              contentClassName="max-w-[360px] break-words"
            >
              <button
                type="button"
                data-testid="provider-share-received-row"
                aria-current={selected}
                aria-label={`${share.providerLabel} · ${owner} · ${t(STATUS_LABEL_KEY[status])}`}
                onClick={() => onSelect(share.shareId)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg py-2 pl-3 pr-2.5 text-left transition-colors',
                  selected
                    ? 'bg-[var(--settings-menu-bg-selected)]'
                    : 'hover:bg-[var(--settings-menu-bg-hover)]',
                )}
              >
                <ShareAvatar displayName={share.owner.displayName} avatarUrl={share.owner.avatarUrl} size="sm" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    className="truncate text-13 font-medium"
                    style={{
                      color: status === 'active' ? 'var(--settings-section-title)' : 'var(--text-tertiary)',
                    }}
                  >
                    {share.providerLabel}
                  </span>
                  <span className="truncate text-11" style={{ color: 'var(--text-tertiary)' }}>
                    {owner}
                  </span>
                </span>
                <StatusDot status={status} />
              </button>
            </Tip>
          );
        })
      )}
      <button
        ref={pasteButtonRef}
        type="button"
        onClick={() => setPasteOpen(true)}
        className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-13 transition-colors hover:bg-[var(--settings-menu-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring-soft)]"
        style={{ color: 'var(--text-secondary)' }}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center" aria-hidden="true">
          <Link2 size={15} />
        </span>
        <span className="min-w-0 flex-1 truncate">{t('providerShare.received.paste')}</span>
      </button>
      {pasteOpen && (
        <ProviderSharePasteDialog
          onClose={() => {
            setPasteOpen(false);
            pasteButtonRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

const AGENT_ORDER: readonly AgentKind[] = ['claude-code', 'codex', 'pi'];

/** 右栏：一条分享给我的供应商。 */
export function ProviderShareReceivedDetail({ share }: { share: ProviderShareReceived }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [leaving, setLeaving] = useState(false);
  const status = receivedStatus(share);
  const catalog = useDeviceProviders(status === 'active' ? providerShareAgentDeviceId(share.shareId) : undefined);
  const provider = catalog.providers.find((entry) => entry.id === share.providerId) ?? catalog.providers[0] ?? null;

  const models = useMemo(() => {
    if (!provider) return [];
    const seen = new Set<string>();
    const rows: { id: string; name: string }[] = [];
    for (const agent of AGENT_ORDER) {
      for (const model of provider.models[agent] ?? []) {
        if (model.disabled || seen.has(model.id)) continue;
        if (!isDeviceModelVisible(catalog.modelVisibilityOverrides, agent, provider.id, model)) continue;
        seen.add(model.id);
        rows.push({ id: model.id, name: model.name || model.id });
      }
    }
    return rows;
  }, [provider, catalog.modelVisibilityOverrides]);

  const leave = async () => {
    const ok = await confirm({
      presentation: 'standard',
      title: t('providerShare.received.leaveConfirm.title', {
        name: share.owner.displayName,
        provider: share.providerLabel,
      }),
      description: t('providerShare.received.leaveConfirm.description'),
      confirmText: t('providerShare.received.leaveConfirm.confirm'),
      confirmVariant: 'destructive',
    });
    if (!ok) return;
    setLeaving(true);
    try {
      await window.electronAPI.providerShare.command({ action: 'leave', memberId: share.memberId });
      toast.success(
        t('providerShare.received.left', { name: share.owner.displayName, provider: share.providerLabel }),
      );
    } catch (error) {
      toast.error(t(mapIpcErrorToI18nKey(error)));
    } finally {
      setLeaving(false);
    }
  };

  const owner = t('providerShare.received.fromOwner', { name: share.owner.displayName });
  let body: string | null = null;
  if (status === 'paused') body = t('providerShare.received.pausedNote');
  else if (status === 'offline') body = t('providerShare.received.offlineNote');
  else if (status === 'needs-update') body = t('providerShare.received.needsUpdateNote');
  else if (catalog.error) body = t('providerShare.received.modelsFailed');
  else if (catalog.loading) body = t('providerShare.received.modelsLoading');
  else if (models.length === 0) body = t('providerShare.received.modelsEmpty');

  return (
    <div data-testid="provider-share-received-detail" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-5 py-4">
        <div className="flex flex-wrap items-center gap-3 gap-y-2">
          <div className="flex min-w-0 flex-auto basis-[220px] items-center gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
              style={{
                backgroundColor: 'var(--settings-integration-avatar-bg)',
                border: '1px solid var(--settings-integration-avatar-border)',
                color: 'var(--settings-integration-avatar-icon)',
              }}
            >
              {provider && hasProviderLogo(provider.id, provider.routing) ? (
                <ProviderLogoMark providerId={provider.id} routing={provider.routing} size={18} />
              ) : (
                <span className="text-15 font-medium leading-none">{providerMonogram(share.providerLabel)}</span>
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                className="min-w-0 truncate text-14 font-medium leading-tight"
                style={{ color: 'var(--settings-section-title)' }}
              >
                {share.providerLabel}
              </span>
              <span
                className="truncate text-13 leading-tight"
                style={{ color: 'var(--settings-integration-subtitle)' }}
              >
                {`${owner} · ${share.deviceName}`}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            <span role="status" className="inline-flex items-center gap-1.5 text-12 text-[var(--text-secondary)]">
              <StatusDot status={status} />
              {t(STATUS_LABEL_KEY[status])}
            </span>
            <Button
              variant="secondary"
              size="md"
              loading={leaving}
              aria-label={t('providerShare.received.leaveAria', {
                name: share.owner.displayName,
                provider: share.providerLabel,
              })}
              onClick={() => void leave()}
            >
              {t('providerShare.received.leave')}
            </Button>
          </div>
        </div>
      </div>

      <div
        className="flex shrink-0 items-start gap-3 border-t px-5 py-3"
        style={{ borderColor: 'var(--settings-theme-card-border)' }}
      >
        <ShareAvatar displayName={share.owner.displayName} avatarUrl={share.owner.avatarUrl} size="sm" />
        <p className="min-w-0 flex-1 text-13 leading-[1.5]" style={{ color: 'var(--settings-section-desc)' }}>
          {t('providerShare.received.detailNote', { name: share.owner.displayName })}
        </p>
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col border-t"
        style={{ borderColor: 'var(--settings-theme-card-border)' }}
      >
        <div className="flex shrink-0 items-baseline gap-2 px-5 pb-2 pt-3">
          <span className="text-13 font-medium" style={{ color: 'var(--settings-section-title)' }}>
            {t('providerShare.received.modelsTitle')}
          </span>
          {body === null && (
            <span className="text-12 tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.providers.models.modelCount', { count: models.length })}
            </span>
          )}
        </div>
        {body !== null ? (
          <p className="px-5 pb-4 text-13 leading-[1.5]" style={{ color: 'var(--text-tertiary)' }}>
            {body}
          </p>
        ) : (
          <ul data-testid="provider-share-received-models" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {models.map((model) => (
              <li
                key={model.id}
                className="flex items-center gap-3 rounded-lg px-3 py-2 text-13"
                style={{ color: 'var(--text-primary)' }}
              >
                <span className="min-w-0 flex-1 truncate">{model.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
