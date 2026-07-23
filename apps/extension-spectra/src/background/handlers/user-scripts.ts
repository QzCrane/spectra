// goal: handles execution of user-defined scripts via chrome.userScripts API
// note: provides a secure alternative to eval() for custom JS functionality

import {
	SPECTRA_PROTOCOL_VERSION,
	isSpectraRequestEnvelope,
	rpcFailure,
	rpcSuccess,
} from '@nexus/contracts';
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

// eff: configures the isolated USER_SCRIPT sandbox only for a real execution
async function initUserScriptsWorld(): Promise<void> {
	await chrome.userScripts.configureWorld({
		csp: "script-src 'self' 'unsafe-inline'",
	});
	swLog.debug('UserScripts world configured');
}

let userScriptsWorldReady: Promise<void> | null = null;

async function ensureUserScriptsWorld(): Promise<void> {
	userScriptsWorldReady ??= initUserScriptsWorld();
	try {
		await userScriptsWorldReady;
	} catch (error) {
		userScriptsWorldReady = null;
		throw error;
	}
}

function isExecutableUserScript(script: unknown): script is string {
	return typeof script === 'string' && script.length > 0 && script.length <= 100_000;
}

// eff: executes user-provided script in the target tab's USER_SCRIPT sandbox
export async function executeUserScriptInTab(
	tabId: number,
	documentId: string,
	script: string,
): Promise<{ success: boolean; error?: string }> {
	if (!Number.isSafeInteger(tabId) || tabId <= 0
		|| typeof documentId !== 'string' || documentId.length === 0 || documentId.length > 256
		|| !isExecutableUserScript(script)) {
		return { success: false, error: 'Invalid user script request' };
	}
	const available = await isUserScriptsAvailable();
	if (!available) {
		return {
			success: false,
			error: 'userScripts API not enabled. Please enable "Allow User Scripts" in extension settings.',
		};
	}

	try {
		await ensureUserScriptsWorld();
		const before = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
		if (before?.documentId !== documentId) {
			return { success: false, error: 'User script target document is stale' };
		}
		const results = await chrome.userScripts.execute({
			target: { tabId, documentIds: [documentId] },
			js: [{ code: script }],
			world: 'USER_SCRIPT',
			injectImmediately: true,
		});
		if (results.length !== 1 || results[0]?.documentId !== documentId) {
			return { success: false, error: 'User script result came from a stale document' };
		}
		const after = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
		if (after?.documentId !== documentId) {
			return { success: false, error: 'User script document navigated before acknowledgement' };
		}
		return { success: true };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		swLog.error('UserScript execution failed:', message);
		return { success: false, error: message };
	}
}

// eff: registers handler for USER_SCRIPT_EXECUTE messages from content script
export function registerUserScriptsHandler(): void {
	chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
		if (!isRecord(message)
			|| message.protocolVersion !== SPECTRA_PROTOCOL_VERSION
			|| message.type !== 'spectra.user-script.execute') return false;
		if (sender.id !== chrome.runtime.id || !sender.tab?.id || !sender.documentId) {
			sendResponse(rpcFailure('forbidden', 'User scripts require an extension content-script context'));
			return false;
		}
		if (!isSpectraRequestEnvelope(message)) {
			sendResponse(rpcFailure('invalid_request', 'Malformed SPECTRA v2 user-script request'));
			return false;
		}
		if (message.type !== 'spectra.user-script.execute') return false;
		void executeUserScriptInTab(sender.tab.id, sender.documentId, message.payload.script)
			.then((result) => {
				sendResponse(result.success
					? rpcSuccess({ executed: true as const })
					: rpcFailure('user_script_failed', result.error ?? 'Script execution failed'));
			})
			.catch((error: unknown) => {
				sendResponse(rpcFailure(
					'user_script_unavailable',
					error instanceof Error ? error.message : String(error),
					true,
				));
			});
		return true;
	});

	router.on('USER_SCRIPT_EXECUTE', async (req, sender) => {
		const tabId = sender.tab?.id;
		if (!tabId || !sender.documentId) {
			return { success: false, error: 'No tab context' };
		}
		if (!isExecutableUserScript(req.script)) {
			return { success: false, error: 'No script provided' };
		}
		return executeUserScriptInTab(tabId, sender.documentId, req.script);
	});

	swLog.debug('UserScripts handler registered');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
