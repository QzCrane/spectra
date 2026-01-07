// goal: utility functions for background service worker operations

import { swLog } from '../shared/logger';

// post: returns true if the tab exists and is accessible
export async function isTabExists(tabId: number): Promise<boolean> {
	try {
		await chrome.tabs.get(tabId);
		return true;
	} catch {
		return false;
	}
}

// eff: ensures the offscreen document is created for high-fidelity audio processing
export async function ensureOffscreen(): Promise<void> {
	const has = await chrome.offscreen.hasDocument();
	if (!has) {
		swLog.debug('Creating offscreen document...');
		await chrome.offscreen.createDocument({
			url: 'offscreen.html',
			reasons: ['USER_MEDIA'] as chrome.offscreen.Reason[],
			justification: 'Audio processing and visualizer'
		});
		swLog.debug('Offscreen document created');
	}
}

// eff: terminates the offscreen document to free up resources
export async function closeOffscreen(): Promise<void> {
	const has = await chrome.offscreen.hasDocument();
	if (has) {
		swLog.debug('Closing offscreen document...');
		await chrome.offscreen.closeDocument();
		swLog.debug('Offscreen document closed');
	}
}
