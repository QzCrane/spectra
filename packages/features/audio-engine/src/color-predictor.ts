// goal: processor-requirement and policy-candidate helpers; UI color must use acknowledged runtime state

import { resolveAudioVolume, type AudioConfig } from '@nexus/contracts';

export interface ColorContext {
	config: AudioConfig;
	isRestricted: boolean;
}

// One canonical answer for whether output processing is required. Visualizer
// is intentionally absent: it may observe an already-owned processor, but it
// never creates Media WebAudio or Capture by itself.
export function requiresAudioProcessor(config: AudioConfig): boolean {
	return resolveAudioVolume(config).boost > 1
		|| config.eqValues.some((value) => value !== 0)
		|| config.compressor
		|| config.bass
		|| config.mono
		|| config.pan !== 0
		|| config.delay !== 0;
}

// eff: compatibility projection for processor admission; visualization is an
// observer and never creates Media WebAudio or Capture by itself.
export function needsAdvancedProcessing(ctx: ColorContext): boolean {
	return requiresAudioProcessor(ctx.config);
}

// eff: predicts a Capture policy candidate; this is never evidence for purple UI state
export function predictCapture(ctx: ColorContext): boolean {
	return ctx.config.enabled && ctx.isRestricted && needsAdvancedProcessing(ctx);
}
