import { getModelCapabilities } from '../../../../../shared/modelCapabilities';
import type { CapOverride } from '../inputs/CapabilityOverridesInput';

/** Capability readout for the currently selected model (live from the form,
 *  preferring user overrides, then gateway-provided hints from a fetched
 *  model list, then the name heuristic). */
export function ModelCapabilitiesLine({ model, models, overrides }: {
  model: string;
  models: Array<{ id: string; vision?: boolean; tools?: boolean }>;
  overrides?: CapOverride[];
}) {
  const live = models.find(m => m.id === model);
  const caps = getModelCapabilities(model, live ? { vision: live.vision, tools: live.tools } : undefined, overrides);
  return (
    <div className="config-models">
      <div className={`config-caps ${caps.tools ? '' : 'config-caps-warn'}`}>
        <span>Capabilities:</span>
        <span className={caps.vision ? 'config-cap-ok' : 'config-cap-no'}>
          🖼 vision {caps.vision ? '✓' : '✗'}
        </span>
        <span className={caps.tools ? 'config-cap-ok' : 'config-cap-no'}>
          🛠 tool calling {caps.tools ? '✓' : '✗'}
        </span>
      </div>
      {!caps.tools && (
        <div className="config-models-error">
          ⚠ This model doesn't support tool calling — agentic modes (Chat/Plan/Act) will degrade to plain chat without tools, file edits, or delegation.
        </div>
      )}
    </div>
  );
}
