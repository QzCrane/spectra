
// SPECTRA INJECTOR
// Purpose: Intercepts native media APIs to enforce CORS and enable advanced audio processing (WebAudio hijacking).
// This script runs in the "MAIN" world, sharing the same execution environment as the page's JavaScript.

(function () {
	// ==============================================================
	// 1. CORS Enforcement (createElement / createElementNS / Audio)
	// ==============================================================
	const originalCreateElement = document.createElement;
	const originalCreateElementNS = document.createElementNS;
	const OriginalAudio = window.Audio;

	// Helper: Force 'crossorigin' attribute for CORS compliance
	const enforceCrossOrigin = (element: HTMLElement, tagName: string) => {
		if (tagName && (tagName.toLowerCase() === 'video' || tagName.toLowerCase() === 'audio')) {
			element.setAttribute('crossorigin', 'anonymous');
		}
	};

	document.createElement = function (tagName: string, options?: ElementCreationOptions) {
		const element = originalCreateElement.call(this, tagName, options);
		enforceCrossOrigin(element, tagName);
		return element;
	};

	document.createElementNS = function (ns: string | null, tagName: string, options?: ElementCreationOptions) {
		const element = originalCreateElementNS.call(this, ns, tagName, options);
		enforceCrossOrigin(element as HTMLElement, tagName);
		return element;
	};

	// Helper to ensure detached elements are reachable
	// This fixes issues where 'new Audio()' elements are never attached to DOM, making them invisible to scanning.
	function ensureInDom(element: HTMLAudioElement) {
		if (!document.body) {
			document.addEventListener('DOMContentLoaded', () => ensureInDom(element));
			return;
		}
		let container = document.getElementById('spectra-hidden-container');
		if (!container) {
			container = document.createElement('div');
			container.id = 'spectra-hidden-container';
			container.style.cssText = 'position: absolute; top: -9999px; left: -9999px; width: 1px; height: 1px; overflow: hidden; opacity: 0; pointer-events: none;';
			document.body.appendChild(container);
		}
		if (!element.parentNode) {
			container.appendChild(element);
			// Optional: Clean up after playback if needed, but keeping them attached ensures re-scans work.
		}
	}

	window.Audio = function (src?: string) {
		// Log removed for production cleanliness
		const element = new OriginalAudio(src);
		element.setAttribute('crossorigin', 'anonymous');
		ensureInDom(element);
		return element;
	} as any;
	window.Audio.prototype = OriginalAudio.prototype;

	// ==============================================================
	// 2. Fullscreen Interception
	// ==============================================================
	const originalRequestFullscreen = Element.prototype.requestFullscreen;
	// @ts-ignore
	const originalWebkitRequestFullscreen = Element.prototype.webkitRequestFullscreen;

	function setAllMediaVolume(vol: number) {
		document.querySelectorAll('video, audio').forEach((el) => {
			try {
				(el as HTMLMediaElement).volume = vol;
				(el as HTMLMediaElement).muted = false;
			} catch (e) { }
		});
	}

	document.addEventListener('fullscreenchange', function () {
		if (document.fullscreenElement) {
			window.postMessage({ type: 'SPECTRA_FULLSCREEN_ENTERED' }, '*');
		}
	});

	async function interceptedRequestFullscreen(this: Element, options?: FullscreenOptions) {
		// Notify content script to pause capture/processing
		window.postMessage({ type: 'SPECTRA_PAUSE_FOR_FULLSCREEN' }, '*');

		// Reset native volume to 100%
		setAllMediaVolume(1);

		// Wait for capture to close (critical timing)
		await new Promise(r => setTimeout(r, 80));

		return originalRequestFullscreen.call(this, options);
	}

	Element.prototype.requestFullscreen = interceptedRequestFullscreen;

	if (originalWebkitRequestFullscreen) {
		// @ts-ignore
		Element.prototype.webkitRequestFullscreen = async function (options) {
			window.postMessage({ type: 'SPECTRA_PAUSE_FOR_FULLSCREEN' }, '*');
			setAllMediaVolume(1);
			await new Promise(r => setTimeout(r, 80));
			return originalWebkitRequestFullscreen.call(this, options);
		};
	}

	// ==============================================================
	// 3. Web Audio API Hijacking (Core Audio Engine Intercept)
	// ==============================================================
	// @ts-ignore
	const OriginalAudioContext = window.AudioContext || window.webkitAudioContext;
	// Track hijacked nodes to apply volume updates
	const activeBoosters = new Set<GainNode>();
	let globalVolume = 1.0;

	if (OriginalAudioContext) {
		const Construct = function (options?: AudioContextOptions) {
			const ctx = new OriginalAudioContext(options);

			// 1. Create our Master Booster (GainNode)
			const booster = ctx.createGain();
			booster.gain.value = globalVolume;

			// 2. Create Limiter (Compressor) to prevent clipping at high volumes
			const limiter = ctx.createDynamicsCompressor();
			limiter.threshold.value = -3;  // Threshold in dB
			limiter.knee.value = 0;        // Hard knee
			limiter.ratio.value = 20;      // High ratio 
			limiter.attack.value = 0.005;  // Fast attack
			limiter.release.value = 0.1;   // Fast release

			// 3. Chain: Booster -> Limiter -> Real Destination
			const realDestination = ctx.destination;
			booster.connect(limiter);
			limiter.connect(realDestination);

			// 4. Hijack the .destination property
			// Any code connecting to ctx.destination will actually connect to our booster
			Object.defineProperty(ctx, 'destination', {
				get: function () { return booster; },
				configurable: true
			});

			activeBoosters.add(booster);

			// 5. Cleanup when closed
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

	// Listen for volume updates from Content Script
	window.addEventListener('message', function (event) {
		if (event.data && event.data.type === 'SPECTRA_VOLUME_UPDATE') {
			globalVolume = event.data.volume;
			activeBoosters.forEach(node => {
				try {
					// Smooth transition to prevent clicking artifacts
					node.gain.setTargetAtTime(globalVolume, node.context.currentTime, 0.05);
				} catch (e) { }
			});
		}
	});

})();
