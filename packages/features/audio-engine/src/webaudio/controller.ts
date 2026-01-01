// goal: main controller for managing the WebAudio graph and media element attachments
// note: world-class performance: uses centralized detachment and a factory for lean management

import { AudioParams, CompressorOn, CompressorNativeOff } from '../constants.js';
import { scheduleCorsCheck } from './cors-checker.js';
import { createAudioGraph, disconnectAudioGraph } from './node-factory.js';
import type { AudioConfig, AudioNodeSet, AudioMediaElement, CorsDetectedCallback, CorsSuccessCallback } from './types.js';

export type { AudioConfig, CorsDetectedCallback, CorsSuccessCallback };

export class WebAudioController {
	private ctx: AudioContext | null = null;
	private onCorsDetected: CorsDetectedCallback | null = null;
	private onCorsSuccess: CorsSuccessCallback | null = null;
	private skipCorsCheck = false;
	private attachedNodes = new WeakMap<HTMLMediaElement, AudioNodeSet>();

	async initialize(attemptResume = false): Promise<boolean> {
		if (this.ctx && this.ctx.state !== 'closed') {
			if (this.ctx.state === 'suspended' && attemptResume) {
				try { await this.ctx.resume(); } catch { return false; }
			}
			return this.ctx.state === 'running';
		}
		try {
			const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
			this.ctx = new AC();
			if (attemptResume && this.ctx.state === 'suspended') this.ctx.resume().catch(() => { });
			return this.ctx.state === 'running';
		} catch { return false; }
	}

	cleanup(): void {
		if (!this.ctx) return;
		const t = this.ctx.currentTime, r = AudioParams.SMOOTH_TIME_FAST;
		document.querySelectorAll('video, audio').forEach((el) => {
			const m = el as AudioMediaElement;
			if (!m._vm) return;
			const { gain, bass, comp, eqNodes } = m._vm;
			gain.gain.setTargetAtTime(1, t, r);
			gain.channelCount = 2;
			bass.gain.setTargetAtTime(0, t, r);
			comp.threshold.setTargetAtTime(CompressorNativeOff.threshold, t, r);
			comp.ratio.setTargetAtTime(CompressorNativeOff.ratio, t, r);
			eqNodes.forEach((n) => n.gain.setTargetAtTime(0, t, r));
		});
	}

	isReady(): boolean { return this.ctx !== null && this.ctx.state !== 'closed'; }

	setCallbacks(onDetected: CorsDetectedCallback, onSuccess: CorsSuccessCallback): void {
		this.onCorsDetected = onDetected;
		this.onCorsSuccess = onSuccess;
	}

	scanAndAttach(): number {
		if (!this.ctx) return 0;
		let attached = 0;
		document.querySelectorAll('video, audio').forEach((el) => {
			if (this.attachNode(el as HTMLMediaElement)) attached++;
		});
		return attached;
	}

	attachNode(el: HTMLMediaElement): boolean {
		const m = el as AudioMediaElement;
		if (m._vm || m.dataset.vmAttached === 'true' || m.dataset.vmProbed === 'true' || !this.ctx) return false;

		try {
			if (!el.crossOrigin && el.src && !el.src.startsWith('data:') && !el.src.startsWith('blob:')) {
				el.crossOrigin = 'anonymous';
			}

			m._vm = createAudioGraph(this.ctx, el);
			m.dataset.vmAttached = 'true';
			this.attachedNodes.set(el, m._vm);

			el.addEventListener('play', () => {
				if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => { });
			});

			if (!this.skipCorsCheck) {
				scheduleCorsCheck(m._vm.analyser, el, (restricted) => {
					if (restricted) this.handleCorsDetected();
					else this.handleCorsSuccess();
				});
			}
			return true;
		} catch {
			this.handleCorsDetected();
			return false;
		}
	}

	detachNode(el: HTMLMediaElement): void {
		const vm = this.attachedNodes.get(el);
		if (!vm) return;

		try {
			disconnectAudioGraph(vm);
			const m = el as AudioMediaElement;
			delete m._vm;
			delete m.dataset.vmAttached;
			this.attachedNodes.delete(el);
		} catch (e) {
			console.warn('[Spectra] Detach failed:', e);
		}
	}

	updateParams(config: AudioConfig): void {
		if (!this.ctx) return;
		const t = this.ctx.currentTime, r = AudioParams.SMOOTH_TIME_FAST;
		const v = config.muted ? 0 : config.volume / 100;

		document.querySelectorAll('video, audio').forEach((el) => {
			const m = el as AudioMediaElement;
			if (!m._vm) return;
			const { gain, bass, comp, eqNodes, panner, delayNode } = m._vm;

			gain.gain.setTargetAtTime(v, t, r);
			gain.channelCount = config.mono ? 1 : 2;
			bass.gain.setTargetAtTime(config.bass ? AudioParams.BASS_GAIN : 0, t, r);

			const cThresh = config.compressor ? CompressorOn.threshold : CompressorNativeOff.threshold;
			const cRatio = config.compressor ? CompressorOn.ratio : CompressorNativeOff.ratio;
			comp.threshold.setTargetAtTime(cThresh, t, r);
			comp.ratio.setTargetAtTime(cRatio, t, r);

			eqNodes.forEach((n, i) => n.gain.setTargetAtTime(config.eqValues[i] ?? 0, t, r));
			panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, config.pan ?? 0)), t, r);
			delayNode.delayTime.setTargetAtTime((config.delay ?? 0) / 1000, t, r);
		});
	}

	getVisualizerData(): number[] | null {
		if (!this.ctx) return null;
		for (const el of document.querySelectorAll('video, audio')) {
			const m = el as AudioMediaElement;
			if (m._vm?.analyser) {
				const data = new Uint8Array(m._vm.analyser.frequencyBinCount);
				m._vm.analyser.getByteFrequencyData(data);
				return Array.from(data);
			}
		}
		return null;
	}

	private handleCorsSuccess(): void { this.onCorsSuccess?.(window.location.hostname); }
	private handleCorsDetected(): void { this.onCorsDetected?.(window.location.hostname); }
}
