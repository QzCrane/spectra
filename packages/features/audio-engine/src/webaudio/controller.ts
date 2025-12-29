// goal: main controller for managing the WebAudio graph and media element attachments

import { AudioParams, CompressorOn, CompressorNativeOff } from '../constants.js';
import { scheduleCorsCheck } from './cors-checker.js';
import type { AudioConfig, AudioNodeSet, AudioMediaElement, CorsDetectedCallback, CorsSuccessCallback } from './types.js';

export type { AudioConfig, CorsDetectedCallback, CorsSuccessCallback };

export class WebAudioController {
	private ctx: AudioContext | null = null;
	private onCorsDetected: CorsDetectedCallback | null = null;
	private onCorsSuccess: CorsSuccessCallback | null = null;
	private skipCorsCheck = false;

	// eff: initializes or resumes the AudioContext
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

	// eff: smoothly resets all audio nodes to neutral states before disposal
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

	setSkipCorsCheck(skip: boolean): void { this.skipCorsCheck = skip; }

	// eff: finds all media elements in the DOM and attempts to attach audio nodes
	scanAndAttach(): number {
		if (!this.ctx) return 0;
		let attached = 0;
		document.querySelectorAll('video, audio').forEach((el) => {
			if (this.attachNode(el as HTMLMediaElement)) attached++;
		});
		return attached;
	}

	// eff: creates and connects the audio graph for a specific media element
	// note: connection chain: Source -> Gain -> Bass -> EQ -> Comp -> Panner -> Delay -> Analyser -> Dest
	attachNode(el: HTMLMediaElement): boolean {
		const m = el as AudioMediaElement;
		if (m._vm || m.dataset.vmAttached === 'true' || m.dataset.vmProbed === 'true' || !this.ctx) return false;

		try {
			if (!el.crossOrigin && el.src && !el.src.startsWith('data:') && !el.src.startsWith('blob:')) {
				el.crossOrigin = 'anonymous';
			}
			const source = this.ctx.createMediaElementSource(el);
			const gain = this.ctx.createGain();
			const bass = this.ctx.createBiquadFilter();
			bass.type = 'lowshelf';
			bass.frequency.value = AudioParams.BASS_FREQUENCY;

			const comp = this.ctx.createDynamicsCompressor();
			const analyser = this.ctx.createAnalyser();
			analyser.fftSize = AudioParams.FFT_SIZE;

			const eqNodes = AudioParams.EQ_FREQUENCIES.map((freq) => {
				const node = this.ctx!.createBiquadFilter();
				node.type = 'peaking';
				node.frequency.value = freq;
				node.Q.value = AudioParams.EQ_Q;
				return node;
			});

			const panner = this.ctx.createStereoPanner();
			const delayNode = this.ctx.createDelay(1);

			let head: AudioNode = source;
			head.connect(gain); head = gain;
			head.connect(bass); head = bass;
			eqNodes.forEach((n) => { head.connect(n); head = n; });
			head.connect(comp); head = comp;
			head.connect(panner); head = panner;
			head.connect(delayNode); head = delayNode;
			head.connect(analyser);
			analyser.connect(this.ctx.destination);

			m._vm = { source, gain, bass, comp, eqNodes, analyser, panner, delayNode };
			m.dataset.vmAttached = 'true';

			el.addEventListener('play', () => {
				if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => { });
			});

			if (!this.skipCorsCheck) {
				scheduleCorsCheck(analyser, el, (restricted) => {
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

	// eff: applies AudioConfig values to all attached audio nodes with smooth transitions
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

			if (config.compressor) {
				comp.threshold.setTargetAtTime(CompressorOn.threshold, t, r);
				comp.ratio.setTargetAtTime(CompressorOn.ratio, t, r);
			} else {
				comp.threshold.setTargetAtTime(CompressorNativeOff.threshold, t, r);
				comp.ratio.setTargetAtTime(CompressorNativeOff.ratio, t, r);
			}

			eqNodes.forEach((n, i) => n.gain.setTargetAtTime(config.eqValues[i] ?? 0, t, r));
			panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, config.pan ?? 0)), t, r);
			const delayMs = Math.max(0, config.delay ?? 0);
			delayNode.delayTime.setTargetAtTime(delayMs / 1000, t, r);
		});
	}

	// eff: retrieves frequency data from the first available attached analyser
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
