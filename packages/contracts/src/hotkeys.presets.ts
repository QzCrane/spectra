// goal: default hotkey preset configurations
// description: default global hotkeys using common and non-conflicting keys
// note: users can modify in Options page or disable for specific websites

import type { HotkeyBinding, KeyModifiers } from './hotkeys.contracts.js';

// M: default modifiers (local copy to avoid circular dependencies)
const M: Readonly<KeyModifiers> = { ctrl: false, alt: false, shift: false, meta: false };

// PRESET_BINDINGS: global default bindings using intuitive keys
export const PRESET_BINDINGS: readonly HotkeyBinding[] = [
	// category: Speed control (S/A/D)
	{ id: 'speed-up', enabled: true, key: { code: 'KeyS', modifiers: M }, action: 'speed_up', params: { step: 0.1 } },
	{ id: 'speed-down', enabled: true, key: { code: 'KeyA', modifiers: M }, action: 'speed_down', params: { step: 0.1 } },
	{ id: 'speed-reset', enabled: true, key: { code: 'KeyD', modifiers: M }, action: 'speed_reset' },

	// category: Navigation (Arrow keys)
	{ id: 'seek-back-10', enabled: true, key: { code: 'ArrowLeft', modifiers: M }, action: 'seek_backward_10s' },
	{ id: 'seek-fwd-10', enabled: true, key: { code: 'ArrowRight', modifiers: M }, action: 'seek_forward_10s' },

	// category: Volume (Alt + Arrows)
	{ id: 'vol-up', enabled: true, key: { code: 'ArrowUp', modifiers: { ...M, alt: true } }, action: 'volume_up', params: { step: 10 } },
	{ id: 'vol-down', enabled: true, key: { code: 'ArrowDown', modifiers: { ...M, alt: true } }, action: 'volume_down', params: { step: 10 } },
	{ id: 'vol-mute', enabled: true, key: { code: 'KeyM', modifiers: { ...M, alt: true } }, action: 'volume_mute' },

	// category: Video control (Alt + keys)
	{ id: 'pip-toggle', enabled: true, key: { code: 'KeyP', modifiers: { ...M, alt: true } }, action: 'pip_toggle' },
	{ id: 'fullscreen', enabled: true, key: { code: 'KeyF', modifiers: { ...M, alt: true } }, action: 'fullscreen_toggle' },
] as const;
