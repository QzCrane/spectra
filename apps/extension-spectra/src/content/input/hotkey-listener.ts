// goal: intercepts keyboard events for site-specific custom hotkeys
// eff: zero-alloc hot path for keydown events

import type { HotkeySettings, HotkeyBinding, SiteHotkeyConfig } from '@nexus/contracts';
import {
	DEFAULT_HOTKEY_SETTINGS,
	HOTKEY_ACTION_DESCRIPTORS,
	findBestHostnameMatch,
	isSpectraEventEnvelope,
	normalizeHostname,
} from '@nexus/contracts';
import { createLogger } from '../../shared/logger';
import { sendSpectraRequest } from '../../shared/spectra-client';
import { createEventListener, createCleanupManager } from '../utils/timing';
import { executeHotkeyAction } from './hotkey-actions';
import { isTrustedHotkeyEvent } from './hotkey-event';
import { hideToast, showToast } from '../ui/toast';
import { hideOSD, showHotkeyActualOSD } from '../ui/osd';
import type { SettingsManager } from '../core/settings-manager';

const log = createLogger('Hotkeys');

let settings: HotkeySettings = { ...DEFAULT_HOTKEY_SETTINGS };
let cachedSite: SiteHotkeyConfig | null | undefined;
let cachedBindings: Map<string, HotkeyBinding> | undefined;
let lastHostname = '';
const coalesced = new Map<string, ReturnType<typeof setTimeout>>();
const inFlightBindings = new Set<string>();
const releasedRepeatedBindings = new Set<string>();
const activeBindingsByCode = new Map<string, { binding: HotkeyBinding; repeated: boolean }>();
let keydownDisposer: (() => void) | null = null;
let keyupDisposer: (() => void) | null = null;
let contentSettings: Pick<SettingsManager, 'get'> | undefined;

function cancelCoalesced(bindingId: string): void {
	const timer = coalesced.get(bindingId);
	if (!timer) return;
	clearTimeout(timer);
	coalesced.delete(bindingId);
}

function cancelActiveBindings(): void {
	for (const timer of coalesced.values()) clearTimeout(timer);
	coalesced.clear();
	activeBindingsByCode.clear();
	releasedRepeatedBindings.clear();
	hideToast();
	hideOSD();
}

function synchronizeKeydownListener(): void {
	const shouldListen = getSiteConfig() !== null;
	if (shouldListen && !keydownDisposer) {
		keydownDisposer = createEventListener(document, 'keydown', handleKeydown as EventListener, true);
		keyupDisposer = createEventListener(document, 'keyup', handleKeyup as EventListener, true);
	} else if (!shouldListen && keydownDisposer) {
		cancelActiveBindings();
		keydownDisposer();
		keydownDisposer = null;
		if (keyupDisposer) {
			keyupDisposer();
			keyupDisposer = null;
		}
	}
}

export async function initHotkeyListener(
	settingsManager?: Pick<SettingsManager, 'get'>,
): Promise<() => void> {
	contentSettings = settingsManager;
	await loadSettings();
	const cleanup = createCleanupManager();

	synchronizeKeydownListener();
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
		if (keyupDisposer) {
			keyupDisposer();
			keyupDisposer = null;
		}
		cancelActiveBindings();
	});

	log.info('Hotkey listener initialized');
	return cleanup.dispose;
}

