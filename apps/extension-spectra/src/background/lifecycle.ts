// goal: manages chrome tab lifecycle events to maintain accurate tab prioritization and state cleanup

import {
	SPECTRA_PROTOCOL_VERSION,
	type SpectraEventEnvelope,
} from '@nexus/contracts';

import {
	cleanupTabState,
	markTabActivated,
	markTabAudible,
	storage,
} from './state';
import { teardownCaptureState } from './handlers/capture';
import { flushAudioSessions, forgetAudioSession, removeAudioSession } from './audio-session-store';
import { settingsRepository } from './settings-repository';
import { clearBadgeUsage } from './badge-usage';

async function clearTabDocumentState(tabId: number, tabClosed = false): Promise<void> {
	// Queue capture teardown before awaiting storage. Otherwise a newly loaded
	// document can start capture during the storage await and then be torn down by
	// cleanup that belonged to the previous document.
	const captureTeardown = teardownCaptureState(tabId).then(
		(captureStopped) => {
			cleanupTabState(tabId, { preserveCapture: !captureStopped });
			return captureStopped;
		},
		() => {
			cleanupTabState(tabId, { preserveCapture: true });
			return false;
		},
	);
	await Promise.all([
		captureTeardown,
		(tabClosed ? storage.tabSession.remove(tabId) : storage.tabSession.flush(tabId))
			.catch(() => undefined),
		(tabClosed ? forgetAudioSession(tabId) : removeAudioSession(tabId)).catch(() => undefined),
		...(tabClosed ? [clearBadgeUsage(tabId)] : []),
	]);
}

// webNavigation distinguishes a real top-level document replacement from
// history.pushState/hash updates, both of which can surface as tabs.onUpdated
// loading changes while retaining the same Chrome documentId.
export function isTopLevelDocumentNavigation(details: { frameId: number }): boolean {
	return details.frameId === 0;
}

interface SameDocumentNavigationDetails {
	frameId: number;
	tabId: number;
	documentId: string;
	url: string;
}

// Chrome owns same-document navigation detection because History API wrappers
// installed in an isolated content world cannot observe page-world pushState.
export function notifySameDocumentNavigation(details: SameDocumentNavigationDetails): void {
	if (!isTopLevelDocumentNavigation(details)) return;
	const event: SpectraEventEnvelope<'spectra.navigation.changed'> = {
		protocolVersion: SPECTRA_PROTOCOL_VERSION,
		type: 'spectra.navigation.changed',
		tabId: details.tabId,
		documentId: details.documentId,
		payload: { url: details.url },
	};
	void chrome.tabs.sendMessage(
		details.tabId,
		event,
		{ documentId: details.documentId },
	).catch(() => undefined);
}

// eff: wires up global chrome tab listeners for activation, updates, and removal
export function setupLifecycleListeners(): void {
	const activeTabsByWindow = new Map<number, number>();
	chrome.runtime.onSuspend.addListener(() => {
		void Promise.allSettled([
			storage.tabSession.flush(),
			flushAudioSessions(),
			settingsRepository.flush(),
		]);
	});

	chrome.webNavigation.onBeforeNavigate.addListener((details) => {
		if (isTopLevelDocumentNavigation(details)) void clearTabDocumentState(details.tabId);
	});
	chrome.webNavigation.onCommitted.addListener((details) => {
		if (!isTopLevelDocumentNavigation(details) || !details.documentId) return;
		let origin = '';
		try { origin = new URL(details.url).origin; } catch { return; }
		if (origin === 'null') return;
		void storage.tabSession.rebind(details.tabId, {
			tabId: details.tabId,
			documentId: details.documentId,
			origin,
		}).catch(() => undefined);
	});
	chrome.webNavigation.onHistoryStateUpdated.addListener(notifySameDocumentNavigation);
	chrome.webNavigation.onReferenceFragmentUpdated.addListener(notifySameDocumentNavigation);

	chrome.tabs.onActivated.addListener((activeInfo) => {
		const now = Date.now();
		const previousTabId = activeTabsByWindow.get(activeInfo.windowId);
		if (previousTabId !== undefined && previousTabId !== activeInfo.tabId) {
			markTabActivated(previousTabId, now);
		}
		activeTabsByWindow.set(activeInfo.windowId, activeInfo.tabId);
		markTabActivated(activeInfo.tabId, now);
	});

	chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
		// eff: update activity timestamp if the tab generates sound
		if (changeInfo.audible !== undefined) {
			markTabAudible(tabId, changeInfo.audible);
		}
		if (changeInfo.status === 'complete') {
			// task: if a tab is refreshed and active, refresh its bounded visibility timestamp
			chrome.tabs.get(tabId).then(tab => {
				if (tab.active) markTabActivated(tabId);
			}).catch(() => { });
		}
	});

	chrome.tabs.onRemoved.addListener((tabId) => {
		for (const [windowId, activeTabId] of activeTabsByWindow) {
			if (activeTabId === tabId) activeTabsByWindow.delete(windowId);
		}
		void clearTabDocumentState(tabId, true);
	});

	// Task: Seed initial state with current active tabs to ensure visibility across reloads
	chrome.tabs.query({ active: true }).then(tabs => {
		const now = Date.now();
		for (const tab of tabs) {
			if (!tab.id) continue;
			if (tab.windowId !== undefined) activeTabsByWindow.set(tab.windowId, tab.id);
			markTabActivated(tab.id, now);
		}
	}).catch(() => { });

	// Restore current audible ownership after a service-worker restart. This is a
	// lifecycle seed, not a read-path side effect.
	chrome.tabs.query({ audible: true }).then(tabs => {
		const now = Date.now();
		for (const tab of tabs) {
			if (tab.id) markTabAudible(tab.id, true, now);
		}
	}).catch(() => { });
}
