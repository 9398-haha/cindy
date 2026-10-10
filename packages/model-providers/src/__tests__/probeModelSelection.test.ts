import { describe, expect, it } from 'vitest';

import { selectProtocolCompatibleProbeModel } from '../probeModelSelection.js';

const OPENCODE_GO = 'https://opencode.ai/zen/go/v1';

describe('selectProtocolCompatibleProbeModel', () => {
  const mixed = [
    { id: 'grok-4.6', name: 'Grok' },
    { id: 'qwen3.6-plus', name: 'Qwen' },
    { id: 'glm-5.2', name: 'GLM' },
  ];

  it('prefers the catalog model that matches the connection protocol at this exact endpoint', () => {
    expect(selectProtocolCompatibleProbeModel(mixed, 'openai-chat', OPENCODE_GO)?.id).toBe('glm-5.2');
    expect(selectProtocolCompatibleProbeModel(mixed, 'openai-responses', OPENCODE_GO)?.id).toBe('grok-4.6');
    expect(selectProtocolCompatibleProbeModel(mixed, 'anthropic-messages', OPENCODE_GO)?.id).toBe('qwen3.6-plus');
  });

  it('keeps an unknown model ahead of a known protocol mismatch', () => {
    const models = [{ id: 'my-private-model' }, { id: 'grok-4.6' }];
    expect(selectProtocolCompatibleProbeModel(models, 'openai-chat', OPENCODE_GO)?.id).toBe('my-private-model');
  });

  it('does not borrow an official model protocol for a different host', () => {
    expect(selectProtocolCompatibleProbeModel(mixed, 'openai-chat', 'https://relay.example/v1')?.id).toBe('grok-4.6');
  });

  it('preserves an explicit model route and still skips non-chat models', () => {
    const models = [
      { id: 'text-embedding-3-large', mode: 'embedding' },
      { id: 'glm-5.2', route: { baseUrl: OPENCODE_GO, wireProtocol: 'openai-responses' as const } },
      { id: 'deepseek-v4-flash' },
    ];
    expect(selectProtocolCompatibleProbeModel(models, 'openai-chat', OPENCODE_GO)?.id).toBe('glm-5.2');
  });

  it('does not treat a catalog-projected route as a user override', () => {
    const models = [
      { id: 'grok-4.6', route: { baseUrl: OPENCODE_GO, wireProtocol: 'openai-responses' as const }, userModelConfig: {} },
      { id: 'glm-5.2' },
    ];
    expect(selectProtocolCompatibleProbeModel(models, 'openai-chat', OPENCODE_GO)?.id).toBe('glm-5.2');
  });

  it('does not use standard endpoint catalog evidence for a custom request path', () => {
    expect(selectProtocolCompatibleProbeModel(mixed, 'openai-chat', OPENCODE_GO, '/custom/chat')?.id)
      .toBe('grok-4.6');
  });

  it('falls back to the first chat model when every known protocol mismatches', () => {
    expect(selectProtocolCompatibleProbeModel(mixed, 'google-generative-ai', OPENCODE_GO)?.id).toBe('grok-4.6');
  });
});
