import type { AudioConfig } from '@nexus/kernel';

export interface BadgeStatePayload {
	volume: number;
	muted: boolean;
	enabled: boolean;
	isCapture: boolean;
	userInteracted: boolean;
}

// eff: centralized logic to derive badge state hash, ensuring consistent deduping across all modules
export function getBadgeStateHash(p: BadgeStatePayload): string {
	// rule: order matters, inclusion matters. If it affects the badge, it MUST be here.
	return `${p.volume}_${p.muted}_${p.enabled}_${p.isCapture}_${p.userInteracted}`;
}

// eff: factory to create the payload from raw config, ensuring no fields are missed
export function createBadgePayload(
	config: AudioConfig,
	isCapture: boolean,
	userInteracted: boolean
): BadgeStatePayload {
	return {
		volume: config.volume,
		muted: config.muted,
		enabled: config.enabled ?? true, // default safe
		isCapture,
		userInteracted
	};
}
