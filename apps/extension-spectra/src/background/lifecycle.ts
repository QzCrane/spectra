// goal: manages chrome tab lifecycle events to maintain accurate tab prioritization and state cleanup

import { captureStates, badgeState, tabAudioStates, cleanupTabState } from './state';
import { handleCaptureToggle } from './handlers/capture';
import { swLog } from '../shared/logger';

// eff: wires up global chrome tab listeners for activation, updates, and removal
export function setupLifecycleListeners(): void {
	chrome.tabs.onActivated.addListener((activeInfo) => {
		const now = Date.now();
		const existing = tabAudioStates.get(activeInfo.tabId);

		if (existing) {
			tabAudioStates.set(activeInfo.tabId, {
				...existing,
				lastActivatedTime: now,
				userManuallyActivated: true, // inv: user interaction confirmed for the current session
			});
		} else {
			tabAudioStates.set(activeInfo.tabId, {
				hasMediaElement: false,
				lastAudibleTime: 0,
				lastActivatedTime: now,
				userManuallyActivated: true,
			});
		}
	});

	chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
		// eff: update activity timestamp if the tab generates sound
		if (changeInfo.audible !== undefined) {
			const now = Date.now();
			const existing = tabAudioStates.get(tabId);

			if (changeInfo.audible && existing) {
				tabAudioStates.set(tabId, {
					...existing,
					lastAudibleTime: now,
				});
			}
		}

		if (changeInfo.status === 'loading' && changeInfo.url) {
			// note: reload triggers automatic browser-side capture termination
		}
	});

	chrome.tabs.onRemoved.addListener((tabId) => {
		cleanupTabState(tabId);

		if (captureStates.get(tabId)) {
			// eff: force cleanup capture state if the tab is closed while active
			handleCaptureToggle(tabId, false);
		}
	});
}

