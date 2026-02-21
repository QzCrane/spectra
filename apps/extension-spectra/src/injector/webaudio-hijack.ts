// goal: hijack Web Audio API to inject volume booster/limiter
// theory: intercept AudioContext creation to insert GainNode + Compressor

const activeBoosters = new Set<GainNode>();
let globalVolume = 1.0;

export function initWebAudioHijack(): void {
	// @ts-ignore
	const OriginalAudioContext = window.AudioContext || window.webkitAudioContext;
	if (!OriginalAudioContext) return;

	const Construct = function (options?: AudioContextOptions) {
		const ctx = new OriginalAudioContext(options);

		const booster = ctx.createGain();
		booster.gain.value = globalVolume;

		const limiter = createLimiter(ctx);
		const realDestination = ctx.destination;

		booster.connect(limiter);
		limiter.connect(realDestination);

		Object.defineProperty(ctx, 'destination', {
			get: () => booster,
			configurable: true
		});

		activeBoosters.add(booster);

		const originalClose = ctx.close;
		ctx.close = async function () {
			activeBoosters.delete(booster);
			return originalClose.apply(this, arguments as any);
		};

		return ctx;
	};

	Construct.prototype = OriginalAudioContext.prototype;
	// @ts-ignore
	window.AudioContext = window.webkitAudioContext = Construct;
}

function createLimiter(ctx: AudioContext): DynamicsCompressorNode {
	const limiter = ctx.createDynamicsCompressor();
	limiter.threshold.value = -3;
	limiter.knee.value = 0;
	limiter.ratio.value = 20;
	limiter.attack.value = 0.005;
	limiter.release.value = 0.1;
	return limiter;
}

// eff: update all active booster nodes with new volume
export function updateVolume(volume: number): void {
	globalVolume = volume;
	activeBoosters.forEach(node => {
		try {
			node.gain.setTargetAtTime(globalVolume, node.context.currentTime, 0.05);
		} catch { }
	});
}
