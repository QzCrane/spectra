// goal: intercepts keyboard events for site-specific custom hotkeys
// eff: zero-alloc hot path for keydown events

import type { HotkeySettings, HotkeyBinding, SiteHotkeyConfig } from '@nexus/contracts';
import { DEFAULT_HOTKEY_SETTINGS } from '@nexus/contracts';
import { createLogger } from '../../shared/logger';
import { createEventListener, createCleanupManager } from '../utils/timing';
import { executeHotkeyAction, setConfigGetter, setConfigUpdater } from './hotkey-actions';
import { showToast } from '../ui/toast';
import { safeStorageGet } from '../../shared/safe-storage';

const log = createLogger('Hotkeys');

let settings: HotkeySettings = { ...DEFAULT_HOTKEY_SETTINGS };
let cachedSite: SiteHotkeyConfig | null | undefined = undefined;
let lastHostname = '';

export async function initHotkeyListener(): Promise<() => void> {
	await loadSettings();
	const cleanup = createCleanupManager();

	cleanup.add(createEventListener(document, 'keydown', handleKeydown as EventListener, true));

	if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
		const handler = handleStorageChange;
		chrome.storage.onChanged.addListener(handler);
		cleanup.add(() => chrome.storage.onChanged.removeListener(handler));
	}

	log.info('Hotkey listener initialized');
	return cleanup.dispose;
}

function handleStorageChange(changes: { [key: string]: chrome.storage.StorageChange }): void {
	if (changes.hotkeySettings?.newValue) {
		settings = changes.hotkeySettings.newValue;
		cachedSite = undefined;
		log.debug('Settings updated');
	}
}

async function loadSettings(): Promise<void> {
	try {
		const result = await safeStorageGet<{ hotkeySettings?: HotkeySettings }>(['hotkeySettings'], {});
		if (result.hotkeySettings) settings = result.hotkeySettings;
	} catch { }
}

function getSiteConfig(): SiteHotkeyConfig | null {
	if (location.hostname === lastHostname && cachedSite !== undefined) return cachedSite;
	lastHostname = location.hostname;
	const site = settings.sites[lastHostname];
	cachedSite = (site && site.enabled) ? site : null;
	return cachedSite;
}

const IGNORE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isInputElement(t: EventTarget | null): boolean {
	if (!t || !(t instanceof HTMLElement)) return false;
	if (t.isContentEditable) return true;
	return IGNORE_TAGS.has(t.tagName);
}

function handleKeydown(e: KeyboardEvent): void {
	const site = getSiteConfig();
	if (!site) return;
	if (isInputElement(e.target)) return;

	const code = e.code;
	const ctrl = e.ctrlKey, alt = e.altKey, shift = e.shiftKey, meta = e.metaKey;

	for (const b of site.bindings) {
		if (!b.enabled) continue;
		const k = b.key;
		if (k.code === code &&
			k.modifiers.ctrl === ctrl &&
			k.modifiers.alt === alt &&
			k.modifiers.shift === shift &&
			k.modifiers.meta === meta) {

			e.preventDefault();
			e.stopPropagation();
			executeWithOSD(b);
			return;
		}
	}
}

function executeWithOSD(b: HotkeyBinding): void {
	const action = b.action;
	if (action !== 'none' && action !== 'open_popup' && action !== 'open_options' && action !== 'open_url' && action !== 'run_js') {
		showToast(formatLabel(action, b.params));
	}
	executeHotkeyAction(action, b.params);
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

export { setConfigGetter, setConfigUpdater };
