// goal: intercepts keyboard events for site-specific custom hotkeys
// eff: non-candidates allocate nothing; each candidate owns one same-event tail

import type {
	HotkeySettings,
	HotkeyBinding,
	SiteHotkeyConfig,
} from '@nexus/contracts';
import {
	DEFAULT_HOTKEY_SETTINGS,
	HOTKEY_ACTION_DESCRIPTORS,
	findBestHostnameMatch,
	isSpectraEventEnvelope,
	normalizeHostname,
	resolveAudioVolume,
	resolveAudioVolumeState,
	resolveSpectraHotkeyActualFeedback,
	resolveSpectraDefaultHotkeyAction,
} from '@nexus/contracts';
import { createLogger } from '../../shared/logger';
import { sendSpectraRequest } from '../../shared/spectra-client';
import { createEventListener, createCleanupManager } from '../utils/timing';
import { executeHotkeyAction } from './hotkey-actions';
import {
	createWebsiteFirstKeyboardArbiter,
	isEditableHotkeyEvent,
	isTrustedHotkeyEvent,
} from './hotkey-event';
import {
	nextScalarGestureId,
	subscribeDefaultScalarGesture,
	subscribePhysicalHotkeyRelease,
	type DefaultScalarGestureSignal,
	type PhysicalHotkeyReleaseSignal,
} from './default-scalar-gesture';
import {
	freezeHotkeyToast,
	hideToast,
	releaseHotkeyToast,
	showToast,
} from '../ui/toast';
import {
	advanceHotkeyTargetOSD,
	claimHotkeyActualOSDGesture,
	freezeHotkeyTargetOSD,
	hideOSD,
	releaseHotkeyTargetOSD,
	showHotkeyActualOSD,
} from '../ui/osd';
import type { SettingsManager } from '../core/settings-manager';
import type { PolicyExecutorState } from '../types';

const log = createLogger('Hotkeys');

let settings: HotkeySettings = { ...DEFAULT_HOTKEY_SETTINGS };
let cachedSite: SiteHotkeyConfig | null | undefined;
let cachedBindings: Map<string, HotkeyBinding> | undefined;
let lastHostname = '';
const inFlightGestures = new Set<string>();
const releasedFeedbackGestures = new Set<string>();
const pendingRepeatPulses = new Map<string, number>();
const lastRepeatExecutionAt = new Map<string, number>();
interface ActiveHotkeyBinding {
	binding: HotkeyBinding;
	repeated: boolean;
	feedbackGesture: string;
}
const activeBindingsByCode = new Map<string, ActiveHotkeyBinding>();
const MAX_REPEAT_BURST_PULSES = 160;
const REPEAT_EXECUTION_INTERVAL_MS = 50;
let keydownDisposer: (() => void) | null = null;
let contentSettings: Pick<SettingsManager, 'get'> | undefined;
let feedbackState: Pick<
	PolicyExecutorState,
	'appliedConfig' | 'actualMode' | 'phase'
> | undefined;

function cancelActiveBindings(): void {
	for (const held of activeBindingsByCode.values()) {
		if (inFlightGestures.has(held.feedbackGesture)) {
			releasedFeedbackGestures.add(held.feedbackGesture);
		} else {
			releaseHotkeyToast(held.feedbackGesture);
			releaseHotkeyTargetOSD(held.feedbackGesture);
		}
	}
	activeBindingsByCode.clear();
	pendingRepeatPulses.clear();
	lastRepeatExecutionAt.clear();
	hideToast();
	hideOSD(true);
}

function synchronizeKeydownListener(): void {
	const shouldListen = getSiteConfig() !== null;
	if (shouldListen && !keydownDisposer) {
		keydownDisposer = createWebsiteFirstKeyboardArbiter({
			type: 'keydown',
			resolveCandidate: resolveSiteHotkeyBinding,
			onSettled: (event, binding, websiteClaimed) => {
				if (!websiteClaimed) handleKeydown(event, binding);
			},
		});
	} else if (!shouldListen && keydownDisposer) {
		cancelActiveBindings();
		keydownDisposer();
		keydownDisposer = null;
	}
}

