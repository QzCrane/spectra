// goal: centralizes type definitions for the PolicyExecutor submodule to prevent circular dependencies

import type { AudioConfig } from '@nexus/kernel';
import type { UrlInfo } from '@nexus/audio-engine';

// PolicyExecutor: public interface exposed to the main content script lifecycle (index.ts)
export interface PolicyExecutor {
	// eff: re-calculates the optimal AudioMode and synchronizes the active execution layer
	applyState(): void;
	updateBadge(): void;
	// note: main entry point for configuration changes originating from hotkeys or background messages
	updateConfig(changes: Partial<AudioConfig>, options?: { showOSD?: boolean; unMute?: boolean; isNativeSync?: boolean }): void;
	hasUserGesture(): boolean;
	markUserInteracted(): void;
	getActiveMode(): string | null;
	getUrlInfo(): UrlInfo;
	probeCors(): void;
}

// CorsStatus: transient markers used during the discovery phase of domain compatibility
export type CorsStatus = 'PENDING' | 'SAFE' | 'RESTRICTED';

// InternalState: shared volatile state bundle for submodule coordination
export interface InternalState {
	corsStatus: CorsStatus;
	// lastBadgeHash: deduplication key for repetitive badge update messages
	lastBadgeHash: string;
	// lastSyncHash: deduplication key for popup UI broadcasting
	lastSyncHash: string;
}
