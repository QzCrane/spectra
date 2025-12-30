// goal: manages the extension icon badge (text and background color) based on user interaction and audio state
// rule: the badge is "sticky" per tab but only appears if the user has explicitly interacted with audio settings

import { router, badgeState, BADGE_COLORS } from '../state';
import { isTabExists } from '../helpers';

// eff: registers listeners for BADGE_UPDATE and BADGE_CLEAR actions
export function registerBadgeHandlers(): void {
	router.on('BADGE_UPDATE', async (req, sender) => {
		const tabId = req.tabId ?? sender.tab?.id;
		if (!tabId) return;

		// pre: verify the tab still exists before attempting UI updates
		if (!await isTabExists(tabId)) {
			badgeState.delete(tabId);
			return;
		}

		const { volume, muted, isCapture, userInteracted } = req;

		// rule: if no user interaction is detected, suppressed the badge to maintain a clean UI
		if (!userInteracted) {
			badgeState.delete(tabId);
			try {
				await chrome.action.setBadgeText({ tabId, text: '' });
			} catch { }
			return;
		}

		// eff: calculate badge visuals (M for muted, numeric volume otherwise; color reflects mode)
		let badgeText = '';
		let badgeColor: string = isCapture ? BADGE_COLORS.CAPTURE : BADGE_COLORS.NATIVE;

		if (muted || volume === 0) {
			badgeText = 'M';
			badgeColor = BADGE_COLORS.MUTED;
		} else {
			badgeText = volume.toString();
		}

		badgeState.set(tabId, { volume, muted, isCapture, text: badgeText });

		try {
			await chrome.action.setBadgeText({ tabId, text: badgeText });
			await chrome.action.setBadgeBackgroundColor({ tabId, color: badgeColor });
			await chrome.action.setBadgeTextColor({ tabId, color: BADGE_COLORS.WHITE });
		} catch {
			badgeState.delete(tabId);
		}
	});

	router.on('BADGE_CLEAR', async (req, sender) => {
		const tabId = req.tabId ?? sender.tab?.id;
		if (!tabId) return;

		badgeState.delete(tabId);

		chrome.action.setBadgeText({ tabId, text: '' }).catch(() => { });
	});
}