export async function initHotkeyListener(
	settingsManager?: Pick<SettingsManager, 'get'>,
	state?: Pick<PolicyExecutorState, 'appliedConfig' | 'actualMode' | 'phase'>,
): Promise<() => void> {
	contentSettings = settingsManager;
	feedbackState = state;
	await loadSettings();
	const cleanup = createCleanupManager();

	cleanup.add(subscribePhysicalHotkeyRelease(releaseSiteHotkeys));
	synchronizeKeydownListener();
	cleanup.add(subscribeDefaultScalarGesture(handleDefaultScalarGesture));
	cleanup.add(createEventListener(window, 'blur', cancelActiveBindings));
	cleanup.add(createEventListener(window, 'pagehide', cancelActiveBindings));
	cleanup.add(createEventListener(document, 'visibilitychange', () => {
		if (document.hidden) cancelActiveBindings();
	}));

	chrome.runtime.onMessage.addListener(handleSettingsEvent);
	cleanup.add(() => chrome.runtime.onMessage.removeListener(handleSettingsEvent));
	cleanup.add(() => {
		keydownDisposer?.();
		keydownDisposer = null;
		cancelActiveBindings();
		if (contentSettings === settingsManager) contentSettings = undefined;
		if (feedbackState === state) feedbackState = undefined;
	});

	log.info('Hotkey listener initialized');
	return cleanup.dispose;
}

function handleSettingsEvent(message: unknown): false {
	if (isSpectraEventEnvelope(message) && message.type === 'spectra.hotkey.target.feedback') {
		const options = message.payload.targetTabId === message.tabId
			? {}
			: {
				variant: 'alternate-target' as const,
				targetTitle: message.payload.targetTitle,
				targetHostname: message.payload.targetHostname,
		};
		if (message.payload.feedback && contentSettings) {
			showHotkeyActualOSD(
				message.payload.feedback,
				contentSettings.get(),
				options,
				message.payload.gesture,
			);
		} else {
			showToast(formatLabel(message.payload.action), options);
		}
		return false;
	}
	if (isSpectraEventEnvelope(message) && message.type === 'spectra.hotkeys.changed') {
		cancelActiveBindings();
		settings = message.payload;
		cachedSite = undefined;
		cachedBindings = undefined;
		synchronizeKeydownListener();
		log.debug('Settings updated');
	}
	return false;
}

async function loadSettings(): Promise<void> {
	try {
		const result = await sendSpectraRequest('spectra.hotkeys.get', {});
		if (result.ok) settings = result.data;
	} catch { }
}

function getSiteConfig(): SiteHotkeyConfig | null {
	if (location.hostname === lastHostname && cachedSite !== undefined) return cachedSite;
	lastHostname = location.hostname;
	const hostname = normalizeHostname(lastHostname);
	if (!hostname) {
		cachedSite = null;
		return cachedSite;
	}

	const match = findBestHostnameMatch(hostname, Object.entries(settings.sites), ([domain]) => domain);
	const site = match?.[1];
	cachedSite = site?.enabled ? site : null;
	cachedBindings = undefined;
	return cachedSite;
}

function bindingKey(code: string, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean): string {
	return `${code}:${ctrl ? 1 : 0}${alt ? 1 : 0}${shift ? 1 : 0}${meta ? 1 : 0}`;
}

function getBindingMap(site: SiteHotkeyConfig): Map<string, HotkeyBinding> {
	if (cachedBindings) return cachedBindings;
	const bindings = new Map<string, HotkeyBinding>();
	for (const binding of site.bindings) {
		if (!binding.enabled || binding.disabledReason) continue;
		const { code, modifiers } = binding.key;
		bindings.set(bindingKey(
			code,
			modifiers.ctrl,
			modifiers.alt,
			modifiers.shift,
			modifiers.meta,
		), binding);
	}
	cachedBindings = bindings;
	return bindings;
}

