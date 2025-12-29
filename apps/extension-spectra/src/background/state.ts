// goal: centralized in-memory state management for the Background Service Worker lifecycle

import { createRouter, StorageRepository } from '@nexus/kernel';
import { UIColors } from '@nexus/audio-engine';

export interface BadgeInfo {
	volume: number;
	muted: boolean;
	isCapture: boolean;
	text: string;
}

export const BADGE_COLORS = UIColors;

export const router = createRouter();
export const storage = new StorageRepository();

// tabId -> isCaptureActive
export const captureStates = new Map<number, boolean>();

// tabId -> isLocked (inv: prevents concurrent capture requests for the same tab)
export const captureLocks = new Map<number, boolean>();

// tabId -> BadgeInfo
export const badgeState = new Map<number, BadgeInfo>();

// goal: tracks tab eligibility for UI prioritization and management
export interface TabAudioState {
	hasMediaElement: boolean;
	// lastAudibleTime: timestamp when the tab last produced sound
	lastAudibleTime: number;
	lastActivatedTime: number;
	// userManuallyActivated: true if the user explicitly interacted with this tab in the current session
	userManuallyActivated: boolean;
}

// currentSessionId: unique identifier for the current service worker execution context
export const currentSessionId = Date.now();

// tabId -> TabAudioState
export const tabAudioStates = new Map<number, TabAudioState>();

// TAB_VISIBLE_THRESHOLD_MS: cutoff for considering a tab as "recently active" (60s)
export const TAB_VISIBLE_THRESHOLD_MS = 60 * 1000;

// eff: clears all volatile in-memory state associated with a tabId
export function cleanupTabState(tabId: number): void {
	captureStates.delete(tabId);
	captureLocks.delete(tabId);
	badgeState.delete(tabId);
	tabAudioStates.delete(tabId);
}
