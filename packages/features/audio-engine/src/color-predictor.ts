// goal: unified heuristics for predicting UI color states (e.g., CAPTURE vs NATIVE) based on audit policy

import type { AudioConfig } from '@nexus/contracts';

export interface ColorContext {
	config: AudioConfig;
	isRestricted: boolean;
	visualizerEnabled: boolean;
}

// eff: returns true if any advanced audio feature is enabled
export function needsAdvancedProcessing(ctx: ColorContext): boolean {
	const { config, visualizerEnabled } = ctx;
	return (
		config.volume > 100 ||
		visualizerEnabled ||
		config.eqValues?.some(v => v !== 0) ||
		config.compressor ||
		config.bass
	);
}

// eff: returns true if the environment warrants CAPTURE mode (Restricted + Advanced Needs)
export function predictCapture(ctx: ColorContext): boolean {
	return ctx.config.enabled && ctx.isRestricted && needsAdvancedProcessing(ctx);
}
