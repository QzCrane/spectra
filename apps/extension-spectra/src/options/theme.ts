// goal: manages the options page theme persistence and visual toggle state

import type { ThemeMode } from '@nexus/contracts';
import { getSettingsSnapshot, patchSettings } from '../shared/settings-client';

const LEGACY_THEME_KEY = 'theme';
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
let currentMode: ThemeMode = 'system';

// note: one-release read-only adapter for the pre-v2 Options localStorage key.
// Eligibility and atomic consumption are owned by the background repository.
function readLegacyThemeCandidateForOneRelease(): ThemeMode | null {
	const legacy = localStorage.getItem(LEGACY_THEME_KEY);
	return legacy === 'light' || legacy === 'dark' || legacy === 'system' ? legacy : null;
}

async function consumeLegacyThemeForOneRelease(): Promise<ThemeMode> {
	const snapshot = await patchSettings({
		scope: 'legacy-theme',
		candidate: readLegacyThemeCandidateForOneRelease(),
	});
	localStorage.removeItem(LEGACY_THEME_KEY);
	return snapshot.globalSettings.themeMode;
}

// eff: restores the user's preferred theme from storage and binds the toggle button listener
export async function initTheme(): Promise<void> {
	const snapshot = await getSettingsSnapshot();
	currentMode = snapshot.globalSettings.themeMode;
	try {
		currentMode = await consumeLegacyThemeForOneRelease();
	} catch {
		// Keep the candidate for the next Options visit if the background is restarting.
	}
	applyTheme(currentMode);

	const btn = document.getElementById('theme-toggle');
	if (btn) {
		btn.addEventListener('click', async () => {
			const current = document.documentElement.dataset.theme ?? 'light';
			currentMode = current === 'dark' ? 'light' : 'dark';
			await patchSettings({ scope: 'global', changes: { themeMode: currentMode } });
			applyTheme(currentMode);
			updateIcon(currentMode);
		});
		updateIcon(document.documentElement.dataset.theme ?? 'light');
	}

	systemTheme.addEventListener('change', () => {
		if (currentMode !== 'system') return;
		applyTheme(currentMode);
		updateIcon(document.documentElement.dataset.theme ?? 'light');
	});
}

// eff: injects the theme identifier into the document root for CSS targeting, resolving 'system' to light/dark
function applyTheme(theme: ThemeMode): void {
	if (theme === 'system') {
		const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
		document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
	} else {
		document.documentElement.dataset.theme = theme;
	}
}

function updateIcon(theme: string): void {
	const btn = document.getElementById('theme-toggle');
	if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}
