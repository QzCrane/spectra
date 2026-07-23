// goal: provide one validated owner for tab and extension-view hotkey commands

import {
	Actions,
	SPECTRA_PROTOCOL_VERSION,
	isSpectraRequestEnvelope,
	rpcFailure,
	rpcSuccess,
} from '@nexus/contracts';
import { router } from '../state';
import { submitControlRequest } from '../control-coordinator';

const COMMAND_REQUEST_TYPES: ReadonlySet<string> = new Set([
	'spectra.tab.pinned.toggle',
	'spectra.tab.muted.toggle',
	'spectra.ui.open',
] as const);

async function togglePinned(tabId: number): Promise<{ pinned: boolean }> {
	const ack = await submitControlRequest({
		tabId,
		source: 'hotkey',
		requestedCoverage: 'full',
		target: null,
		mutations: [{ field: 'tabPinned', operation: 'toggle' }],
	});
	const pinned = ack.fields.tabPinned?.actual;
	if (typeof pinned !== 'boolean') throw new Error('Tab pin did not return an actual state');
	return { pinned };
}

async function toggleMuted(tabId: number): Promise<{ muted: boolean }> {
	const ack = await submitControlRequest({
		tabId,
		source: 'hotkey',
		requestedCoverage: 'full',
		target: null,
		mutations: [{ field: 'tabMuted', operation: 'toggle' }],
	});
	const muted = ack.fields.tabMuted?.actual;
	if (typeof muted !== 'boolean') throw new Error('Tab mute did not return an actual state');
	return { muted };
}

async function openView(view: 'options' | 'popup', windowId?: number): Promise<{ opened: true }> {
	if (view === 'options') {
		await chrome.runtime.openOptionsPage();
	} else {
		await chrome.action.openPopup(windowId === undefined ? {} : { windowId });
	}
	return { opened: true };
}

function registerCommandsV2Listener(): void {
	chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
		if (!message || typeof message !== 'object') return false;
		const candidate = message as { protocolVersion?: unknown; type?: unknown };
		if (candidate.protocolVersion !== SPECTRA_PROTOCOL_VERSION
			|| typeof candidate.type !== 'string'
			|| !COMMAND_REQUEST_TYPES.has(candidate.type)) return false;
		if (sender.id && sender.id !== chrome.runtime.id) {
			sendResponse(rpcFailure('forbidden', 'Command RPC is extension-internal only'));
			return false;
		}
		if (!isSpectraRequestEnvelope(message)
			|| (message.type !== 'spectra.tab.pinned.toggle'
				&& message.type !== 'spectra.tab.muted.toggle'
				&& message.type !== 'spectra.ui.open')) {
			sendResponse(rpcFailure('invalid_request', 'Malformed extension command'));
			return false;
		}

		const operation = async () => {
			if (message.type === 'spectra.ui.open') return openView(message.payload.view, sender.tab?.windowId);
			const tabId = sender.tab?.id;
			if (!tabId || (message.tabId !== undefined && message.tabId !== tabId)) {
				throw new Error('Tab command requires its content-script tab');
			}
			return message.type === 'spectra.tab.pinned.toggle'
				? togglePinned(tabId)
				: toggleMuted(tabId);
		};

		void operation()
			.then((result) => sendResponse(rpcSuccess(result)))
			.catch((error) => sendResponse(rpcFailure(
				'command_failed',
				error instanceof Error ? error.message : String(error),
				true,
			)));
		return true;
	});
}

export function registerCommandHandlers(): void {
	registerCommandsV2Listener();

	// note: one-release v1 adapters delegate to the same implementation
	router.on(Actions.TAB_PIN, async (_, sender) => {
		if (!sender.tab?.id) throw new Error('Tab pin requires a content-script tab');
		return togglePinned(sender.tab.id);
	});
	router.on(Actions.TAB_MUTE, async (_, sender) => {
		if (!sender.tab?.id) throw new Error('Tab mute requires a content-script tab');
		return toggleMuted(sender.tab.id);
	});
	router.on(Actions.OPEN_OPTIONS, (_, sender) => openView('options', sender.tab?.windowId));
	router.on(Actions.OPEN_POPUP, (_, sender) => openView('popup', sender.tab?.windowId));
}
