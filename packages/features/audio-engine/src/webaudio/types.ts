// goal: defines internal type structures for the WebAudio graph and related callbacks

export interface AudioConfig {
	enabled: boolean;
	volume: number;
	muted: boolean;
	compressor: boolean;
	mono: boolean;
	bass: boolean;
	eqValues: number[];
	pan: number;
	delay: number;
}

// goal: represents a complete set of audio nodes attached to a single media element
export interface AudioNodeSet {
	source: MediaElementAudioSourceNode;
	gain: GainNode;
	bass: BiquadFilterNode;
	comp: DynamicsCompressorNode;
	eqNodes: BiquadFilterNode[];
	analyser: AnalyserNode;
	panner: StereoPannerNode;
	delayNode: DelayNode;
}

export interface AudioMediaElement extends HTMLMediaElement {
	// _vm: internal property storing the AudioNodeSet to persist the graph connection
	_vm?: AudioNodeSet;
}

export type CorsDetectedCallback = (hostname: string) => void;
export type CorsSuccessCallback = (hostname: string) => void;
