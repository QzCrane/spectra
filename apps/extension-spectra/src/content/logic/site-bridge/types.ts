import type { AudioConfig } from '@nexus/kernel';

export type BridgeCallbacks = {
	updateConfig: (changes: Partial<AudioConfig>, options?: { isNativeSync?: boolean }) => void;
};

export interface SiteBridge {
	/** Unique identifier for the bridge */
	readonly id: string;

	/** Check if this bridge should be active for the current site */
	isMatch(): boolean;

	/** Initialize site-specific listeners and hooks */
	onInitialize(callbacks: BridgeCallbacks): void;

	/** Sync Spectra volume/mute state to site-specific player */
	syncVolume(volume: number, muted: boolean): void;

	/** Sync Spectra playback speed to site-specific player */
	syncSpeed(speed: number): void;

	/** 
	 * If true, Spectra will ignore native DOM 'volumechange' events.
	 * Required for sites that internally manipulate <video>.volume (like YouTube).
	 */
	shouldInhibitDomSync(): boolean;

	/**
	 * If true, Spectra allows pulling initial volume from the DOM on load.
	 * Usually false for sites with aggressive volume resets.
	 */
	canPullInitialState(): boolean;
}
