// goal: coordinates zero-refresh update by re-injecting content scripts into all matching tabs
// pre: requires "scripting" permission in manifest.json

import { swLog } from '../shared/logger';
import { injectMainBootstrap, injectMainBridges } from './main-runtime-manager';
import { ensureContentRuntime, releaseContentRuntimeLease } from './runtime-loader';

export const WARM_UPDATE_CONCURRENCY = 4;

type UpgradeTab = Pick<chrome.tabs.Tab, 'active' | 'id'>;
type TabInjector = (tabId: number) => Promise<void>;

async function injectBounded(tabIds: number[], inject: TabInjector): Promise<void> {
	let cursor = 0;
	const workerCount = Math.min(WARM_UPDATE_CONCURRENCY, tabIds.length);
	await Promise.all(Array.from({ length: workerCount }, async () => {
		while (cursor < tabIds.length) {
			const tabId = tabIds[cursor++];
			if (tabId === undefined) continue;
			try {
				await inject(tabId);
			} catch (error) {
				swLog.warn(`[Upgrade] Tab ${tabId} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}));
}

// Active tabs are refreshed first. Background work is a bounded, awaited queue:
// no delayed timer is left behind for an MV3 worker suspension to discard.
export async function refreshTabsForUpgrade(
	tabs: UpgradeTab[],
	inject: TabInjector = injectWithTransition,
): Promise<void> {
	const activeTabIds: number[] = [];
	const backgroundTabIds: number[] = [];
	for (const tab of tabs) {
		if (tab.id === undefined) continue;
		(tab.active ? activeTabIds : backgroundTabIds).push(tab.id);
	}
	await injectBounded(activeTabIds, inject);
	await injectBounded(backgroundTabIds, inject);
}

export async function performWarmUpdate(): Promise<void> {
	if (!chrome.scripting?.executeScript) {
		swLog.error('[Upgrade] chrome.scripting unavailable — missing "scripting" permission');
		return;
	}

	swLog.info('[Upgrade] Starting zero-refresh transition...');

	const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
	if (tabs.length === 0) {
		swLog.info('[Upgrade] No target tabs found');
		return;
	}

	const activeTabs = tabs.filter(tab => tab.active && tab.id !== undefined);

	swLog.info(`[Upgrade] ${tabs.length} tabs (${activeTabs.length} active)`);
	await refreshTabsForUpgrade(tabs);
}

// eff: re-injects content + injector into a single tab, with graceful teardown of prior instance
async function injectWithTransition(tabId: number): Promise<void> {
	try {
		let hasOldInstance = false;
		try {
			const r = await chrome.scripting.executeScript({
				target: { tabId },
				func: () => {
					const pageWindow = window as Window & { __SPECTRA_TEARDOWN__?: () => void };
					return typeof pageWindow.__SPECTRA_TEARDOWN__ === 'function';
				},
			});
			hasOldInstance = r?.[0]?.result === true;
		} catch { /* page may block script execution */ }

		if (hasOldInstance) {
			swLog.debug(`[Upgrade] Tab ${tabId}: tearing down old instance`);
			await chrome.scripting.executeScript({
				target: { tabId },
				func: () => {
					const pageWindow = window as Window & { __SPECTRA_TEARDOWN__?: () => void };
					if (typeof pageWindow.__SPECTRA_TEARDOWN__ === 'function') {
						pageWindow.__SPECTRA_TEARDOWN__();
						delete pageWindow.__SPECTRA_TEARDOWN__;
					}
				},
			});
		}

		await injectMainBridges(tabId);
		await injectMainBootstrap(tabId);

		if (hasOldInstance) {
			const capability = 'warm-update';
			const ready = await ensureContentRuntime(tabId, undefined, 'restore', capability);
			releaseContentRuntimeLease(tabId, ready.documentId, 'restore', capability);
		}

		swLog.debug(`[Upgrade] Tab ${tabId}: transition complete`);
	} catch (e) {
		swLog.warn(`[Upgrade] Tab ${tabId} failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// eff: on-demand injection triggered by popup when content script is unreachable
export async function injectContentScriptOnDemand(tabId: number): Promise<boolean> {
	if (!chrome.scripting?.executeScript) return false;

	try {
		await injectMainBridges(tabId);
		await injectMainBootstrap(tabId);
		return true;
	} catch (e) {
		swLog.warn(`[OnDemand] Tab ${tabId} injection failed: ${e instanceof Error ? e.message : String(e)}`);
		return false;
	}
}
