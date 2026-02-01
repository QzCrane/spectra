// goal: manages tab capture session lifecycle, including stream ID acquisition and offscreen routing

import { router, captureStates, captureLocks } from '../state';
import { ensureOffscreen, closeOffscreen } from '../helpers';
import { swLog } from '../../shared/logger';
import { Actions, OffscreenActions } from '@nexus/contracts';

// inv: 45s idle timeout to close offscreen document when no captures are active
const IDLE_TIMEOUT = 45000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

// eff: checks for active capture sessions and schedules/cancels offscreen cleanup
function checkOffscreenIdle(): void {
	let activeCount = 0;
	for (const v of captureStates.values()) {
		if (v) activeCount++;
	}

	if (activeCount === 0) {
		if (!idleTimer) {
			swLog.debug(`No active captures, scheduling offscreen cleanup in ${IDLE_TIMEOUT}ms`);
			idleTimer = setTimeout(() => {
				closeOffscreen().catch(() => { });
				idleTimer = null;
			}, IDLE_TIMEOUT);
		}
	} else {
		if (idleTimer) {
			swLog.debug('Active capture detected, cancelling cleanup');
			clearTimeout(idleTimer);
			idleTimer = null;
		}
	}
}

// eff: registers listeners for CAPTURE_TOGGLE, CAPTURE_GET_STATE, and CAPTURE_UPDATE_CONFIG actions
export function registerCaptureHandlers(): void {
	router.on('CAPTURE_TOGGLE', async (req, sender) => {
		const tabId = req.tabId ?? sender.tab?.id;
		swLog.capture(`CAPTURE_TOGGLE received: enabled=${req.enabled}, tabId=${tabId}`);

		if (!tabId) {
			swLog.warn('CAPTURE_TOGGLE failed: No tab ID');
			return { status: 'error' as const, error: 'No tab ID' };
		}

		// inv: lock prevents concurrent toggle requests for the same tab within 500ms
		if (captureLocks.get(tabId)) {
			swLog.debug(`CAPTURE_TOGGLE skipped: Tab ${tabId} is locked`);
			return { status: 'processing' as const };
		}

		captureLocks.set(tabId, true);

		try {
			if (req.enabled) {
				if (captureStates.get(tabId)) {
					swLog.capture(`Tab ${tabId} already capturing, syncing config`);
					if (req.config) {
						chrome.runtime.sendMessage({
							target: 'offscreen',
							action: OffscreenActions.OFFSCREEN_UPDATE_CONFIG,
							tabId,
							config: req.config
						}).catch(() => { });
					}
					return { status: 'processing' as const };
				}

				await ensureOffscreen();
				checkOffscreenIdle(); // cancel any pending cleanup

				// eff: request a MediaStream ID for the target tab to be consumed by the offscreen AudioContext
				const streamId = await new Promise<string>((resolve, reject) => {
					chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (sid) => {
						if (chrome.runtime.lastError) {
							reject(new Error(chrome.runtime.lastError.message || 'Tab capture failed'));
						} else if (!sid) {
							reject(new Error('No Stream ID returned'));
						} else {
							resolve(sid);
						}
					});
				});

				chrome.runtime.sendMessage({
					target: 'offscreen',
					action: OffscreenActions.OFFSCREEN_START,
					tabId,
					streamId,
					config: req.config
				});

				captureStates.set(tabId, true);
				swLog.capture(`Tab ${tabId}: Capture started`);

				const notifyPayload = { tabId, enabled: true };
				chrome.tabs.sendMessage(tabId, { action: Actions.CAPTURE_STATE_CHANGE, payload: notifyPayload }).catch(() => { });
				chrome.runtime.sendMessage({ action: Actions.CAPTURE_STATE_CHANGE, payload: notifyPayload }).catch(() => { });

				checkOffscreenIdle(); // verify active count

			} else {
				swLog.capture(`Tab ${tabId}: Stopping capture...`);
				if (captureStates.get(tabId)) {
					chrome.runtime.sendMessage({ target: 'offscreen', action: OffscreenActions.OFFSCREEN_STOP, tabId });
					captureStates.set(tabId, false);
				}

				const notifyPayload = { tabId, enabled: false };
				chrome.tabs.sendMessage(tabId, { action: Actions.CAPTURE_STATE_CHANGE, payload: notifyPayload }).catch(() => { });
				chrome.runtime.sendMessage({ action: Actions.CAPTURE_STATE_CHANGE, payload: notifyPayload }).catch(() => { });

				checkOffscreenIdle(); // schedule cleanup if last tab
			}

			return { status: 'processing' as const };
		} catch (e) {
			const errorMsg = e instanceof Error ? e.message : JSON.stringify(e);
			swLog.error(`Capture Toggle Failed (Tab ${tabId}): ${errorMsg}`);
			captureStates.set(tabId, false);
			checkOffscreenIdle();
			return { status: 'error' as const, error: errorMsg };
		} finally {
			// note: release lock after a fixed delay to ensure state transitions complete
			setTimeout(() => captureLocks.delete(tabId), 500);
		}
	});

	router.on('CAPTURE_GET_STATE', async (req, sender) => {
		const tabId = req.tabId ?? sender.tab?.id;
		if (!tabId) return false;
		return captureStates.get(tabId) ?? false;
	});

	router.on('CAPTURE_UPDATE_CONFIG', async (req, sender) => {
		const tabId = req.tabId ?? sender.tab?.id;
		if (!tabId || !captureStates.get(tabId)) return;

		swLog.debug(`CAPTURE_UPDATE_CONFIG: Tab ${tabId}, vol=${req.config.volume}`);
		chrome.runtime.sendMessage({
			target: 'offscreen',
			action: OffscreenActions.OFFSCREEN_UPDATE_CONFIG,
			tabId,
			config: req.config
		}).catch(() => { });
	});
}

// eff: internal helper to force stop capture and broadcast state change
export function handleCaptureToggle(tabId: number, enabled: boolean): void {
	if (!enabled && captureStates.get(tabId)) {
		chrome.runtime.sendMessage({ target: 'offscreen', action: OffscreenActions.OFFSCREEN_STOP, tabId });
		captureStates.set(tabId, false);
		const notifyPayload = { tabId, enabled: false };
		chrome.tabs.sendMessage(tabId, { action: Actions.CAPTURE_STATE_CHANGE, payload: notifyPayload }).catch(() => { });

		checkOffscreenIdle(); // schedule cleanup
	}
}
