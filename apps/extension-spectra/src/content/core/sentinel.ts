// goal: manages the handover of state between extension versions during a zero-refresh update
// note: uses a DOM-linked buffer to ensure sub-millisecond, synchronous state transfer

import { logger } from '../../shared/logger';
import type { PolicyExecutorState } from '../types';

const log = logger.content;
const STUB_ID = '__SPECTRA_STATE_STUB__';

/**
 * Serializes the current state into a lightweight, version-agnostic format
 */
export function createSnapshot(state: PolicyExecutorState): string {
	return JSON.stringify({
		version: chrome.runtime.getManifest().version,
		config: state.config,
		userHasInteracted: state.userHasInteracted,
		hasGesture: state.hasGesture,
		timestamp: Date.now()
	});
}

/**
 * Injects a hidden DOM element to hold the state during the handover gap
 */
export function mountStub(snapshot: string): void {
	let el = document.getElementById(STUB_ID);
	if (!el) {
		el = document.createElement('div');
		el.id = STUB_ID;
		el.style.display = 'none';
		document.documentElement.appendChild(el);
	}
	el.setAttribute('data-state', snapshot);
	log.debug('[Sentinel] State stub mounted for next version');
}

/**
 * Attempts to retrieve and parse the state from a previous version's stub
 */
export function consumeStub(): Partial<PolicyExecutorState> | null {
	const el = document.getElementById(STUB_ID);
	if (!el) return null;

	const raw = el.getAttribute('data-state');
	el.remove(); // inv: single-shot consumption to prevent duplicate recovery

	if (!raw) return null;

	try {
		const data = JSON.parse(raw);
		// rule: ignore stubs older than 30 seconds to prevent stale state inheritance
		if (Date.now() - data.timestamp > 30000) {
			log.warn('[Sentinel] Found stale stub, ignoring');
			return null;
		}
		log.info(`[Sentinel] Recovered state from v${data.version}`);
		return {
			config: data.config,
			userHasInteracted: data.userHasInteracted,
			hasGesture: data.hasGesture
		};
	} catch (e) {
		log.error('[Sentinel] Failed to parse state stub', e);
		return null;
	}
}
