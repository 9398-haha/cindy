// @vitest-environment jsdom

/**
 * 设备 pill 的「只让 Agent 在其他电脑运行」:与「在那台上创建任务」分段列出、互不冒充;
 * 选中后 pill 写明 Agent 所在的电脑,点「本机」回到全部在本机。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.device ? `${key}(${String(values.device)})` : key,
  }),
}));

import { DeviceSwitcherPill } from '@/components/new-chat/DeviceSwitcherPill';

const devices = [
  { deviceId: 'dev-b', name: 'Office Mac', platform: 'darwin', online: true },
  { deviceId: 'dev-c', name: 'Old PC', platform: 'win32', online: false },
];

afterEach(() => cleanup());

function renderPill(props: Partial<Parameters<typeof DeviceSwitcherPill>[0]> = {}) {
  const onChange = vi.fn();
  const onAgentDeviceChange = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <DeviceSwitcherPill
      devices={devices}
      value={null}
      onChange={onChange}
      open
      onOpenChange={onOpenChange}
      onAgentDeviceChange={onAgentDeviceChange}
      {...props}
    />,
  );
  return { onChange, onAgentDeviceChange, onOpenChange };
}

describe('device pill: agent on another computer', () => {
  it('lists computers for running only the agent separately from creating the task there', () => {
    const { onChange, onAgentDeviceChange, onOpenChange } = renderPill();
    expect(screen.getByText('newChat.deviceSwitcher.agentSection')).toBeTruthy();
    const agentRows = screen.getAllByTestId('create-agent-agent-device-option');
    expect(agentRows).toHaveLength(2);
    // 离线的电脑列出但不能选。
    expect((agentRows[1] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(agentRows[0]);
    expect(onAgentDeviceChange).toHaveBeenCalledWith('dev-b', 'Office Mac');
    expect(onChange).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('names the agent computer on the pill and returns everything here from 本机', () => {
    const { onChange } = renderPill({ agentDeviceId: 'dev-b' });
    const pill = screen.getByTestId('create-agent-device-pill');
    expect(pill.getAttribute('aria-label')).toContain('newChat.deviceSwitcher.agentPill(Office Mac)');
    const localRow = screen.getAllByTestId('create-agent-device-option')[0];
    fireEvent.click(localRow);
    expect(onChange).toHaveBeenCalledWith(null, null);
  });

  it('keeps the old menu when the caller does not offer it', () => {
    renderPill({ onAgentDeviceChange: undefined });
    expect(screen.queryByText('newChat.deviceSwitcher.agentSection')).toBeNull();
  });
});
