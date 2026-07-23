// goal: centralizes type definitions for the PolicyExecutor submodule to prevent circular dependencies

import type { AudioConfig } from '@nexus/kernel';
import type { CaptureAdmission, SpectraResponse } from '@nexus/contracts';
import type { UrlInfo } from '@nexus/audio-engine';

export interface PolicyApplicationOptions {
	navigation?: boolean;
	modeIntent?: boolean;
	captureAdmission?: CaptureAdmission;
}

export interface PolicyUpdateOptions {
	showOSD?: boolean;
	isNativeSync?: boolean;
	captureAdmission?: CaptureAdmission;
}

// PolicyExecutor: public interface exposed to the main content script lifecycle (index.ts)
export interface PolicyExecutor {
	dispose(): void;
	// eff: re-calculates the optimal AudioMode and synchronizes the active execution layer
	applyState(options?: PolicyApplicationOptions): Promise<void>;
	updateBadge(): void;
	// note: main entry point for configuration changes originating from hotkeys or background messages
	updateConfig(
		changes: Partial<AudioConfig>,
		options?: PolicyUpdateOptions,
	): Promise<SpectraResponse<'spectra.audio.config.set'>>;
	hasUserGesture(): boolean;
	markUserInteracted(): void;
	getActiveMode(): string | null;
	getUrlInfo(): UrlInfo;
}

// CorsStatus: current resource-level MediaElementSource admission summary.
export type CorsStatus = 'PENDING' | 'SAFE' | 'RESTRICTED';

// InternalState: shared volatile state bundle for submodule coordination
export interface InternalState {
	corsStatus: CorsStatus;
	// lastBadgeHash: deduplication key for repetitive badge update messages
	lastBadgeHash: string;
	// lastSyncHash: deduplication key for popup UI broadcasting
	lastSyncHash: string;
	// Serializes config persistence so a slower earlier message cannot overwrite
	// the newest runtime.configure value in the background session repository.
	configPersistenceTail?: Promise<void>;
}
