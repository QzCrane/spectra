// goal: manages the application's appearance by handling explicit and system-preferred theme switching

import type { ThemeMode } from '@nexus/contracts';

const THEME_ATTRIBUTE = 'data-theme';
const DARK_MODE_QUERY = '(prefers-color-scheme: dark)';

let systemMediaQuery: MediaQueryList | null = null;
let systemThemeListener: ((e: MediaQueryListEvent) => void) | null = null;

// eff: updates the document's theme attribute and attaches/detaches system-level color scheme listeners
export function applyTheme(mode: ThemeMode): void {
	removeSystemThemeListener();

	if (mode === 'system') {
		systemMediaQuery = window.matchMedia(DARK_MODE_QUERY);
		const currentTheme = systemMediaQuery.matches ? 'dark' : 'light';
		document.documentElement.setAttribute(THEME_ATTRIBUTE, currentTheme);

		// rule: when in 'system' mode, react immediately to OS-level theme changes
		systemThemeListener = (e: MediaQueryListEvent) => {
			document.documentElement.setAttribute(THEME_ATTRIBUTE, e.matches ? 'dark' : 'light');
		};
		systemMediaQuery.addEventListener('change', systemThemeListener);
	} else {
		document.documentElement.setAttribute(THEME_ATTRIBUTE, mode);
	}
}

// eff: cleans up media query listeners to prevent redundant attribute updates when switching to a fixed theme
function removeSystemThemeListener(): void {
	if (systemMediaQuery && systemThemeListener) {
		systemMediaQuery.removeEventListener('change', systemThemeListener);
		systemThemeListener = null;
		systemMediaQuery = null;
	}
}

export function getEffectiveTheme(): 'light' | 'dark' {
	const attr = document.documentElement.getAttribute(THEME_ATTRIBUTE);
	return attr === 'dark' ? 'dark' : 'light';
}

export const THEME_ICONS: Record<ThemeMode, string> = {
	light: '☀️',
	dark: '🌙',
	system: '🖥️'
};

// post: returns the next theme in the rotation: Light -> Dark -> System
export function getNextThemeMode(current: ThemeMode): ThemeMode {
	const modes: ThemeMode[] = ['light', 'dark', 'system'];
	const idx = modes.indexOf(current);
	return modes[(idx + 1) % modes.length] ?? 'system';
}
