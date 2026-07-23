// goal: handles global chrome keyboard shortcuts (manifest commands and custom slots)
// rule: standard commands are mapped directly; custom slots (slot_1-16) use user-defined mappings

import type {
	ControlMutation,
	HotkeySettings,
	HotkeyAction,
	SpectraEventEnvelope,
	SpectraHotkeyActualFeedback,
} from '@nexus/contracts';
import {
	compileEffectiveVolume,
	DEFAULT_HOTKEY_SETTINGS,
	DEFAULT_SLOTS,
	HOTKEY_ACTION_DESCRIPTORS,
	SPECTRA_PROTOCOL_VERSION,
	isSlotHotkeyAction,
} from '@nexus/contracts';
import { swLog } from '../shared/logger';
import { settingsRepository } from './settings-repository';
import { hotkeyTargetRepository } from './hotkey-target-repository';
import {
	getControlViewSnapshot,
	submitExtensionInvokedControlOperation,
	submitExtensionInvokedControlRequest,
} from './control-coordinator';
import { ensureContentRuntime, releaseContentRuntimeLease } from './runtime-loader';

// slotMapping: active mapping of manifest slot IDs to functional hotkey actions
let slotMapping: Record<string, HotkeyAction> = { ...DEFAULT_HOTKEY_SETTINGS.slots };

export interface ShortcutRuntimePort {
	ensure(tabId: number, capability: string): Promise<{ documentId: string }>;
	release(tabId: number, documentId: string, capability: string): void;
}

const shortcutRuntimePort: ShortcutRuntimePort = {
	ensure: (tabId, capability) => ensureContentRuntime(tabId, undefined, 'hotkey', capability),
	release: (tabId, documentId, capability) => {
		releaseContentRuntimeLease(tabId, documentId, 'hotkey', capability);
	},
};

// Every Chrome command is valid on a fresh document, independently from Popup
// observation and from whether that site also has a custom page binding.
export async function runWithShortcutRuntime<T>(
	tabId: number,
	operation: () => Promise<T>,
	port: ShortcutRuntimePort = shortcutRuntimePort,
): Promise<T> {
	const capability = `command:${crypto.randomUUID()}`;
	const ready = await port.ensure(tabId, capability);
	try {
		return await operation();
	} finally {
		port.release(tabId, ready.documentId, capability);
	}
}


// eff: synchronizes slotMapping from the background-owned settings repository
async function loadSlotMapping(): Promise<void> {
	try {
		updateShortcutSettings((await settingsRepository.getSnapshot()).hotkeySettings);
	} catch { }
}

export function updateShortcutSettings(settings: HotkeySettings): void {
	slotMapping = Object.fromEntries(
		Object.entries(settings.slots).filter(([, action]) => isSlotHotkeyAction(action)),
	);
}

// eff: initializes global listeners for chrome.commands and repository-backed hotkey updates
export function setupShortcutListeners(): void {
	void loadSlotMapping();

	chrome.commands.onCommand.addListener(async (command) => {
		swLog.debug(`Shortcut command: ${command}`);

		const route = await resolveShortcutTarget();
		if (!route) return;
		const tab = route.target;
		if (!tab?.id || !tab.url) return;
		const tabId = tab.id;

		let domain = '';
		try {
			domain = new URL(tab.url).hostname;
		} catch {
			return;
		}

		let action: HotkeyAction | undefined;
		if (command.startsWith('slot_')) {
			action = slotMapping[command];
			if (!action || action === 'none') return;
		} else {
			action = resolveDirectCommand(command);
		}

		if (!action) return;

		try {
			await runWithShortcutRuntime(tabId, () => executeAction(action, tabId, domain));
		} catch (error) {
			swLog.warn(`Shortcut ${action} failed`, error);
			return;
		}
		if (route.active?.id !== undefined && route.active.id !== tabId) {
			const feedback = await readShortcutActualFeedback(action, tabId);
			await notifyAlternateShortcutTarget(route.active, tab, action, domain, feedback);
		}
	});

	chrome.tabs.onRemoved.addListener((tabId) => {
		void clearRemovedShortcutTarget(tabId);
	});
}

interface ShortcutRoute {
	target: chrome.tabs.Tab;
	active: chrome.tabs.Tab | undefined;
}

async function resolveShortcutTarget(): Promise<ShortcutRoute | undefined> {
	const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
	const active = tabs[0];
	// rule: only chrome:// and http(s):// origins receive coordinated shortcuts
	const activeTab = active?.url && /^https?:/u.test(active.url) ? active : undefined;
	const { tabId: targetId } = await hotkeyTargetRepository.get();
	if (targetId !== null) {
		try {
			const target = await chrome.tabs.get(targetId);
			if (target.url && /^https?:/u.test(target.url)) return { target, active: activeTab };
		} catch {
			await hotkeyTargetRepository.clearIfMatches(targetId);
		}
	}
	return activeTab ? { target: activeTab, active: activeTab } : undefined;
}

