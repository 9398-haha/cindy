/**
 * 反向请求回包交付：链路抖动导致 reply 发送失败时必须重试——对方一直在等同一
 * requestId 的回包，只记日志不重试会让任务停在权限确认 / 工具请求上无法推进。
 */
import { describe, expect, it } from 'vitest';

import type { RemoteAgentPoller } from '../controller/poller';
import { RemoteAgentRunClient } from '../controller/runClient';

describe('RemoteAgentRunClient reply delivery', () => {
  it('retries a reply through transient link failures so the other side does not stall', async () => {
    const replyAttempts: number[] = [];
    let failuresLeft = 2;
    const invoke = async (args: unknown[]): Promise<unknown> => {
      const op = (args[0] as { op: string }).op;
      if (op === 'reply') {
        replyAttempts.push(replyAttempts.length + 1);
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('TIMEOUT: link dropped mid-reply');
        }
      }
      return {};
    };
    const client = new RemoteAgentRunClient(
      'run-1',
      { invoke, unregister: () => undefined } as unknown as RemoteAgentPoller,
      {
        onEvent: () => undefined,
        onState: () => undefined,
        onWs: () => undefined,
        onClosed: () => undefined,
        onRequest: async () => ({ type: 'interaction', result: { kind: 'permission', behavior: 'allow' } }),
      },
      () => 'generated-id',
    );
    client.onData(Buffer.from(`${JSON.stringify({
      t: 'request',
      requestId: '11111111-2222-4333-8444-555555555555',
      request: {
        type: 'interaction',
        request: { kind: 'permission', requestId: 'r1', toolName: 'bash', input: { command: 'echo hi' } },
      },
    })}\n`), false);
    // 两次链路失败(退避 500ms / 1000ms)后第三次交付成功。
    const deadline = Date.now() + 10_000;
    while (replyAttempts.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(replyAttempts).toHaveLength(3);
    expect(failuresLeft).toBe(0);
  });
});
