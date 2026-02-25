import type { AudioConfig } from '@nexus/kernel';
import type { SiteBridge, BridgeCallbacks } from './types';
import { logger } from '../../../shared/logger';

const log = logger.content;

// inv: last values to prevent message loops between contexts
type ValueCache = { value: number; ts: number };

export class YouTubeBridge implements SiteBridge {
	readonly id = 'youtube';

	private isInitialized = false;
	private lastSpeed: ValueCache | null = null;
	private lastVol: ValueCache | null = null;
	private lastMuted: { value: boolean; ts: number } | null = null;

	isMatch(): boolean {
		const host = window.location.hostname;
		return host.includes('youtube.com') || host.includes('youtu.be');
	}

	onInitialize(callbacks: BridgeCallbacks): void {
		if (this.isInitialized) return;
		this.isInitialized = true;

		// eff: listen for authoritative responses from the MAIN world injector
		window.addEventListener('message', (e) => {
			if (!e.data) return;

			// rule: authoritative sync from YT player API (movie_player.addEventListener)
			if (e.data.type === 'SPECTRA_YT_SYNC_BACK') {
				const { volume, muted, speed } = e.data;
				const changes: Partial<AudioConfig> = {};
				const now = Date.now();

				if (volume !== undefined && volume >= 0) {
					changes.volume = volume;
					changes.muted = muted;
					// sync internal cache to prevent command blocking
					this.lastVol = { value: volume, ts: now };
					this.lastMuted = { value: muted, ts: now };
				}
				if (speed !== undefined) {
					changes.speed = speed;
					// sync internal cache to prevent command blocking
					this.lastSpeed = { value: speed, ts: now };
				}

				log.debug(`[YouTubeBridge] Auth Sync Back (Cache Synced):`, changes);
				callbacks.updateConfig(changes, { isNativeSync: true });
				return;
			}

			if (e.data.type === 'SPECTRA_YT_SPEED_OK') {
				log.debug(`[YouTubeBridge] Speed Confirmed: ${e.data.speed}x`);
			}
			if (e.data.type === 'SPECTRA_YT_VOLUME_OK') {
				log.debug(`[YouTubeBridge] Volume Confirmed: ${e.data.volume}% muted=${e.data.muted}`);
			}
			if (e.data.type === 'SPECTRA_YT_FAIL') {
				log.warn('[YouTubeBridge] YT API sync failed:', e.data.error);
				if (e.data.feature === 'speed') this.lastSpeed = null;
				if (e.data.feature === 'volume') { this.lastVol = null; this.lastMuted = null; }
			}
		});
	}

	syncVolume(volume: number, muted: boolean): void {
		const now = Date.now();
		const volSkip = this.lastVol && Math.abs(this.lastVol.value - volume) < 1 && now - this.lastVol.ts < 100;
		const muteSkip = this.lastMuted && this.lastMuted.value === muted && now - this.lastMuted.ts < 100;

		if (volSkip && muteSkip) return;

		if (!volSkip) this.lastVol = { value: volume, ts: now };
		if (!muteSkip) this.lastMuted = { value: muted, ts: now };

		window.postMessage({ type: 'SPECTRA_YT_VOLUME', volume, muted }, '*');
	}

	syncSpeed(speed: number): void {
		const now = Date.now();
		if (this.lastSpeed && Math.abs(this.lastSpeed.value - speed) < 0.005 && now - this.lastSpeed.ts < 100) return;
		this.lastSpeed = { value: speed, ts: now };

		window.postMessage({ type: 'SPECTRA_YT_SPEED', speed }, '*');
	}

	shouldInhibitDomSync(): boolean {
		return true;
	}

	canPullInitialState(): boolean {
		return false;
	}
}
