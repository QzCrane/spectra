// goal: centralizes core type definitions for the content script ecosystem

import type { AudioConfig } from '@nexus/kernel';
import { PolicyEngine, WebAudioController } from '@nexus/audio-engine';
import type { AudioModeType } from '@nexus/audio-engine';
import type { CaptureManager } from '../audio/capture-manager';
import type { SettingsManager } from '../core/settings-manager';

// PolicyExecutorState: shared mutable state tracked during the tab session
export interface PolicyExecutorState {
	config: AudioConfig;
	// Last configuration confirmed on the actual processing path. Desired config
	// may move ahead while a mode transition is still pending.
	appliedConfig: AudioConfig;
	// activeMode is retained as the policy-selected mode for v1 callers.
	activeMode: AudioModeType | null;
	desiredMode: AudioModeType | null;
	actualMode: 'bypass' | 'webaudio' | 'capture';
	phase: 'idle' | 'starting' | 'active' | 'stopping' | 'error';
	generation: number;
	lastError?: string;
	// hasGesture: True if the browser has received a user gesture (click/key) required for AudioContext
	hasGesture: boolean;
	// userHasInteracted: sticky marker; True if user has explicitly tweaked audio via Spectra's UI or hotkeys
	userHasInteracted: boolean;
	isPopupOpen: boolean;
	// Volatile analyser demand. This is a live Popup lease, not a persisted
	// preference, and it may temporarily admit a neutral audio processor.
	visualizerSubscribed?: boolean;
}

// PolicyExecutorDeps: dependency injection container for the executor lifecycle
export interface PolicyExecutorDeps {
	policyEngine: PolicyEngine;
	audioController: WebAudioController;
	captureManager: CaptureManager;
	settingsManager: SettingsManager;
}

// ContentDeps: full dependency container for content script initialization
export interface ContentDeps extends PolicyExecutorDeps {
	state: PolicyExecutorState;
	policyExecutor?: import('../logic/policy-executor').PolicyExecutor;
	getVisualizerData: () => Uint8Array | null;
	setVisualizerSubscribed: (subscribed: boolean) => Promise<boolean>;
}
