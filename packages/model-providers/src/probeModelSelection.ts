import { isAgentSelectableModel } from './classification.js';
import { providerModelRecord } from './providerModelCatalog.js';
import { providerWireProtocolForApi } from './providerInterfaceRoutes.js';
import type { PiModelApi, ProviderWireProtocol } from './types.js';

/** Explicit API that does not map onto a connection wire protocol. */
const UNMAPPED_PROBE_WIRE = Symbol('unmapped-probe-wire');

export interface ProbeModelCandidate {
  id: string;
  group?: string;
  mode?: string;
  api?: PiModelApi | null;
  piApi?: PiModelApi | null;
  route?: { baseUrl?: string; wireProtocol?: ProviderWireProtocol; requestPath?: string } | null;
  discoveredMetadata?: { mode?: string } | null;
}

/**
 * Pick the chat model a connection test should call.
 *
 * Prefer a model whose protocol matches the connection. Evidence is only an
 * explicit route/API on the model, or one catalog row at this exact endpoint
 * and model id. A custom host never inherits another supplier's model list,
 * and an unknown model stays eligible ahead of a known mismatch.
 */
export function selectProtocolCompatibleProbeModel<T extends ProbeModelCandidate>(
  models: readonly T[],
  wireProtocol: ProviderWireProtocol,
  baseUrl: string,
): T | undefined {
  const chat = models.filter((model) => {
    const id = model.id.trim();
    if (!id) return false;
    return isAgentSelectableModel(
      {
        id,
        group: model.group ?? 'custom',
        mode: model.mode ?? model.discoveredMetadata?.mode,
      },
      { userProvider: true },
    );
  });
  const ranked = chat.map((model) => ({ model, rank: probeProtocolRank(model, wireProtocol, baseUrl) }));
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked[0]?.model;
}

function probeProtocolRank(
  model: ProbeModelCandidate,
  wireProtocol: ProviderWireProtocol,
  baseUrl: string,
): number {
  const known = knownProbeWire(model, baseUrl);
  if (known === undefined) return 1;
  return known === wireProtocol ? 0 : 2;
}

function knownProbeWire(
  model: ProbeModelCandidate,
  baseUrl: string,
): ProviderWireProtocol | typeof UNMAPPED_PROBE_WIRE | undefined {
  if (model.route?.wireProtocol) return model.route.wireProtocol;
  const explicit = model.api ?? model.piApi;
  if (explicit) return providerWireProtocolForApi(explicit) ?? UNMAPPED_PROBE_WIRE;
  return catalogProbeWire(model.id.trim(), baseUrl);
}

/**
 * Official Messages contracts are stored on the parent of an OpenAI-style `/v1`
 * base, because their path already includes `/v1/messages`. A connection whose
 * base is `…/v1` still serves those models at `…/v1/messages`.
 */
function catalogProbeWire(
  modelId: string,
  baseUrl: string,
): ProviderWireProtocol | typeof UNMAPPED_PROBE_WIRE | undefined {
  const direct = wireAt(modelId, baseUrl);
  if (direct) return direct;
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!/\/v1$/i.test(trimmed)) return undefined;
  const lifted = wireAt(modelId, trimmed.slice(0, -3));
  return lifted === 'anthropic-messages' ? lifted : undefined;
}

function wireAt(
  modelId: string,
  upstream: string,
): ProviderWireProtocol | typeof UNMAPPED_PROBE_WIRE | undefined {
  const row = providerModelRecord(modelId, upstream);
  if (!row) return undefined;
  return providerWireProtocolForApi(row.execution.pi.api) ?? UNMAPPED_PROBE_WIRE;
}
