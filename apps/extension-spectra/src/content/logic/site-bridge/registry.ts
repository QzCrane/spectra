import type { SiteBridge } from './types';
import { DefaultBridge } from './default-bridge';
import { YouTubeBridge } from './youtube-bridge';

let activeBridge: SiteBridge | null = null;

const bridges: SiteBridge[] = [
	new YouTubeBridge(),
	// Add new site bridges here
];

/**
 * Initializes and returns the most suitable bridge for the current site.
 * Follows the Pinnacle Registry pattern to avoid hardcoded site checks in core logic.
 */
export function getSiteBridge(): SiteBridge {
	if (activeBridge) return activeBridge;

	for (const bridge of bridges) {
		if (bridge.isMatch()) {
			activeBridge = bridge;
			return bridge;
		}
	}

	activeBridge = new DefaultBridge();
	return activeBridge;
}
