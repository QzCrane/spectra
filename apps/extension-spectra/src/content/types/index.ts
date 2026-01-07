// goal: centralizes core type definitions for the content script ecosystem

import type { AudioConfig, NexusMessenger } from '@nexus/kernel';
import { PolicyEngine, WebAudioController } from '@nexus/audio-engine';
import type { CaptureManager } from '../audio/capture-manager';
import type { SettingsManager } from '../core/settings-manager';

// PolicyExecutorState: shared mutable state tracked during the tab session
export interface PolicyExecutorState {
	config: AudioConfig;
	activeMode: string | null;
	// hasGesture: True if the browser has received a user gesture (click/key) required for AudioContext
	hasGesture: boolean;
	// userHasInteracted: sticky marker; True if user has explicitly tweaked audio via Spectra's UI or hotkeys
	userHasInteracted: boolean;
	isPopupOpen: boolean;
}

// PolicyExecutorDeps: dependency injection container for the executor lifecycle
export interface PolicyExecutorDeps {
	messenger: NexusMessenger;
	policyEngine: PolicyEngine;
	audioController: WebAudioController;
	captureManager: CaptureManager;
	settingsManager: SettingsManager;
}
