// goal: sole owner of MAIN world content-script injection for fullscreen and exact-element page-media bridges

import { swLog } from '../shared/logger';

let initialized = false;

export function initializeMainRuntimeManager(): void {
	if (initialized) return;
	initialized = true;
	swLog.debug('[MAIN] exact-element page-media bridge manager initialized');
}

export const MAIN_WORLD_CONTENT_FILES = [
	'content-fullscreen-bridge.js',
	'content-page-media-bridge.js',
] as const;

export async function injectMainBridges(tabId: number): Promise<void> {
	await chrome.scripting.executeScript({
		target: { tabId },
		files: ['content-fullscreen-bridge.js'],
		world: 'MAIN',
	});
	await chrome.scripting.executeScript({
		target: { tabId },
		files: ['content-page-media-bridge.js'],
		world: 'MAIN',
	});
}

export async function injectMainBootstrap(tabId: number): Promise<void> {
	await chrome.scripting.executeScript({
		target: { tabId },
		files: ['content-bootstrap.js'],
		world: 'ISOLATED',
	});
}
