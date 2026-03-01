// goal: manages chrome tab lifecycle events to maintain accurate tab prioritization and state cleanup

import { captureStates, badgeState, tabAudioStates, cleanupTabState, storage } from './state';
import { handleCaptureToggle } from './handlers/capture';
import { swLog } from '../shared/logger';

// eff: wires up global chrome tab listeners for activation, updates, and removal
export function setupLifecycleListeners(): void {
	chrome.tabs.onActivated.addListener((activeInfo) => {
		const now = Date.now();
		const s = tabAudioStates.get(activeInfo.tabId);
		if (s) {
			s.lastActivatedTime = now;
			s.userManuallyActivated = true;
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
			const s = tabAudioStates.get(tabId);
			if (changeInfo.audible && s) s.lastAudibleTime = Date.now();
		}
		if (changeInfo.status === 'complete') {
			// task: if a tab is refreshed and it's the active one, ensure it's visible
			chrome.tabs.get(tabId).then(tab => {
				if (tab.active) {
					const s = tabAudioStates.get(tabId);
					if (s) {
						s.userManuallyActivated = true;
					} else {
						tabAudioStates.set(tabId, {
							hasMediaElement: false,
							lastAudibleTime: 0,
							lastActivatedTime: Date.now(),
							userManuallyActivated: true,
						});
					}
				}
			}).catch(() => { });
		}
	});

	chrome.tabs.onRemoved.addListener((tabId) => {
		cleanupTabState(tabId);
		storage.tabSession.remove(tabId).catch(() => { });
		if (captureStates.get(tabId)) handleCaptureToggle(tabId, false);
	});

	// Task: Seed initial state with current active tabs to ensure visibility across reloads
	chrome.tabs.query({ active: true }).then(tabs => {
		const now = Date.now();
		for (const tab of tabs) {
			if (!tab.id) continue;
			tabAudioStates.set(tab.id, {
				hasMediaElement: false,
				lastAudibleTime: 0,
				lastActivatedTime: now,
				userManuallyActivated: true, // mark as activated because it IS the current active tab
			});
		}
	}).catch(() => { });
}
