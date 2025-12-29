// goal: manages background periodic tasks for state persistence and media status synchronization
// note: specific intervals are chosen to balance UI responsiveness and CPU consumption

import { AudioMode } from '@nexus/audio-engine';
import { isExtensionContextValid, safeSend } from '../context-guard';
import { logger } from '../../shared/logger';
import type { PolicyExecutorState } from '../types';
import type { PolicyExecutor } from '../policy-executor';
import type { NexusMessenger } from '@nexus/kernel';
import { hasMediaElements } from './media-observer';

const log = logger.content;

interface IntervalCleanup {
	stateReapply: ReturnType<typeof setInterval>;
	mediaReport: ReturnType<typeof setInterval>;
}

// eff: sets up a 3-second heartbeat to re-sync DSP nodes if the browser detaches them during page suspension
// rule: skips execution if the document is hidden or the extension context has been invalidated
export function createStateReapplyInterval(
	state: PolicyExecutorState,
	policyExecutor: PolicyExecutor,
	onContextInvalid?: () => void
): ReturnType<typeof setInterval> {
	return setInterval(() => {
		if (document.hidden) return;

		if (!isExtensionContextValid()) {
			onContextInvalid?.();
			return;
		}

		if (state.activeMode === AudioMode.NATIVE_LITE || state.activeMode === AudioMode.NATIVE_WEBAUDIO) {
			policyExecutor.applyState();
		}
	}, 3000);
}

// eff: sets up a 5-second polling task to inform the background service about the presence of media elements
export function createMediaReportInterval(
	messenger: NexusMessenger,
	onContextInvalid?: () => void
): ReturnType<typeof setInterval> {
	return setInterval(() => {
		if (!isExtensionContextValid()) {
			onContextInvalid?.();
			return;
		}
		reportMediaState(messenger);
	}, 5000);
}

// eff: performs a DOM scan for media tags and transmits the discovery state to the kernel
export function reportMediaState(messenger: NexusMessenger): void {
	if (!isExtensionContextValid()) return;

	const hasMedia = hasMediaElements();
	safeSend(() => messenger.send('TAB_REPORT_MEDIA', { hasMediaElement: hasMedia })).catch(() => {
		// note: failures usually indicate a closing tab session
	});
}

// eff: terminates all active timers to prevent memory leaks during module disposal
export function cleanupIntervals(intervals: Partial<IntervalCleanup>): void {
	if (intervals.stateReapply) clearInterval(intervals.stateReapply);
	if (intervals.mediaReport) clearInterval(intervals.mediaReport);
}
