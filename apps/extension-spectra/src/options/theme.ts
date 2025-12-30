// goal: manages the options page theme persistence and visual toggle state

const THEME_KEY = 'theme';

// eff: restores the user's preferred theme from storage and binds the toggle button listener
export function initTheme(): void {
	const saved = localStorage.getItem(THEME_KEY) ?? 'system';
	applyTheme(saved);

	const btn = document.getElementById('theme-toggle');
	if (btn) {
		btn.addEventListener('click', () => {
			const current = document.documentElement.dataset.theme ?? 'light';
			const next = current === 'dark' ? 'light' : 'dark';
			localStorage.setItem(THEME_KEY, next);
			applyTheme(next);
			updateIcon(next);
		});
		updateIcon(document.documentElement.dataset.theme ?? 'light');
	}
}

// eff: injects the theme identifier into the document root for CSS targeting, resolving 'system' to light/dark
function applyTheme(theme: string): void {
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
