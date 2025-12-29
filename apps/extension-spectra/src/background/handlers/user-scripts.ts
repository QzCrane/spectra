// goal: handles execution of user-defined scripts via chrome.userScripts API
// note: provides a secure alternative to eval() for custom JS functionality

import { router } from '../state';
import { swLog } from '../../shared/logger';

// eff: checks if userScripts API is available and enabled by user
async function isUserScriptsAvailable(): Promise<boolean> {
	try {
		await chrome.userScripts.getScripts();
		return true;
	} catch {
		return false;
	}
}

// eff: configures the USER_SCRIPT world to allow eval-like functionality
async function initUserScriptsWorld(): Promise<void> {
	try {
		await chrome.userScripts.configureWorld({
			csp: "script-src 'self' 'unsafe-inline'",
		});
		swLog.debug('UserScripts world configured');
	} catch (e) {
		swLog.warn('Failed to configure userScripts world:', e);
	}
}

// eff: executes user-provided script in the target tab's MAIN world
async function executeUserScript(tabId: number, script: string): Promise<{ success: boolean; error?: string }> {
	const available = await isUserScriptsAvailable();
	if (!available) {
		return {
			success: false,
			error: 'userScripts API not enabled. Please enable "Allow User Scripts" in extension settings.',
		};
	}

	try {
		await chrome.userScripts.execute({
			target: { tabId },
			js: [{ code: script }],
			world: 'MAIN',
			injectImmediately: true,
		});
		return { success: true };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		swLog.error('UserScript execution failed:', message);
		return { success: false, error: message };
	}
}

// eff: registers handler for USER_SCRIPT_EXECUTE messages from content script
export function registerUserScriptsHandler(): void {
	// note: ensure world is configured on startup
	initUserScriptsWorld();

	router.on('USER_SCRIPT_EXECUTE', async (req, sender) => {
		const tabId = sender.tab?.id;
		if (!tabId) {
			return { success: false, error: 'No tab context' };
		}
		if (!req.script) {
			return { success: false, error: 'No script provided' };
		}
		return executeUserScript(tabId, req.script);
	});

	swLog.debug('UserScripts handler registered');
}
