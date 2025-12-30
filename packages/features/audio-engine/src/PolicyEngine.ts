// goal: stateless engine to determine optimal audio mode based on environment and user intent
// note: v3.5 lazy activation strategy - stays in NATIVE_LITE if volume <= 100 and no user interaction

import type {
  IPolicyEngine,
  PolicyContext,
  AudioMode,
  SiteRule
} from '@nexus/contracts';

export class PolicyEngine implements IPolicyEngine {
  // eff: detects if advanced features (EQ, Bass, Compressor, Visualizer, Volume > 100%) are active
  private needsAdvancedProcessing(context: PolicyContext): boolean {
    const { volume, visualizerEnabled, config } = context;
    if (volume > 100) return true;
    if (visualizerEnabled) return true;
    if (config) {
      if (config.eqValues?.some(v => v !== 0)) return true;
      if (config.compressor) return true;
      if (config.bass) return true;
    }
    return false;
  }

  // eff: computes AudioMode using falling-priority rules:
  // 1. Off -> NATIVE_LITE
  // 2. Uninteracted + Normal Volume -> NATIVE_LITE (CPU preservation)
  // 3. Simple Usage -> NATIVE_LITE
  // 4. Force Native OR Not Restricted -> NATIVE_WEBAUDIO
  // 5. Restricted -> CAPTURE
  public readonly calculateMode = (context: PolicyContext): AudioMode => {
    const { enabled, forceNative, isRestricted, userInteracted, volume } = context;

    if (!enabled) return 'NATIVE_LITE';

    if (!userInteracted && volume <= 100) {
      return 'NATIVE_LITE';
    }

    if (!this.needsAdvancedProcessing(context)) return 'NATIVE_LITE';

    const restricted = forceNative ? false : (isRestricted ?? false);
    return restricted ? 'CAPTURE' : 'NATIVE_WEBAUDIO';
  }

  // @deprecated: domain rules mapping is no longer used in v3.0+
  public getRuleForDomain(_domain: string): SiteRule | null {
    return null;
  }
}