// Browser navigation shortcuts always belong to the browser. Allowing a site
// binding to claim them displayed SPECTRA feedback immediately before reload,
// which looked like a toast emitted by the refreshed document.
function isBrowserRefreshShortcut(e: KeyboardEvent): boolean {
	return e.code === 'F5'
		|| (e.code === 'KeyR' && !e.altKey && (e.ctrlKey || e.metaKey));
}

function nextFeedbackGesture(): string {
	return nextScalarGestureId('site');
}

function volumeFeedback(value: number) {
	const current = feedbackState!;
	return {
		kind: 'volume' as const,
		value,
		volumeState: resolveAudioVolumeState({
			volume: value,
			muted: current.appliedConfig.muted,
			actualMode: current.actualMode,
			phase: current.phase,
		}),
	};
}

function advanceScalarFeedbackTarget(
	kind: 'speed' | 'volume',
	delta: number,
	gesture: string,
): void {
	if (!contentSettings || !feedbackState) return;
	const baseline = kind === 'speed'
		? { kind, value: feedbackState.appliedConfig.speed } as const
		: volumeFeedback(resolveAudioVolume(feedbackState.appliedConfig).effectiveVolume);
	advanceHotkeyTargetOSD(
		baseline,
		delta,
		contentSettings.get(),
		gesture,
	);
}

function handleDefaultScalarGesture(signal: DefaultScalarGestureSignal): void {
	const kind = signal.action.startsWith('speed_') ? 'speed' : 'volume';
	if (signal.phase === 'release') {
		if (signal.repeated) freezeHotkeyTargetOSD(signal.gesture);
		return;
	}
	if (signal.phase === 'settled') {
		releaseHotkeyTargetOSD(signal.gesture);
		return;
	}
	claimHotkeyActualOSDGesture(signal.gesture);
	if (signal.action === 'volume_mute') return;
	if (!contentSettings || !feedbackState) return;
	const direction = signal.action.endsWith('_up') ? 1 : -1;
	const step = kind === 'speed' ? 0.1 : 10;
	advanceScalarFeedbackTarget(kind, direction * step, signal.gesture);
}

function addRepeatPulse(gesture: string): void {
	pendingRepeatPulses.set(
		gesture,
		Math.min(MAX_REPEAT_BURST_PULSES, (pendingRepeatPulses.get(gesture) ?? 0) + 1),
	);
}

function takeRepeatPulses(gesture: string): number {
	const pulses = pendingRepeatPulses.get(gesture) ?? 0;
	pendingRepeatPulses.delete(gesture);
	return pulses;
}

function coalescedBinding(binding: HotkeyBinding, pulses: number): HotkeyBinding {
	if (pulses <= 1) return binding;
	const step = Number.isFinite(binding.params?.step)
		? Math.abs(binding.params!.step!)
		: binding.action.startsWith('speed_') ? 0.1 : 10;
	if (binding.action === 'speed_up' || binding.action === 'speed_down') {
		return {
			...binding,
			params: {
				...binding.params,
				step: Math.min(16, Math.round(step * pulses * 1000) / 1000),
			},
		};
	}
	if (binding.action === 'volume_up' || binding.action === 'volume_down') {
		return {
			...binding,
			params: { ...binding.params, step: Math.min(800, step * pulses) },
		};
	}
	// Discrete repeatable operations coalesce to one execution; they cannot be
	// converted into a larger scalar without changing their semantics.
	return binding;
}

function scalarFeedbackDelta(binding: HotkeyBinding): number | null {
	const step = Number.isFinite(binding.params?.step)
		? Math.abs(binding.params!.step!)
		: binding.action.startsWith('speed_') ? 0.1 : 10;
	switch (binding.action) {
		case 'speed_up':
		case 'volume_up': return step;
		case 'speed_down':
		case 'volume_down': return -step;
		default: return null;
	}
}

