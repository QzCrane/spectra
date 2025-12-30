// goal: manages the offscreen document lifecycle for PeerJS remote control connectivity
// note: acts as a bridge between the remote controller (mobile) and specific browser tabs

import { Actions } from '@nexus/contracts';
import { executeCommand, setStateCallback, type RemoteCommand, type RemoteState } from './remote-commands';

const LOG = '[SPECTRA Remote BG]';
let offscreenCreated = false;

// eff: creates the offscreen document if it doesn't exist, using 'WEB_RTC' for PeerJS data channels
async function ensureOffscreen(): Promise<void> {
	if (offscreenCreated) return;

	try {
		const contexts = await (chrome.runtime as any).getContexts({
			contextTypes: ['OFFSCREEN_DOCUMENT'],
			documentUrls: [chrome.runtime.getURL('offscreen-remote.html')],
		});

		if (contexts && contexts.length > 0) {
			offscreenCreated = true;
			return;
		}
	} catch { }

	await chrome.offscreen.createDocument({
		url: 'offscreen-remote.html',
		reasons: ['WEB_RTC'] as any,
		justification: 'PeerJS WebRTC for remote control',
	});

	offscreenCreated = true;
	console.log(LOG, 'Offscreen created');
}

// eff: closes the offscreen document and resets the singleton flag
async function closeOffscreen(): Promise<void> {
	if (!offscreenCreated) return;
	try {
		await chrome.offscreen.closeDocument();
		offscreenCreated = false;
	} catch { }
}

// eff: pushes unified RemoteState to the offscreen worker for mobile sync
function sendStateToOffscreen(tabId: number, state: RemoteState): void {
	if (offscreenCreated) {
		chrome.runtime.sendMessage({ type: 'REMOTE_OFFSCREEN_SEND_STATE', tabId, state });
	}
}

// eff: registers listeners for remote session lifecycle (create, status, close) and command execution
export function initRemoteService(): void {
	setStateCallback(sendStateToOffscreen);

	chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
		if (message.action === Actions.REMOTE_CREATE_SESSION) {
			const tabId = message.tabId || sender.tab?.id;
			if (!tabId) {
				sendResponse({ success: false, error: 'No tabId' });
				return false;
			}

			ensureOffscreen()
				.then(() => chrome.runtime.sendMessage({ type: 'REMOTE_OFFSCREEN_CREATE', tabId }))
				.then((res) => sendResponse(res))
				.catch((e) => sendResponse({ success: false, error: e.message }));
			return true;
		}

		if (message.action === Actions.REMOTE_GET_SESSION) {
			if (!offscreenCreated) {
				sendResponse({ session: null, connected: false });
				return false;
			}
			const tabId = message.tabId || sender.tab?.id;
			chrome.runtime.sendMessage({ type: 'REMOTE_OFFSCREEN_GET_STATUS', tabId })
				.then((res) => sendResponse(res))
				.catch(() => sendResponse({ session: null, connected: false }));
			return true;
		}

		if (message.action === Actions.REMOTE_CLOSE_SESSION) {
			if (!offscreenCreated) {
				sendResponse({ success: true });
				return false;
			}
			chrome.runtime.sendMessage({ type: 'REMOTE_OFFSCREEN_CLOSE' })
				.then(() => closeOffscreen())
				.then(() => sendResponse({ success: true }))
				.catch(() => sendResponse({ success: true }));
			return true;
		}

		if (message.type === 'REMOTE_EXECUTE_COMMAND') {
			const { command, tabId } = message as { command: RemoteCommand; tabId: number };
			executeCommand(command, tabId);
			return false;
		}

		if (message.type === 'REMOTE_REQUEST_SYNC') {
			const { tabId } = message as { tabId?: number };
			if (tabId) {
				import('./remote-commands').then(m => m.syncState(tabId));
			}
			return false;
		}

		return false;
	});

	console.log(LOG, 'Service initialized');
}