async function notifyAlternateShortcutTarget(
	active: chrome.tabs.Tab,
	target: chrome.tabs.Tab,
	action: HotkeyAction,
	targetHostname: string,
	feedback?: SpectraHotkeyActualFeedback,
): Promise<void> {
	if (active.id === undefined || target.id === undefined) return;
	const capability = 'alternate-target-feedback';
	let documentId: string | null = null;
	try {
		const initialFrame = await chrome.webNavigation.getFrame({ tabId: active.id, frameId: 0 });
		if (!initialFrame?.documentId) return;
		const ready = await ensureContentRuntime(active.id, initialFrame.documentId, 'hotkey', capability);
		documentId = ready.documentId;
		const currentFrame = await chrome.webNavigation.getFrame({ tabId: active.id, frameId: 0 });
		if (currentFrame?.documentId !== ready.documentId) return;
		const event: SpectraEventEnvelope<'spectra.hotkey.target.feedback'> = {
			protocolVersion: SPECTRA_PROTOCOL_VERSION,
			type: 'spectra.hotkey.target.feedback',
			tabId: active.id,
			documentId: ready.documentId,
			payload: {
				action,
				targetTabId: target.id,
				targetTitle: target.title?.trim() || targetHostname,
				targetHostname,
				...(feedback ? { feedback } : {}),
			},
		};
		await chrome.tabs.sendMessage(active.id, event, { documentId: ready.documentId });
	} catch (error) {
		swLog.debug(`Alternate shortcut feedback was unavailable: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		if (documentId) {
			releaseContentRuntimeLease(active.id, documentId, 'hotkey', capability);
		}
	}
}

async function readShortcutActualFeedback(
	action: HotkeyAction,
	tabId: number,
): Promise<SpectraHotkeyActualFeedback | undefined> {
	if (HOTKEY_ACTION_DESCRIPTORS[action].feedbackOwner !== 'actual-osd') return undefined;
	const snapshot = await getControlViewSnapshot(tabId).catch(() => null);
	if (!snapshot) return undefined;
	if (action.startsWith('speed_')) {
		const speed = snapshot.fields.speed?.actual;
		return typeof speed === 'number' ? { kind: 'speed', value: speed } : undefined;
	}
	const volumeBase = snapshot.fields.volumeBase?.actual;
	const boost = snapshot.fields.boost?.actual;
	if (typeof volumeBase !== 'number' || typeof boost !== 'number') return undefined;
	return {
		kind: 'volume',
		value: compileEffectiveVolume(volumeBase, boost),
		muted: snapshot.fields.mediaMuted?.actual === true,
		capture: snapshot.fields.volumeBase?.strategy === 'capture'
			|| snapshot.fields.boost?.strategy === 'capture',
	};
}

async function clearRemovedShortcutTarget(tabId: number): Promise<void> {
	await hotkeyTargetRepository.clearIfMatches(tabId);
}

// goal: maps literal manifest command names to unified HotkeyActions
export function resolveDirectCommand(command: string): HotkeyAction | undefined {
	return DEFAULT_SLOTS[command];
}

const FULL_OUTPUT_FIELDS = new Set<ControlMutation['field']>([
	'boost', 'eqValues', 'bass', 'compressor', 'mono', 'pan', 'delay', 'tabMuted', 'tabPinned',
]);

async function submitMutations(tabId: number, mutations: ControlMutation[]): Promise<void> {
	for (const requestedCoverage of ['active-target', 'full'] as const) {
		const selected = mutations.filter((mutation) =>
			FULL_OUTPUT_FIELDS.has(mutation.field) === (requestedCoverage === 'full'));
		if (selected.length === 0) continue;
		const acknowledgement = await submitExtensionInvokedControlRequest({
			tabId,
			source: 'hotkey',
			requestedCoverage,
			target: null,
			mutations: selected,
		});
		const failure = Object.values(acknowledgement.fields)
			.find((field) => field?.phase !== 'applied');
		if (failure) throw new Error(failure.lastError?.message ?? 'Shortcut control was not applied');
	}
}

// eff: translates Chrome commands directly into the same coordinator protocol
// used by Popup, page hotkeys and authenticated remote controls.
async function executeAction(action: HotkeyAction, tabId: number, _domain: string): Promise<void> {
	const operation = async (
			type: Parameters<typeof submitExtensionInvokedControlOperation>[0]['operation'],
			payload: Parameters<typeof submitExtensionInvokedControlOperation>[0]['payload'] = {},
		) => submitExtensionInvokedControlOperation({
			tabId,
			source: 'hotkey',
			target: null,
			operation: type,
			payload,
		} as Parameters<typeof submitExtensionInvokedControlOperation>[0]);
		switch (action) {
			case 'none':
			case 'pitch_up':
			case 'pitch_down':
			case 'pitch_reset':
			case 'capture_toggle':
			case 'run_js':
			case 'open_url': return;
			case 'play_pause': await operation('playback-toggle'); return;
			case 'seek_forward_5s': await operation('seek-relative', { delta: 5 }); return;
			case 'seek_forward_10s': await operation('seek-relative', { delta: 10 }); return;
			case 'seek_forward_30s': await operation('seek-relative', { delta: 30 }); return;
			case 'seek_backward_5s': await operation('seek-relative', { delta: -5 }); return;
			case 'seek_backward_10s': await operation('seek-relative', { delta: -10 }); return;
			case 'seek_backward_30s': await operation('seek-relative', { delta: -30 }); return;
			case 'seek_frame_forward': await operation('frame-step', { direction: 1 }); return;
			case 'seek_frame_backward': await operation('frame-step', { direction: -1 }); return;
			case 'audio_reset': await operation('audio-reset'); return;
			case 'screenshot': await operation('screenshot'); return;
			case 'marker_add': await operation('marker-add'); return;
			case 'marker_jump_prev': await operation('marker-jump-previous'); return;
			case 'marker_jump_next': await operation('marker-jump-next'); return;
			case 'ab_set_a': await operation('ab-set-a'); return;
			case 'ab_set_b': await operation('ab-set-b'); return;
			case 'ab_clear': await operation('ab-clear'); return;
			case 'ab_skip': await operation('ab-skip'); return;
			case 'fx_toggle': await operation('video-effects-toggle'); return;
			case 'fx_reset': await operation('video-effects-reset'); return;
			case 'show_info': await operation('show-info'); return;
			case 'open_popup': await operation('open-popup'); return;
			case 'open_options': await operation('open-options'); return;
			case 'speed_up': await submitMutations(tabId, [{ field: 'speed', operation: 'delta', value: 0.1 }]); return;
			case 'speed_down': await submitMutations(tabId, [{ field: 'speed', operation: 'delta', value: -0.1 }]); return;
			case 'speed_reset': await submitMutations(tabId, [{ field: 'speed', operation: 'set', value: 1 }]); return;
			case 'speed_set': return;
			case 'volume_up': await operation('effective-volume', { operation: 'delta', value: 10 }); return;
			case 'volume_down': await operation('effective-volume', { operation: 'delta', value: -10 }); return;
			case 'volume_mute': await submitMutations(tabId, [{ field: 'mediaMuted', operation: 'toggle' }]); return;
			case 'volume_set': return;
			case 'gain_up': await operation('effective-volume', { operation: 'delta', value: 10 }); return;
			case 'gain_down': await operation('effective-volume', { operation: 'delta', value: -10 }); return;
			case 'delay_up': await submitMutations(tabId, [{ field: 'delay', operation: 'delta', value: 10 }]); return;
			case 'delay_down': await submitMutations(tabId, [{ field: 'delay', operation: 'delta', value: -10 }]); return;
			case 'delay_reset': await submitMutations(tabId, [{ field: 'delay', operation: 'set', value: 0 }]); return;
			case 'pan_left': await submitMutations(tabId, [{ field: 'pan', operation: 'delta', value: -0.1 }]); return;
			case 'pan_right': await submitMutations(tabId, [{ field: 'pan', operation: 'delta', value: 0.1 }]); return;
			case 'pan_reset': await submitMutations(tabId, [{ field: 'pan', operation: 'set', value: 0 }]); return;
			case 'mono_toggle': await submitMutations(tabId, [{ field: 'mono', operation: 'toggle' }]); return;
			case 'fullscreen_toggle': await submitMutations(tabId, [{ field: 'fullscreen', operation: 'toggle' }]); return;
			case 'pip_toggle': await submitMutations(tabId, [{ field: 'pip', operation: 'toggle' }]); return;
			case 'rotate_cw': await submitMutations(tabId, [{ field: 'rotation', operation: 'delta', value: 90 }]); return;
			case 'rotate_ccw': await submitMutations(tabId, [{ field: 'rotation', operation: 'delta', value: -90 }]); return;
			case 'mirror_toggle': await submitMutations(tabId, [{ field: 'mirrored', operation: 'toggle' }]); return;
			case 'dim_background': await submitMutations(tabId, [{ field: 'dimEnabled', operation: 'toggle' }]); return;
			case 'loop_toggle': await submitMutations(tabId, [{ field: 'loop', operation: 'toggle' }]); return;
			case 'tab_pin': await submitMutations(tabId, [{ field: 'tabPinned', operation: 'toggle' }]); return;
			case 'tab_mute': await submitMutations(tabId, [{ field: 'tabMuted', operation: 'toggle' }]); return;
	}
}