function advanceBindingFeedbackTarget(
	binding: HotkeyBinding,
	gesture: string,
): void {
	const delta = scalarFeedbackDelta(binding);
	if (delta === null) return;
	const kind = binding.action.startsWith('speed_') ? 'speed' : 'volume';
	advanceScalarFeedbackTarget(kind, delta, gesture);
}

function commitHotkeyActualFeedback(
	binding: HotkeyBinding,
	gesture: string,
	result: unknown,
): void {
	if (!contentSettings) return;
	const feedback = resolveSpectraHotkeyActualFeedback(binding.action, result);
	if (!feedback) return;
	showHotkeyActualOSD(
		feedback,
		contentSettings.get(),
		{},
		gesture,
	);
}

function executeBinding(
	binding: HotkeyBinding,
	withOSD: boolean,
	feedbackGesture: string,
): void {
	if (inFlightGestures.has(feedbackGesture)) return;
	inFlightGestures.add(feedbackGesture);
	const execution = withOSD
		? executeWithOSD(binding, feedbackGesture)
		: executeHotkeyAction(binding.action, binding.params);
	void execution
		.then((result) => commitHotkeyActualFeedback(binding, feedbackGesture, result))
		.catch((error) => {
			log.warn(`Hotkey ${binding.action} failed`, error);
			if (withOSD) showToast(error instanceof Error ? error.message : String(error), {
				shortcutGesture: feedbackGesture,
			});
		})
		.finally(() => {
		inFlightGestures.delete(feedbackGesture);
		if (releasedFeedbackGestures.delete(feedbackGesture)) {
			releaseHotkeyToast(feedbackGesture);
			releaseHotkeyTargetOSD(feedbackGesture);
		}
		});
}

function resolveSiteHotkeyBinding(e: KeyboardEvent): HotkeyBinding | null {
	if (!isTrustedHotkeyEvent(e)) return null;
	if (isBrowserRefreshShortcut(e)) return null;
	if (resolveSpectraDefaultHotkeyAction(e) !== null) return null;
	const site = getSiteConfig();
	if (!site) return null;
	if (isEditableHotkeyEvent(e)) return null;

	const binding = getBindingMap(site).get(bindingKey(
		e.code,
		e.ctrlKey,
		e.altKey,
		e.shiftKey,
		e.metaKey,
	));
	if (!binding) return null;
	const descriptor = HOTKEY_ACTION_DESCRIPTORS[binding.action];
	if (e.repeat && (descriptor.repeatPolicy !== 'coalesce-20hz'
		|| !activeBindingsByCode.has(e.code))) return null;
	return binding;
}

function handleKeydown(e: KeyboardEvent, binding: HotkeyBinding): void {
	const descriptor = HOTKEY_ACTION_DESCRIPTORS[binding.action];
	e.preventDefault();
	if (!e.repeat) releaseSiteHotkeys({ code: e.code });
	const active = e.repeat ? activeBindingsByCode.get(e.code) : undefined;
	const held: ActiveHotkeyBinding = {
		binding,
		repeated: e.repeat || active?.repeated === true,
		feedbackGesture: active?.feedbackGesture ?? nextFeedbackGesture(),
	};
	if (!e.repeat && descriptor.repeatPolicy === 'coalesce-20hz') {
		advanceBindingFeedbackTarget(binding, held.feedbackGesture);
	}
	activeBindingsByCode.set(e.code, held);
	if (descriptor.repeatPolicy !== 'coalesce-20hz' || !e.repeat) {
		// First press (non-repeat) OR a non-coalesce action: execute immediately
		// WITH the OSD toast. The toast is the once-per-press signal that the
		// hotkey fired — it must not be re-shown on every keydown repeat, or the
		// OSD floods and appears "stuck on" while the user holds the key.
		executeBinding(binding, true, held.feedbackGesture);
		return;
	}
	advanceBindingFeedbackTarget(held.binding, held.feedbackGesture);
	// Only a new physical repeat may consume accumulated pulses. There is no
	// trailing action timer, so even an unobservable keyup cannot create motion
	// after the physical event stream has stopped.
	addRepeatPulse(held.feedbackGesture);
	if (inFlightGestures.has(held.feedbackGesture)) return;
	const lastExecutionAt = lastRepeatExecutionAt.get(held.feedbackGesture);
	if (lastExecutionAt !== undefined
		&& e.timeStamp - lastExecutionAt < REPEAT_EXECUTION_INTERVAL_MS) return;
	lastRepeatExecutionAt.set(held.feedbackGesture, e.timeStamp);
	executeBinding(
		coalescedBinding(binding, takeRepeatPulses(held.feedbackGesture)),
		false,
		held.feedbackGesture,
	);
}

