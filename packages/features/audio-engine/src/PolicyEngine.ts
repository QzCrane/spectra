// goal: stateless engine to determine optimal audio mode based on environment and user intent
// note: legacy mode tokens map to transparent bypass, explicit Media WebAudio, or Capture

import type {
  IPolicyEngine,
  PolicyContext,
  AudioMode,
  SiteRule
} from '@nexus/contracts';
import { isDefaultAudioConfig, resolveAudioVolume } from '@nexus/contracts';
import { requiresAudioProcessor } from './color-predictor.js';

export class PolicyEngine implements IPolicyEngine {
  // eff: computes AudioMode using falling-priority rules:
  // 1. Off/default -> transparent bypass
  // 2. Native-only controls -> transparent bypass
  // 3. Explicit DSP with complete safe media coverage -> Media WebAudio
  // 4. Explicit DSP without complete safe coverage -> authorized Capture
  public readonly calculateMode = (context: PolicyContext): AudioMode => {
    const { enabled, isRestricted, userInteracted } = context;

    if (!enabled || (context.config && isDefaultAudioConfig(context.config))) {
      return 'DISABLED';
    }

    if (!userInteracted
		&& (!context.config || resolveAudioVolume(context.config).boost <= 1)) {
      return 'NATIVE_LITE';
    }

	if (!context.config || !requiresAudioProcessor(context.config)) return 'NATIVE_LITE';

	// A preference flag cannot turn an unproven cross-origin resource into a
	// safe MediaElementSource binding. Unknown/unsafe coverage always delegates
	// to the acknowledged full-output path.
    const restricted = isRestricted ?? false;
    return restricted ? 'CAPTURE' : 'NATIVE_WEBAUDIO';
  }

  // @deprecated: domain rules mapping is no longer used in v3.0+
  public getRuleForDomain(_domain: string): SiteRule | null {
    return null;
  }
}

