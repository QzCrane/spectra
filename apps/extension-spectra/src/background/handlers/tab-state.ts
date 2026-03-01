// goal: manages tab-specific audio activity and visibility states to prioritize the UI tab list

import { router, tabAudioStates, captureStates, TAB_VISIBLE_THRESHOLD_MS } from '../state';
import { injectContentScriptOnDemand } from '../upgrade-manager';
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
			userManuallyActivated: existing.userManuallyActivated || !!req.userInteracted,
		});

		swLog.debug(`[SPECTRA] Tab ${tabId} reported media: ${req.hasMediaElement}`);
	});

	router.on('TAB_GET_VISIBLE_TABS', async () => {
		const now = Date.now();
		const visibleTabsSet = new Set<number>();

		// task: always include the currently active tab across all windows
		const currentTabs = await chrome.tabs.query({ active: true });
		for (const t of currentTabs) { if (t.id) visibleTabsSet.add(t.id); }

		// task: always include tabs that are currently making noise (even if extension just restarted)
		const audibleTabs = await chrome.tabs.query({ audible: true });
		for (const t of audibleTabs) { if (t.id) visibleTabsSet.add(t.id); }

		// task: include any tabs from memory that meet visibility criteria
		for (const [tabId, state] of tabAudioStates.entries()) {
			const isCaptureActive = captureStates.get(tabId) === true;
			const hasMedia = state.hasMediaElement;
			const isRecentlyAudible = now - state.lastAudibleTime < TAB_VISIBLE_THRESHOLD_MS;
			const isManuallyActivated = state.userManuallyActivated;

			if (hasMedia || isCaptureActive || isRecentlyAudible || isManuallyActivated) {
				visibleTabsSet.add(tabId);
			}
		}

		const visibleTabs = Array.from(visibleTabsSet);
		swLog.debug(`[SPECTRA] Resolved visible tabs: ${visibleTabs.join(', ')}`);
		return { tabs: visibleTabs };
	});

	// eff: on-demand content script injection when popup detects unreachable tab
	router.on('INJECT_CONTENT_SCRIPT', async (req: { tabId: number }) => {
		if (!req.tabId) return { success: false };
		const ok = await injectContentScriptOnDemand(req.tabId);
		return { success: ok };
	});
}
