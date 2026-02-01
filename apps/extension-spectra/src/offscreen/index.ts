// goal: manages high-fidelity audio processing in the offscreen document via tab capture streams
// eff: constructs a complete WebAudio graph

import { AudioParams, CompressorOn, CompressorNativeOff } from '@nexus/audio-engine';
import type { AudioConfig } from '@nexus/kernel';
import { OffscreenActions } from '@nexus/contracts';

interface AudioProcessor {
	ctx: AudioContext; stream: MediaStream; gain: GainNode; bass: BiquadFilterNode;
	comp: DynamicsCompressorNode; eqNodes: BiquadFilterNode[]; panner: StereoPannerNode;
	delayNode: DelayNode; analyser: AnalyserNode;
	vizBuffer: Uint8Array; // eff: pre-allocated buffer
}

const processors = new Map<number, AudioProcessor>();

chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
	if (msg.target !== 'offscreen') return;
	switch (msg.action) {
		case OffscreenActions.OFFSCREEN_START: startCapture(msg.tabId, msg.streamId, msg.config); break;
		case OffscreenActions.OFFSCREEN_STOP: stopCapture(msg.tabId); break;
		case OffscreenActions.OFFSCREEN_UPDATE_CONFIG: updateAudio(msg.tabId, msg.config); break;
		case OffscreenActions.OFFSCREEN_GET_VIZ: {
			const p = processors.get(msg.tabId);
			if (p?.analyser) {
				p.analyser.getByteFrequencyData(p.vizBuffer as any);
				// eff: send copy required for IPC serialization anyway, but avoid local alloc if possible.
				// IPC handles ArrayBuffer views efficiently.
				sendResponse({ buffer: Array.from(p.vizBuffer) });
			} else {
				sendResponse({ buffer: null });
			}
			return true;
		}
	}
});

async function startCapture(tabId: number, streamId: string, config: AudioConfig): Promise<void> {
	if (processors.has(tabId)) return;

	try {
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } as any,
			video: false
		});

		const ctx = new AudioContext();
		const source = ctx.createMediaStreamSource(stream);
		const gain = ctx.createGain();
		const bass = ctx.createBiquadFilter();
		bass.type = 'lowshelf'; bass.frequency.value = AudioParams.BASS_FREQUENCY;

		const comp = ctx.createDynamicsCompressor();
		const analyser = ctx.createAnalyser();
		analyser.fftSize = AudioParams.FFT_SIZE;
		const vizBuffer = new Uint8Array(analyser.frequencyBinCount);

		const eqNodes: BiquadFilterNode[] = [];
		for (const f of AudioParams.EQ_FREQUENCIES) {
			const n = ctx.createBiquadFilter();
			n.type = 'peaking'; n.frequency.value = f; n.Q.value = AudioParams.EQ_Q;
			eqNodes.push(n);
		}

		const panner = ctx.createStereoPanner();
		const delayNode = ctx.createDelay(1);

		let head: AudioNode = source;
		head.connect(gain); head = gain;
		head.connect(bass); head = bass;
		for (const n of eqNodes) { head.connect(n); head = n; }
		head.connect(comp); head = comp;
		head.connect(panner); head = panner;
		head.connect(delayNode); head = delayNode;
		head.connect(analyser);
		analyser.connect(ctx.destination);

		if (ctx.state === 'suspended') await ctx.resume();

		processors.set(tabId, { ctx, stream, gain, bass, comp, eqNodes, panner, delayNode, analyser, vizBuffer });
		updateAudio(tabId, config);
	} catch (e) {
		console.error('[SPECTRA] Offscreen capture failed:', e);
	}
}

function stopCapture(tabId: number): void {
	const p = processors.get(tabId);
	if (p) {
		p.stream.getTracks().forEach(t => t.stop());
		p.ctx.close();
		processors.delete(tabId);
	}
}

function updateAudio(tabId: number, config: AudioConfig): void {
	const p = processors.get(tabId);
	if (!p) return;

	if (p.ctx.state === 'suspended') p.ctx.resume();

	const val = config.muted ? 0 : config.volume;
	const gainVal = val / 100;
	const t = p.ctx.currentTime;
	const r = AudioParams.SMOOTH_TIME;

	p.gain.gain.setTargetAtTime(gainVal, t, r);
	p.gain.channelCount = config.mono ? 1 : 2;
	p.bass.gain.setTargetAtTime(config.bass ? AudioParams.BASS_GAIN : 0, t, r);

	for (let i = 0; i < p.eqNodes.length; i++) {
		p.eqNodes[i]!.gain.setTargetAtTime(config.eqValues?.[i] || 0, t, r);
	}

	if (config.compressor) {
		p.comp.threshold.setTargetAtTime(CompressorOn.threshold, t, r);
		p.comp.knee.setTargetAtTime(CompressorOn.knee, t, r);
		p.comp.ratio.setTargetAtTime(CompressorOn.ratio, t, r);
		p.comp.attack.setTargetAtTime(CompressorOn.attack, t, r);
		p.comp.release.setTargetAtTime(CompressorOn.release, t, r);
	} else {
		p.comp.threshold.setTargetAtTime(CompressorNativeOff.threshold, t, r);
		p.comp.ratio.setTargetAtTime(CompressorNativeOff.ratio, t, r);
	}

	p.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, config.pan ?? 0)), t, r);
	const delayMs = Math.max(0, config.delay ?? 0);
	p.delayNode.delayTime.setTargetAtTime(delayMs / 1000, t, r);
}
