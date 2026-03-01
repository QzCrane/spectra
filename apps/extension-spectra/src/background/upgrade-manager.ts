// goal: coordinates zero-refresh update by re-injecting content scripts into all matching tabs
// pre: requires "scripting" permission in manifest.json

import { swLog } from '../shared/logger';
import { tabAudioStates } from './state';

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

	const activeTabs = tabs.filter(t => t.active && t.id);
	const backgroundTabs = tabs.filter(t => !t.active && t.id);

	swLog.info(`[Upgrade] ${tabs.length} tabs (${activeTabs.length} active)`);

	for (const tab of activeTabs) {
		if (tab.id) await injectWithTransition(tab.id);
	}

	for (let i = 0; i < backgroundTabs.length; i++) {
		const tid = backgroundTabs[i]?.id;
		if (!tid) continue;
		setTimeout(() => { injectWithTransition(tid).catch(() => { }); }, 500 * (i + 1));
	}
}

// eff: re-injects content + injector into a single tab, with graceful teardown of prior instance
async function injectWithTransition(tabId: number): Promise<void> {
	try {
		let hasOldInstance = false;
		try {
			const r = await chrome.scripting.executeScript({
				target: { tabId },
				func: () => !!(window as any).__SPECTRA_TEARDOWN__
			});
			hasOldInstance = r?.[0]?.result === true;
		} catch { /* page may block script execution */ }

		if (hasOldInstance) {
			swLog.debug(`[Upgrade] Tab ${tabId}: tearing down old instance`);
			await chrome.scripting.executeScript({
				target: { tabId },
				func: () => {
					if ((window as any).__SPECTRA_TEARDOWN__) {
						(window as any).__SPECTRA_TEARDOWN__();
						delete (window as any).__SPECTRA_TEARDOWN__;
					}
				}
			});
			await new Promise(r => setTimeout(r, 200));
		}

		// inv: injector.js MUST run before content.js (playbackRate hijack setup)
		await chrome.scripting.executeScript({
			target: { tabId },
			files: ['injector.js'],
			world: 'MAIN'
		});

		await chrome.scripting.executeScript({
			target: { tabId },
			files: ['content.js']
		});

		await new Promise(r => setTimeout(r, 300));

		const existing = tabAudioStates.get(tabId);
		tabAudioStates.set(tabId, {
			hasMediaElement: true,
			lastAudibleTime: existing?.lastAudibleTime ?? 0,
			lastActivatedTime: Date.now(),
			userManuallyActivated: true,
		});

		swLog.debug(`[Upgrade] Tab ${tabId}: transition complete`);
	} catch (e) {
		swLog.warn(`[Upgrade] Tab ${tabId} failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// eff: on-demand injection triggered by popup when content script is unreachable
export async function injectContentScriptOnDemand(tabId: number): Promise<boolean> {
	if (!chrome.scripting?.executeScript) return false;

	try {
		await chrome.scripting.executeScript({
			target: { tabId },
			files: ['injector.js'],
			world: 'MAIN'
		});
		await chrome.scripting.executeScript({
			target: { tabId },
			files: ['content.js']
		});
		return true;
	} catch (e) {
		swLog.warn(`[OnDemand] Tab ${tabId} injection failed: ${e instanceof Error ? e.message : String(e)}`);
		return false;
	}
}
