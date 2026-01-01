import { AudioParams } from '../constants.js';
import type { AudioNodeSet } from './types.js';

/**
 * World-Class Architecture: Precise audio graph assembly and detachment.
 * Decoupled from the main controller to manage complexity.
 */
export function createAudioGraph(ctx: AudioContext, el: HTMLMediaElement): AudioNodeSet {
	const source = ctx.createMediaElementSource(el);
	const gain = ctx.createGain();
	const bass = ctx.createBiquadFilter();
	bass.type = 'lowshelf';
	bass.frequency.value = AudioParams.BASS_FREQUENCY;

	const comp = ctx.createDynamicsCompressor();
	const analyser = ctx.createAnalyser();
	analyser.fftSize = AudioParams.FFT_SIZE;

	const eqNodes = AudioParams.EQ_FREQUENCIES.map((freq) => {
		const node = ctx.createBiquadFilter();
		node.type = 'peaking';
		node.frequency.value = freq;
		node.Q.value = AudioParams.EQ_Q;
		return node;
	});

	const panner = ctx.createStereoPanner();
	const delayNode = ctx.createDelay(1);

	// Connection chain: Source -> Gain -> Bass -> EQ -> Comp -> Panner -> Delay -> Analyser -> Dest
	let head: AudioNode = source;
	head.connect(gain); head = gain;
	head.connect(bass); head = bass;
	eqNodes.forEach((n) => { head.connect(n); head = n; });
	head.connect(comp); head = comp;
	head.connect(panner); head = panner;
	head.connect(delayNode); head = delayNode;
	head.connect(analyser);
	analyser.connect(ctx.destination);

	return { source, gain, bass, comp, eqNodes, analyser, panner, delayNode };
}

export function disconnectAudioGraph(vm: AudioNodeSet): void {
	vm.source.disconnect();
	vm.gain.disconnect();
	vm.bass.disconnect();
	vm.eqNodes.forEach(n => n.disconnect());
	vm.comp.disconnect();
	vm.panner.disconnect();
	vm.delayNode.disconnect();
	vm.analyser.disconnect();
}
