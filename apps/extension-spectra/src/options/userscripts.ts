// goal: manages the userScripts API availability check and UI updates on options page

import { t } from './i18n';

// eff: checks if userScripts API is available and enabled
async function checkUserScriptsAvailable(): Promise<boolean> {
	try {
		await chrome.userScripts.getScripts();
		return true;
	} catch {
		return false;
	}
}

// eff: updates the status badge UI based on userScripts availability
async function updateStatusBadge(): Promise<void> {
	const badge = document.getElementById('userscripts-status');
	if (!badge) return;

	const available = await checkUserScriptsAvailable();

	if (available) {
		badge.textContent = t('opt_userscripts_status_enabled');
		badge.className = 'status-badge enabled';
	} else {
		badge.textContent = t('opt_userscripts_status_disabled');
		badge.className = 'status-badge disabled';
	}
}

// eff: opens the extension details page where user can enable userScripts
function openExtensionSettings(): void {
	const extensionId = chrome.runtime.id;
	// note: Chrome 138+ uses Allow User Scripts toggle on extension details page
	chrome.tabs.create({ url: `chrome://extensions/?id=${extensionId}` });
}

// eff: initializes the userScripts section with event listeners and status check
export async function initUserScriptsSection(): Promise<void> {
	await updateStatusBadge();

	const enableBtn = document.getElementById('userscripts-enable-btn');
	enableBtn?.addEventListener('click', openExtensionSettings);

	// note: re-check status when window regains focus (user may have enabled it)
	window.addEventListener('focus', () => {
		updateStatusBadge();
	});
}
