// goal: handles legacy settings actions and the runtime-validated SPECTRA v2 RPC

import { router } from '../state';
import {
	Actions,
	SPECTRA_PROTOCOL_VERSION,
	isSpectraRequestEnvelope,
	rpcFailure,
	rpcSuccess,
	type SettingsSnapshot,
	type SettingsPatch,
	type SpectraEventEnvelope,
} from '@nexus/contracts';
import {
	InvalidSettingsPatchError,
	SettingsRevisionConflictError,
	settingsRepository,
} from '../settings-repository';
import { withContentOSDMessages } from '../../shared/i18n/content-osd';
import { updateShortcutSettings } from '../shortcuts';
import { reconcileAllHotkeyRuntimeLeases } from '../runtime-loader';

// note: one-release compatibility adapter for content contexts that were loaded
// before protocol v2. New callers and current content contexts never emit v1.
async function broadcastLegacyGlobalSettingsForOneRelease(
	tabId: number,
	settings: ReturnType<typeof withContentOSDMessages>,
): Promise<void> {
	await chrome.tabs.sendMessage(tabId, {
		action: Actions.GLOBAL_SETTINGS_UPDATE,
		settings,
	}).catch(() => undefined);
}

async function broadcastSettings(snapshot: SettingsSnapshot, scope: SettingsPatch['scope']): Promise<void> {
	const event: SpectraEventEnvelope<'spectra.settings.changed'> = {
		protocolVersion: SPECTRA_PROTOCOL_VERSION,
		type: 'spectra.settings.changed',
		payload: snapshot,
	};
	const extensionBroadcast = chrome.runtime.sendMessage(event).catch(() => undefined);
	const broadcasts: Array<Promise<unknown>> = [extensionBroadcast];
	if (scope === 'hotkey-slots' || scope === 'hotkey-site' || scope === 'hotkey-site-mutation') {
		updateShortcutSettings(snapshot.hotkeySettings);
		broadcasts.push(reconcileAllHotkeyRuntimeLeases(snapshot.hotkeySettings));
		const hotkeyEvent: SpectraEventEnvelope<'spectra.hotkeys.changed'> = {
			protocolVersion: SPECTRA_PROTOCOL_VERSION,
			type: 'spectra.hotkeys.changed',
			payload: snapshot.hotkeySettings,
		};
		const tabs = await chrome.tabs.query({});
		broadcasts.push(...tabs.map((tab) => (
			tab.id
				? chrome.tabs.sendMessage(tab.id, hotkeyEvent).catch(() => undefined)
				: Promise.resolve()
		)));
	}
	if (scope !== 'global') {
		await Promise.all(broadcasts);
		return;
	}
	const tabs = await chrome.tabs.query({});
	broadcasts.push(
		...tabs.map(async (tab) => {
			if (!tab.id) return;
			const settings = withContentOSDMessages(snapshot.globalSettings);
			const contentEvent: SpectraEventEnvelope<'spectra.content.settings.changed'> = {
				protocolVersion: SPECTRA_PROTOCOL_VERSION,
				type: 'spectra.content.settings.changed',
				payload: settings,
			};
			await Promise.all([
				chrome.tabs.sendMessage(tab.id, contentEvent).catch(() => undefined),
				broadcastLegacyGlobalSettingsForOneRelease(tab.id, settings),
			]);
		}),
	);
	await Promise.all(broadcasts);
}

function isAttemptedSettingsV2Message(message: unknown): boolean {
	if (!message || typeof message !== 'object') return false;
	const candidate = message as { protocolVersion?: unknown; type?: unknown };
	return candidate.protocolVersion === SPECTRA_PROTOCOL_VERSION
		&& (candidate.type === 'spectra.content.settings.get'
			|| candidate.type === 'spectra.settings.get'
			|| candidate.type === 'spectra.settings.patch'
			|| candidate.type === 'spectra.settings.flush'
			|| candidate.type === 'spectra.hotkeys.get');
}

function registerV2SettingsListener(): void {
	chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
		if (!isAttemptedSettingsV2Message(message)) return false;
		if (sender.id && sender.id !== chrome.runtime.id) {
			sendResponse(rpcFailure('forbidden', 'Settings RPC is extension-internal only'));
			return false;
		}
		if (!isSpectraRequestEnvelope(message)) {
			sendResponse(rpcFailure('invalid_request', 'Malformed SPECTRA v2 settings request'));
			return false;
		}

		const operation = async () => {
			try {
				if (message.type === 'spectra.content.settings.get') {
					return rpcSuccess(withContentOSDMessages(
						(await settingsRepository.getSnapshot()).globalSettings,
					));
				}
				if (message.type === 'spectra.settings.get') {
					return rpcSuccess(await settingsRepository.getSnapshot());
				}
				if (message.type === 'spectra.hotkeys.get') {
					return rpcSuccess((await settingsRepository.getSnapshot()).hotkeySettings);
				}
				if (message.type === 'spectra.settings.patch') {
					const payload = message.payload;
					const snapshot = await settingsRepository.applyPatch(
						payload.patch,
						payload.expectedRevision,
					);
					if (payload.patch.scope === 'legacy-theme') {
						if (snapshot.revision !== payload.expectedRevision) {
							await broadcastSettings(snapshot, 'global');
						}
					} else {
						await broadcastSettings(snapshot, payload.patch.scope);
					}
					return rpcSuccess(snapshot);
				}
				if (message.type === 'spectra.settings.flush') {
					await settingsRepository.flush();
					return rpcSuccess({ flushed: true as const });
				}
				return rpcFailure('unsupported_request', 'No settings handler for this request');
			} catch (error) {
				if (error instanceof SettingsRevisionConflictError) {
					return rpcFailure('revision_conflict', error.message, true);
				}
				if (error instanceof InvalidSettingsPatchError) {
					return rpcFailure('invalid_patch', error.message);
				}
				const messageText = error instanceof Error ? error.message : String(error);
				return rpcFailure('settings_unavailable', messageText, true);
			}
		};

		operation()
			.then(sendResponse)
			.catch((error) => sendResponse(rpcFailure('settings_unavailable', error instanceof Error ? error.message : String(error))));
		return true;
	});
}

// eff: registers listeners for SETTINGS_GET and SETTINGS_UPDATE actions
export function registerSettingsHandlers(): void {
	void settingsRepository.initialize();
	registerV2SettingsListener();

	router.on('SETTINGS_GET', async () => {
		return withContentOSDMessages((await settingsRepository.getSnapshot()).globalSettings);
	});

	router.on('SETTINGS_UPDATE', async (req) => {
		const snapshot = await settingsRepository.applyPatch({ scope: 'global', changes: req.settings });
		await broadcastSettings(snapshot, 'global');
		return { success: true };
	});
}

