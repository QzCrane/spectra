// goal: manages tab-specific audio activity and visibility states to prioritize the UI tab list

import { router, tabAudioStates, captureStates, TAB_VISIBLE_THRESHOLD_MS } from '../state';
import { swLog } from '../../shared/logger';

// eff: registers listeners for TAB_REPORT_MEDIA and TAB_GET_VISIBLE_TABS actions
export function registerTabStateHandlers(): void {
	router.on('TAB_REPORT_MEDIA', async (req, sender) => {
		const tabId = sender.tab?.id;
		if (!tabId) return;

		const now = Date.now();
		const existing = tabAudioStates.get(tabId) ?? {
			hasMediaElement: false,
			lastAudibleTime: 0,
			lastActivatedTime: now,
			userManuallyActivated: false, // inv: background reports do not signify user intentionality
		};

		tabAudioStates.set(tabId, {
			...existing,
			hasMediaElement: req.hasMediaElement,
		});

		swLog.debug(`[SPECTRA] Tab ${tabId} reported media: ${req.hasMediaElement}`);
	});

	router.on('TAB_GET_VISIBLE_TABS', async () => {
		const now = Date.now();
		const visibleTabs: number[] = [];

		for (const [tabId, state] of tabAudioStates.entries()) {
			// rule: only include tabs the user has explicitly interacted with during the current session
			if (!state.userManuallyActivated) continue;

			const isCaptureActive = captureStates.get(tabId) === true;
			const hasMedia = state.hasMediaElement;
			const isRecentlyAudible = now - state.lastAudibleTime < TAB_VISIBLE_THRESHOLD_MS;

			// rule: a tab is "visible" in the UI if it has media elements, active capture, or was recently audible (<60s)
			if (hasMedia || isCaptureActive || isRecentlyAudible) {
				visibleTabs.push(tabId);
			}
		}

		swLog.debug(`[SPECTRA] Visible tabs: ${visibleTabs.join(', ')}`);
		return { tabs: visibleTabs };
	});
}
