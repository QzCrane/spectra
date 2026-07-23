// goal: single MV3 offscreen host entrypoint; audio and remote controllers share this document

import {
	isOffscreenHostRequest,
	type OffscreenHostWireRequest,
	type RemoteHostRequest,
} from '@nexus/contracts';
import { describeAudioHost, destroyAudioHost, handleAudioHostMessage } from './audio-host';
import { createRemoteHostController } from '../offscreen-remote/remote-host';

const remoteHost = createRemoteHostController();

function isTrustedBackgroundSender(sender: chrome.runtime.MessageSender): boolean {
	if (sender.id !== chrome.runtime.id || sender.tab) return false;
	return sender.url === undefined || sender.url === chrome.runtime.getURL('background.js');
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
	if (!isOffscreenHostRequest(message)) return false;
	if (!isTrustedBackgroundSender(sender)) {
		sendResponse({ success: false, error: 'FORBIDDEN' });
		return false;
	}

	if (message.type === 'OFFSCREEN_HOST_HELLO') {
		sendResponse({
			audioTabs: describeAudioHost(),
			remoteTabs: remoteHost.describeSessions().map(({ tabId, sessionId }) => ({ tabId, sessionId })),
		});
		return false;
	}
	if (isRemoteHostRequest(message)) {
		return remoteHost.handleRuntimeMessage(message, sendResponse);
	}

	void handleAudioHostMessage(message)
		.then(sendResponse)
		.catch((error) => sendResponse({
			success: false,
			error: error instanceof Error ? error.message : String(error),
		}));
	return true;
});

function isRemoteHostRequest(
	request: OffscreenHostWireRequest,
): request is RemoteHostRequest & { target: 'offscreen' } {
	return request.type.startsWith('REMOTE_HOST_');
}

window.addEventListener('pagehide', () => {
	void Promise.all([destroyAudioHost(), remoteHost.destroy()]);
}, { once: true });
