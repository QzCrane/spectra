// goal: centralized in-memory state management for the Background Service Worker lifecycle

import { createRouter, StorageRepository } from '@nexus/kernel';
import { UIColors } from '@nexus/audio-engine';

export interface BadgeInfo {
	volume: number;
	muted: boolean;
	enabled: boolean;
	isCapture: boolean;
	userInteracted: boolean;
	authority: 'control' | 'session' | 'legacy';
	text: string;
	documentId: string | null;
	origin: string | null;
	generation: number | null;
}

export const BADGE_COLORS = UIColors;

export const router = createRouter();
export const storage = new StorageRepository();

// tabId -> isCaptureActive
export const captureStates = new Map<number, boolean>();

// tabId -> BadgeInfo
export const badgeState = new Map<number, BadgeInfo>();

// goal: tracks tab eligibility for UI prioritization and management
export interface TabAudioState {
	hasMediaElement: boolean;
	// lastAudibleTime: timestamp when the tab last produced sound
	lastAudibleTime: number;
	lastActivatedTime: number;
	isAudible: boolean;
	// Telemetry only. Visibility is derived exclusively from Chrome-owned active,
	// audible and bounded recent timestamps.
	userManuallyActivated: boolean;
}

// currentSessionId: unique identifier for the current service worker execution context
export const currentSessionId = Date.now();

// tabId -> TabAudioState
export const tabAudioStates = new Map<number, TabAudioState>();

export function getOrCreateTabAudioState(tabId: number): TabAudioState {
	const existing = tabAudioStates.get(tabId);
	if (existing) return existing;
	const state: TabAudioState = {
		hasMediaElement: false,
		lastAudibleTime: 0,
		lastActivatedTime: 0,
		isAudible: false,
		userManuallyActivated: false,
	};
	tabAudioStates.set(tabId, state);
	return state;
}

export function markTabActivated(tabId: number, now = Date.now()): void {
	const state = getOrCreateTabAudioState(tabId);
	state.lastActivatedTime = now;
	state.userManuallyActivated = true;
}

export function markTabAudible(tabId: number, audible: boolean, now = Date.now()): void {
	const existing = tabAudioStates.get(tabId);
	// Chrome can report `audible: false` for a tab that never produced sound.
	// Do not let that create a synthetic recent-audio lease.
	if (!audible && !existing?.isAudible) return;
	const state = existing ?? getOrCreateTabAudioState(tabId);
	state.isAudible = audible;
	state.lastAudibleTime = now;
}

// TAB_VISIBLE_THRESHOLD_MS: cutoff for considering a tab as "recently active" (60s)
export const TAB_VISIBLE_THRESHOLD_MS = 60 * 1000;

// eff: clears all volatile in-memory state associated with a tabId
export function cleanupTabState(tabId: number, options: { preserveCapture?: boolean } = {}): void {
	if (!options.preserveCapture) captureStates.delete(tabId);
	badgeState.delete(tabId);
	tabAudioStates.delete(tabId);
}
