// goal: intercepts keyboard events for site-specific custom hotkeys and manages their lifecycle
// rule: hotkeys are disabled by default per domain and require explicit user enablement for privacy and performance

import type { HotkeySettings, HotkeyBinding, KeyCombo, SiteHotkeyConfig } from '@nexus/contracts';
import { DEFAULT_HOTKEY_SETTINGS } from '@nexus/contracts';
import { createLogger } from '../shared/logger';
import { executeHotkeyAction, setCachedConfig } from './hotkey-actions';
import { showToast } from './toast';

const logger = createLogger('Hotkeys');

let settings: HotkeySettings = { ...DEFAULT_HOTKEY_SETTINGS };

// eff: initializes the hotkey subsystem by loading settings and attaching DOM/storage listeners
// post: returns a cleanup function to detach all listeners when the content script is purged
export async function initHotkeyListener(): Promise<() => void> {
	await loadSettings();

	// note: guard against extension context invalidation after update/reload
	if (chrome?.storage?.onChanged) {
		chrome.storage.onChanged.addListener(handleStorageChange);
	}

	document.addEventListener('keydown', handleKeydown, true);
	logger.info('Hotkey listener initialized');

	return () => {
		document.removeEventListener('keydown', handleKeydown, true);
		if (chrome?.storage?.onChanged) {
			chrome.storage.onChanged.removeListener(handleStorageChange);
		}
	};
}

// eff: synchronizes the in-memory settings cache when external updates occur (e.g., from the popup)
function handleStorageChange(changes: { [key: string]: chrome.storage.StorageChange }): void {
	if (changes.hotkeySettings?.newValue) {
		settings = changes.hotkeySettings.newValue;
		logger.debug('Settings updated');
	}
}

async function loadSettings(): Promise<void> {
	try {
		const result = await chrome.storage.local.get('hotkeySettings');
		if (result.hotkeySettings) settings = result.hotkeySettings;
	} catch { }
}

// post: returns the active configuration for the current domain if it exists and is enabled
function getSiteConfig(): SiteHotkeyConfig | null {
	const domain = location.hostname;
	const site = settings.sites[domain];
	if (!site || !site.enabled) return null;
	return site;
}

// eff: intercepts 'keydown' events, validates against site-specific bindings, and executes if matched
// rule: suppressed if the event target is an input element to avoid disrupting standard typing
function handleKeydown(e: KeyboardEvent): void {
	const site = getSiteConfig();
	if (!site) return;

	if (isInputElement(e.target)) return;

	const binding = findMatch(e, site.bindings);
	if (!binding) return;

	e.preventDefault();
	e.stopPropagation();
	executeWithOSD(binding);
}

// eff: triggers a visual notification (OSD) and executes the linked functional action
function executeWithOSD(binding: HotkeyBinding): void {
	const silent = ['none', 'open_popup', 'open_options', 'open_url', 'run_js'];
	if (!silent.includes(binding.action)) {
		showToast(formatLabel(binding.action, binding.params));
	}
	executeHotkeyAction(binding.action, binding.params);
}

function formatLabel(action: string, params?: { step?: number }): string {
	const map: Record<string, string> = {
		play_pause: '⏯️', speed_up: `⏩ +${params?.step ?? 0.1}x`, speed_down: `⏪ -${params?.step ?? 0.1}x`,
		speed_reset: '🔄 1x', volume_up: `🔊 +${params?.step ?? 10}`, volume_down: `🔉 -${params?.step ?? 10}`,
		volume_mute: '🔇', fullscreen_toggle: '📺', pip_toggle: '🖼️',
	};
	return map[action] ?? action.replace(/_/g, ' ');
}

// post: returns true if the element accepts user text/interaction input
function isInputElement(t: EventTarget | null): boolean {
	if (!t || !(t instanceof HTMLElement)) return false;
	const tag = t.tagName.toLowerCase();
	return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
}

// role: matches a physical KeyboardEvent against defined key/modifier combinations
function findMatch(e: KeyboardEvent, bindings: HotkeyBinding[]): HotkeyBinding | null {
	const combo: KeyCombo = {
		code: e.code,
		modifiers: { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey }
	};
	for (const b of bindings) {
		if (!b.enabled) continue;
		if (matchCombo(b.key, combo)) return b;
	}
	return null;
}

function matchCombo(a: KeyCombo, b: KeyCombo): boolean {
	return a.code === b.code
		&& a.modifiers.ctrl === b.modifiers.ctrl
		&& a.modifiers.alt === b.modifiers.alt
		&& a.modifiers.shift === b.modifiers.shift
		&& a.modifiers.meta === b.modifiers.meta;
}

export { setCachedConfig };