function modifierForCode(code: string): keyof HotkeyBinding['key']['modifiers'] | null {
	return code.startsWith('Control') ? 'ctrl'
		: code.startsWith('Alt') ? 'alt'
			: code.startsWith('Shift') ? 'shift'
				: code.startsWith('Meta') ? 'meta'
					: null;
}

function releaseSiteHotkeys(signal: PhysicalHotkeyReleaseSignal): void {
	let releasedRepeated = false;
	const released: ActiveHotkeyBinding[] = [];
	const active = activeBindingsByCode.get(signal.code);
	if (active) {
		activeBindingsByCode.delete(signal.code);
		pendingRepeatPulses.delete(active.feedbackGesture);
		lastRepeatExecutionAt.delete(active.feedbackGesture);
		releasedRepeated = active.repeated;
		released.push(active);
	}

	const modifier = modifierForCode(signal.code);
	if (modifier) {
		for (const [code, held] of activeBindingsByCode) {
			if (!held.binding.key.modifiers[modifier]) continue;
			activeBindingsByCode.delete(code);
			pendingRepeatPulses.delete(held.feedbackGesture);
			lastRepeatExecutionAt.delete(held.feedbackGesture);
			releasedRepeated ||= held.repeated;
			released.push(held);
		}
	}

	// A tap keeps its original window. A held shortcut stops moving at keyup,
	// commits its final frame, and receives a fresh readable display window.
	if (releasedRepeated && ![...activeBindingsByCode.values()].some((held) => held.repeated)) {
		for (const held of released) {
			if (!held.repeated) continue;
			freezeHotkeyToast(held.feedbackGesture);
			freezeHotkeyTargetOSD(held.feedbackGesture);
		}
	}
	for (const held of released) {
		if (inFlightGestures.has(held.feedbackGesture)) {
			releasedFeedbackGestures.add(held.feedbackGesture);
		} else {
			releaseHotkeyToast(held.feedbackGesture);
			releaseHotkeyTargetOSD(held.feedbackGesture);
		}
	}
}

async function executeWithOSD(b: HotkeyBinding, feedbackGesture: string): Promise<unknown> {
	const action = b.action;
	const feedbackOwner = HOTKEY_ACTION_DESCRIPTORS[action].feedbackOwner;
	if (feedbackOwner === 'actual-osd') {
		claimHotkeyActualOSDGesture(feedbackGesture);
	}
	// Show toast immediately for instant feedback, before awaiting the action
	if (feedbackOwner === 'listener-label') {
		showToast(formatLabel(action, b.params), { shortcutGesture: feedbackGesture });
	}
	return executeHotkeyAction(action, b.params);
}

function formatLabel(action: string, p?: { step?: number }): string {
	const s = p?.step;
	switch (action) {
		case 'play_pause': return '⏯️';
		case 'speed_up': return `⏩ +${s ?? 0.1}x`;
		case 'speed_down': return `⏪ -${s ?? 0.1}x`;
		case 'speed_reset': return '🔄 1x';
		case 'volume_up': return `🔊 +${s ?? 10}`;
		case 'volume_down': return `🔉 -${s ?? 10}`;
		case 'volume_mute': return '🔇';
		case 'fullscreen_toggle': return '📺';
		case 'pip_toggle': return '🖼️';
		default: return action.replace(/_/g, ' ');
	}
}
