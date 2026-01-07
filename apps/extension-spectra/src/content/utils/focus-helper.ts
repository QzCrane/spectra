// goal: restores keyboard focus to video elements after browser UI transitions (e.g., exiting Fullscreen or PiP)
// note: necessary because hotkey listeners often rely on the active element for event capture

import { createLogger } from '../../shared/logger';

const log = createLogger('FocusHelper');

// eff: dispatches synthetic mouse events and invokes .focus() on the video and its nearest player container
function doFocusRecovery(video: HTMLVideoElement): void {
	const rect = video.getBoundingClientRect();
	const centerX = rect.left + rect.width / 2;
	const centerY = rect.top + rect.height / 2;

	video.dispatchEvent(new MouseEvent('mousemove', {
		bubbles: true, cancelable: true, clientX: centerX, clientY: centerY, view: window,
	}));
	video.dispatchEvent(new MouseEvent('mouseenter', {
		bubbles: false, cancelable: true, clientX: centerX, clientY: centerY, view: window,
	}));
	video.dispatchEvent(new MouseEvent('mouseover', {
		bubbles: true, cancelable: true, clientX: centerX, clientY: centerY, view: window,
	}));

	video.focus();

	const container = video.closest('.video-container, .player, [class*="player"], [class*="video"]');
	if (container instanceof HTMLElement) {
		container.focus();
	}
}

// eff: schedules multiple focus recovery attempts to counteract asynchronous DOM layout shifts and animations
// rule: retries 5 times across a 1s window (0ms, 100ms, 300ms, 500ms, 1000ms)
export function simulateMouseHover(video: HTMLVideoElement): void {
	// inv: ensure the element is focusable via script by assigning a tabindex if missing
	if (!video.hasAttribute('tabindex')) {
		video.setAttribute('tabindex', '-1');
	}

	doFocusRecovery(video);

	setTimeout(() => doFocusRecovery(video), 100);
	setTimeout(() => doFocusRecovery(video), 300);
	setTimeout(() => doFocusRecovery(video), 500);
	setTimeout(() => doFocusRecovery(video), 1000);

	log.info('Focus recovery scheduled (5 attempts)');
}
