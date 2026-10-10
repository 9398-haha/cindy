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
  /** Original saved model fields, before catalog route projection. */
  userModelConfig?: {
    api?: PiModelApi | null;
    piApi?: PiModelApi | null;
    route?: { baseUrl?: string; wireProtocol?: ProviderWireProtocol; requestPath?: string } | null;
  } | null;
  discoveredMetadata?: { mode?: string } | null;
}

/**
 * Pick the chat model a connection test should call.
 *
 * Preserve explicitly configured model transports. Otherwise prefer a model
 * whose catalog protocol matches the connection at this exact endpoint and id.
 * Custom hosts and request paths never borrow standard endpoint evidence, and
 * an unknown model stays eligible ahead of a known mismatch.
 */
export function selectProtocolCompatibleProbeModel<T extends ProbeModelCandidate>(
  models: readonly T[],
  wireProtocol: ProviderWireProtocol,
  baseUrl: string,
  requestPath?: string,
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
  const ranked = chat.map((model) => ({ model, rank: probeProtocolRank(model, wireProtocol, baseUrl, requestPath) }));
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked[0]?.model;
}

function probeProtocolRank(
  model: ProbeModelCandidate,
  wireProtocol: ProviderWireProtocol,
  baseUrl: string,
  requestPath?: string,
): number {
  // Preserve an explicitly configured model transport. Catalog projection can
  // also add a route/API, but that remains catalog evidence rather than a user
  // choice and should still be ranked against the runtime protocol.
  const configured = model.userModelConfig ?? model;
  if (configured.route?.wireProtocol || configured.api || configured.piApi) return 0;
  // Catalog evidence describes the standard endpoint, not a custom request path.
  if (configured.route?.requestPath || requestPath?.trim()) return 1;
  const known = catalogProbeWire(model.id.trim(), configured.route?.baseUrl ?? baseUrl);
  if (known === undefined) return 1;
  return known === wireProtocol ? 0 : 2;
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
