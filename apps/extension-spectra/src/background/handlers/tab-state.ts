// goal: manages tab-specific audio activity and visibility states to prioritize the UI tab list

import {
	getOrCreateTabAudioState,
	router,
	tabAudioStates,
	TAB_VISIBLE_THRESHOLD_MS,
} from '../state';
import { injectContentScriptOnDemand } from '../upgrade-manager';
import { swLog } from '../../shared/logger';
import {
	SPECTRA_PROTOCOL_VERSION,
	isSpectraRequestEnvelope,
	rpcFailure,
	rpcSuccess,
} from '@nexus/contracts';

export function recordMediaState(
	tabId: number,
	payload: { hasMediaElement: boolean; userInteracted: boolean },
): { reported: true } {
	const state = getOrCreateTabAudioState(tabId);
	state.hasMediaElement = payload.hasMediaElement;
	state.userManuallyActivated = state.userManuallyActivated || payload.userInteracted;

	swLog.debug(`[SPECTRA] Tab ${tabId} reported media: ${payload.hasMediaElement}`);
	return { reported: true };
}

function isRecent(timestamp: number, now: number): boolean {
	return timestamp > 0 && now >= timestamp && now - timestamp < TAB_VISIBLE_THRESHOLD_MS;
}

export async function resolveVisibleTabs(now = Date.now()): Promise<{ tabs: number[] }> {
	const visibleTabsSet = new Set<number>();

	const currentTabs = await chrome.tabs.query({ active: true });
	for (const tab of currentTabs) {
		if (tab.id) visibleTabsSet.add(tab.id);
	}

	const audibleTabs = await chrome.tabs.query({ audible: true });
	for (const tab of audibleTabs) {
		if (tab.id) visibleTabsSet.add(tab.id);
	}

	for (const [tabId, state] of tabAudioStates.entries()) {
		const isRecentlyAudible = isRecent(state.lastAudibleTime, now);
		const isRecentlyActivated = isRecent(state.lastActivatedTime, now);
		if (isRecentlyAudible || isRecentlyActivated) {
			visibleTabsSet.add(tabId);
		} else if (!visibleTabsSet.has(tabId)) {
			// Media reports are telemetry, not a visibility lease. Prune entries with
			// no bounded Chrome-owned activity so the set cannot grow forever.
			tabAudioStates.delete(tabId);
		}
	}

	const tabs = Array.from(visibleTabsSet).sort((left, right) => left - right);
	swLog.debug(`[SPECTRA] Resolved visible tabs: ${tabs.join(', ')}`);
	return { tabs };
}

function registerTabStateV2Listener(): void {
	chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
		if (!message || typeof message !== 'object') return false;
		const candidate = message as { protocolVersion?: unknown; type?: unknown };
		if (candidate.protocolVersion !== SPECTRA_PROTOCOL_VERSION
			|| (candidate.type !== 'spectra.tab.media.report'
				&& candidate.type !== 'spectra.tab.visible.list'
				&& candidate.type !== 'spectra.content.inject')) return false;
		if (sender.id && sender.id !== chrome.runtime.id) {
			sendResponse(rpcFailure('forbidden', 'Tab-state RPC is extension-internal only'));
			return false;
		}
		if (!isSpectraRequestEnvelope(message)
			|| (message.type !== 'spectra.tab.media.report'
				&& message.type !== 'spectra.tab.visible.list'
				&& message.type !== 'spectra.content.inject')) {
			sendResponse(rpcFailure('invalid_request', 'Malformed tab-state request'));
			return false;
		}

		const operation = async () => {
			if (message.type === 'spectra.tab.media.report') {
				const tabId = sender.tab?.id;
				if (!tabId || (message.tabId !== undefined && message.tabId !== tabId)) {
					throw new Error('Media report requires its content-script tab');
				}
				return recordMediaState(tabId, message.payload);
			}
			if (message.type === 'spectra.content.inject') {
				return { injected: await injectContentScriptOnDemand(message.payload.tabId) };
			}
			return resolveVisibleTabs();
		};

		void operation()
			.then((result) => sendResponse(rpcSuccess(result)))
			.catch((error) => sendResponse(rpcFailure(
				'tab_state_unavailable',
				error instanceof Error ? error.message : String(error),
				true,
			)));
		return true;
	});
}

// eff: registers listeners for TAB_REPORT_MEDIA and TAB_GET_VISIBLE_TABS actions
export function registerTabStateHandlers(): void {
	registerTabStateV2Listener();
	router.on('TAB_REPORT_MEDIA', async (req, sender) => {
		const tabId = sender.tab?.id;
		if (!tabId) return;
		recordMediaState(tabId, {
			hasMediaElement: req.hasMediaElement,
			userInteracted: req.userInteracted === true,
		});
	});

	// note: one-release v1 adapters delegate to the same implementations.
	router.on('TAB_GET_VISIBLE_TABS', resolveVisibleTabs);

	// eff: on-demand content script injection when popup detects unreachable tab
	router.on('INJECT_CONTENT_SCRIPT', async (req: { tabId: number }) => {
		if (!req.tabId) return { success: false };
		const ok = await injectContentScriptOnDemand(req.tabId);
		return { success: ok };
	});
}