function handleSettingsEvent(message: unknown): false {
	if (isSpectraEventEnvelope(message) && message.type === 'spectra.hotkey.target.feedback') {
		const options = {
			variant: 'alternate-target',
			targetTitle: message.payload.targetTitle,
			targetHostname: message.payload.targetHostname,
		} as const;
		if (message.payload.feedback && contentSettings) {
			showHotkeyActualOSD(message.payload.feedback, contentSettings.get(), options);
		} else {
			showToast(formatLabel(message.payload.action), options);
		}
		return false;
	}
	if (isSpectraEventEnvelope(message) && message.type === 'spectra.hotkeys.changed') {
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

const IGNORE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isInputElement(t: EventTarget | null): boolean {
	if (!t || !(t instanceof HTMLElement)) return false;
	if (t.isContentEditable) return true;
	return IGNORE_TAGS.has(t.tagName);
}

// Browser navigation shortcuts always belong to the browser. Allowing a site
// binding to claim them displayed SPECTRA feedback immediately before reload,
// which looked like a toast emitted by the refreshed document.
function isBrowserRefreshShortcut(e: KeyboardEvent): boolean {
	return e.code === 'F5'
		|| (e.code === 'KeyR' && !e.altKey && (e.ctrlKey || e.metaKey));
}

function isBindingActive(bindingId: string): boolean {
	return [...activeBindingsByCode.values()].some(({ binding }) => binding.id === bindingId);
}

function executeBinding(binding: HotkeyBinding, withOSD: boolean): void {
	if (inFlightBindings.has(binding.id)) return;
	inFlightBindings.add(binding.id);
	const execution = withOSD
		? executeWithOSD(binding)
		: executeHotkeyAction(binding.action, binding.params).catch((error) => {
			log.warn(`Hotkey ${binding.action} repeat failed`, error);
		});
	void execution.finally(() => {
		inFlightBindings.delete(binding.id);
		if (releasedRepeatedBindings.delete(binding.id)) {
			hideToast();
			hideOSD();
		}
	});
}

function handleKeydown(e: KeyboardEvent): void {
	if (!isTrustedHotkeyEvent(e)) return;
	if (isBrowserRefreshShortcut(e)) return;
	const site = getSiteConfig();
	if (!site) return;
	if (e.composedPath().some((target) => isInputElement(target))) return;

	const binding = getBindingMap(site).get(bindingKey(
		e.code,
		e.ctrlKey,
		e.altKey,
		e.shiftKey,
		e.metaKey,
	));
	if (!binding) return;
	const descriptor = HOTKEY_ACTION_DESCRIPTORS[binding.action];
	if (e.repeat && descriptor.repeatPolicy !== 'coalesce-20hz') return;
	e.preventDefault();
	e.stopPropagation();
	const active = activeBindingsByCode.get(e.code);
	activeBindingsByCode.set(e.code, {
		binding,
		repeated: e.repeat || active?.repeated === true,
	});
	if (descriptor.repeatPolicy !== 'coalesce-20hz' || !e.repeat) {
		// First press (non-repeat) OR a non-coalesce action: execute immediately
		// WITH the OSD toast. The toast is the once-per-press signal that the
		// hotkey fired — it must not be re-shown on every keydown repeat, or the
		// OSD floods and appears "stuck on" while the user holds the key.
		executeBinding(binding, true);
		return;
	}
	// Repeat keydown under coalesce-20hz: throttle the action to ~20 Hz (50 ms)
	// and execute it WITHOUT the toast. The initial press already showed the
	// OSD; re-showing it on every repeat floods the toast and creates phantom
	// "drift" toasts after keyup because pending executeWithOSD promises keep
	// resolving. The 50 ms timer is cleared on keyup so no queued action fires
	// after the user releases the key.
	if (coalesced.has(binding.id) || inFlightBindings.has(binding.id)) return;
	coalesced.set(binding.id, setTimeout(() => {
		coalesced.delete(binding.id);
		if (!isBindingActive(binding.id)) return;
		executeBinding(binding, false);
	}, 50));
}

function handleKeyup(e: KeyboardEvent): void {
	if (!isTrustedHotkeyEvent(e)) return;
	let releasedRepeated = false;
	const active = activeBindingsByCode.get(e.code);
	if (active) {
		activeBindingsByCode.delete(e.code);
		cancelCoalesced(active.binding.id);
		releasedRepeated = active.repeated;
		if (active.repeated && inFlightBindings.has(active.binding.id)) {
			releasedRepeatedBindings.add(active.binding.id);
		}
	}

	const modifier = e.code.startsWith('Control') ? 'ctrl'
		: e.code.startsWith('Alt') ? 'alt'
			: e.code.startsWith('Shift') ? 'shift'
				: e.code.startsWith('Meta') ? 'meta'
					: null;
	if (modifier) {
		for (const [code, held] of activeBindingsByCode) {
			if (!held.binding.key.modifiers[modifier]) continue;
			activeBindingsByCode.delete(code);
			cancelCoalesced(held.binding.id);
			releasedRepeated ||= held.repeated;
			if (held.repeated && inFlightBindings.has(held.binding.id)) {
				releasedRepeatedBindings.add(held.binding.id);
			}
		}
	}

	// A tap keeps its short feedback window; a held shortcut disappears at keyup.
	if (releasedRepeated && ![...activeBindingsByCode.values()].some((held) => held.repeated)) {
		hideToast();
		hideOSD();
	}
}

async function executeWithOSD(b: HotkeyBinding): Promise<void> {
	const action = b.action;
	const feedbackOwner = HOTKEY_ACTION_DESCRIPTORS[action].feedbackOwner;
	// Show toast immediately for instant feedback, before awaiting the action
	if (feedbackOwner === 'listener-label') {
		showToast(formatLabel(action, b.params));
	}
	try {
		await executeHotkeyAction(action, b.params);
	} catch (error) {
		log.warn(`Hotkey ${action} failed`, error);
		showToast(error instanceof Error ? error.message : String(error));
	}
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
