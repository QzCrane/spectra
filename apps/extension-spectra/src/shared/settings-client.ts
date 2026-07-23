// goal: revision-aware client for the background-owned settings repository

import {
	type RpcResult,
	type SettingsPatch,
	type SettingsPatchRequest,
	type SettingsSnapshot,
} from '@nexus/contracts';
import { isSpectraSettingsUiEventEnvelope } from '@nexus/contracts/ui-settings-runtime';
import { sendSettingsUiRequest } from './ui-settings-spectra-client';

let cachedSnapshot: SettingsSnapshot | null = null;
let patchQueue: Promise<void> = Promise.resolve();

export interface SettingsPatchRetryTransport {
	getSnapshot(forceRefresh?: boolean): Promise<SettingsSnapshot>;
	sendPatch(request: SettingsPatchRequest): Promise<RpcResult<SettingsSnapshot>>;
}

export async function getSettingsSnapshot(forceRefresh = false): Promise<SettingsSnapshot> {
	if (cachedSnapshot && !forceRefresh) return cachedSnapshot;
	const result = await sendSettingsUiRequest('spectra.settings.get', {});
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	cachedSnapshot = result.data;
	return result.data;
}

// post: replays only merge-safe field or intent mutations against the latest revision.
export async function applySettingsPatchWithRetry(
	patch: SettingsPatch,
	transport: SettingsPatchRetryTransport,
): Promise<SettingsSnapshot> {
	let snapshot = await transport.getSnapshot();
	const canReplayAfterConflict = patch.scope !== 'hotkey-site';
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const response = await transport.sendPatch({ expectedRevision: snapshot.revision, patch });
		if (response.ok) return response.data;
		if (response.error.code !== 'revision_conflict' || attempt > 0 || !canReplayAfterConflict) {
			throw new Error(`${response.error.code}: ${response.error.message}`);
		}
		snapshot = await transport.getSnapshot(true);
	}
	throw new Error('settings_unavailable: Settings patch retry exhausted');
}

// post: serializes same-page edits and retries one atomic intent after a cross-page revision conflict
export function patchSettings(patch: SettingsPatch): Promise<SettingsSnapshot> {
	let resolveResult!: (snapshot: SettingsSnapshot) => void;
	let rejectResult!: (error: unknown) => void;
	const result = new Promise<SettingsSnapshot>((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});

	patchQueue = patchQueue.then(async () => {
		try {
			const snapshot = await applySettingsPatchWithRetry(patch, {
				getSnapshot: getSettingsSnapshot,
				sendPatch: request => sendSettingsUiRequest('spectra.settings.patch', request),
			});
			cachedSnapshot = snapshot;
			resolveResult(snapshot);
		} catch (error) {
			rejectResult(error);
		}
	}, rejectResult);

	return result;
}

export function clearSettingsSnapshotCache(): void {
	cachedSnapshot = null;
}

export async function flushSettings(): Promise<void> {
	await patchQueue;
	const response = await sendSettingsUiRequest('spectra.settings.flush', {});
	if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
}

if (typeof window !== 'undefined') {
	const onSettingsChanged = (message: unknown): false => {
		if (isSpectraSettingsUiEventEnvelope(message)) {
			cachedSnapshot = message.payload;
		}
		return false;
	};
	chrome.runtime.onMessage.addListener(onSettingsChanged);
	window.addEventListener('pagehide', () => {
		chrome.runtime.onMessage.removeListener(onSettingsChanged);
		void flushSettings().catch(() => undefined);
	}, { once: true });
}
