// goal: centralizes core type definitions for the content script ecosystem

import type { AudioConfig, NexusMessenger } from '@nexus/kernel';
import { PolicyEngine, WebAudioController } from '@nexus/audio-engine';
import type { CaptureManager } from './capture-manager';
import type { SettingsManager } from './settings-manager';

// PolicyExecutorState: shared mutable state tracked during the tab session
export interface PolicyExecutorState {
	config: AudioConfig;
	activeMode: string | null;
	// userHasInteracted: sticky marker; True if user has ever tweaked audio via UI or hotkeys
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
