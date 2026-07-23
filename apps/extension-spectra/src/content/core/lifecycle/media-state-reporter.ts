// goal: event-driven media status synchronization without background polling

import { isExtensionContextValid, safeSend } from '../context-guard';
import type { PolicyExecutorState } from '../../types';
import { hasMediaElements } from './media-observer';
import { debounce, createCleanupManager, createEventListener } from '../../utils/timing';
import { sendSpectraRequest } from '../../../shared/spectra-client';
import { getActiveMediaRegistry } from '../media-registry';
import { updatePausedAt } from '../../utils/pause-tracker';

function updatePauseState(): void {
	const registry = getActiveMediaRegistry();
	updatePausedAt(
		registry?.hasPlayingMedia() ?? false,
		(registry?.size ?? 0) > 0,
	);
}

// eff: transmits the event-maintained registry state to the kernel
export function reportMediaState(state?: PolicyExecutorState): void {
	if (!isExtensionContextValid()) return;

	const hasMedia = hasMediaElements();
	const interacted = state ? (state.userHasInteracted || state.hasGesture) : false;

	safeSend(() => sendSpectraRequest('spectra.tab.media.report', {
		hasMediaElement: hasMedia,
		userInteracted: interacted,
	})).catch(() => {
		// note: failures usually indicate a closing tab session
	});
}

// eff: coalesces lifecycle events without a recurring heartbeat
export function createMediaStateReporter(
	state: PolicyExecutorState,
): () => void {
	const cleanup = createCleanupManager();
	const registry = getActiveMediaRegistry();
	if (!registry) throw new Error('The document media registry is unavailable');
	const report = debounce(() => reportMediaState(state), 100);
	cleanup.add(registry.subscribe(() => {
		updatePauseState();
		report();
	}));
	cleanup.add(createEventListener(document, 'visibilitychange', report));
	cleanup.add(report.cancel);
	updatePauseState();
	reportMediaState(state);
	return cleanup.dispose;
}
