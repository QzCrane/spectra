import type { SiteBridge, BridgeCallbacks } from './types';

export class DefaultBridge implements SiteBridge {
	readonly id = 'default';

	isMatch(): boolean {
		return true;
	}

	onInitialize(_callbacks: BridgeCallbacks): void {
		// Generic DOM listeners are handled by VolumeObserver
	}

	syncVolume(_volume: number, _muted: boolean): void {
		// Standard DOM media sync is handled by mode-executor -> dom-volume
	}

	syncSpeed(_speed: number): void {
		// Standard DOM media sync is handled by mode-executor -> media-control
	}

	shouldInhibitDomSync(): boolean {
		return false;
	}

	canPullInitialState(): boolean {
		return true;
	}
}
