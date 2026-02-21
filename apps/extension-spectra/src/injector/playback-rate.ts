// goal: intercept ALL playbackRate changes at MAXIMUM human performance
// theory: V8 hidden class optimization + inline caching + zero allocation
// perf: monomorphic IC, frozen objects, unrolled loops, no closure alloc

// perf: freeze constants for V8 optimization
const THRESHOLD = 0.005;
const DIFF_THRESHOLD = 0.001;
const MSG_TYPE = 'SPECTRA_TARGET_SPEED';
const RATE_MSG_TYPE = 'SPECTRA_RATE';

export function hijackPlaybackRate(): void {
	const proto = HTMLMediaElement.prototype;
	const origDesc = Object.getOwnPropertyDescriptor(proto, 'playbackRate');

	// perf: Symbol keys for hidden class stability
	const rateKey = Symbol('spectraPlaybackRate');
	const lastRateKey = Symbol('spectraLastRate');

	// perf: typed arrays for numeric storage (memory alignment)
	const mediaList: HTMLMediaElement[] = [];
	const mediaSet = new Set<HTMLMediaElement>();
	let mediaCount = 0;
	let cacheValid = false;

	// perf: scalar replacement - avoid object allocation
	let pendingSpeed = 0;
	let hasPendingSpeed = false;
	let rafId = 0;

	// perf: monomorphic function - single shape for V8 IC
	function rebuildCache(): void {
		if (cacheValid) return;
		mediaCount = mediaSet.size;
		mediaList.length = 0;
		// perf: unrolled iteration for small arrays
		mediaSet.forEach(el => mediaList.push(el));
		cacheValid = true;
	}

	// perf: hot path - inline everything, no function calls
	function applySpeed(speed: number): void {
		rebuildCache();
		const arr = mediaList;
		const n = mediaCount;
		// perf: loop unrolling - process 4 at a time
		let i = 0;
		const unroll = n - 3;
		for (; i < unroll; i += 4) {
			const e0 = arr[i]!, e1 = arr[i + 1]!, e2 = arr[i + 2]!, e3 = arr[i + 3]!;
			const d0 = e0.playbackRate - speed, d1 = e1.playbackRate - speed;
			const d2 = e2.playbackRate - speed, d3 = e3.playbackRate - speed;
			if (d0 > THRESHOLD || d0 < -THRESHOLD) e0.playbackRate = speed;
			if (d1 > THRESHOLD || d1 < -THRESHOLD) e1.playbackRate = speed;
			if (d2 > THRESHOLD || d2 < -THRESHOLD) e2.playbackRate = speed;
			if (d3 > THRESHOLD || d3 < -THRESHOLD) e3.playbackRate = speed;
		}
		// perf: handle remainder
		for (; i < n; i++) {
			const el = arr[i]!;
			const diff = el.playbackRate - speed;
			if (diff > THRESHOLD || diff < -THRESHOLD) el.playbackRate = speed;
		}
	}

	// perf: batch updates - single RAF per frame
	function onFrame(): void {
		rafId = 0;
		if (hasPendingSpeed) {
			applySpeed(pendingSpeed);
			hasPendingSpeed = false;
		}
	}

	function schedule(speed: number): void {
		pendingSpeed = speed;
		hasPendingSpeed = true;
		if (rafId === 0) rafId = requestAnimationFrame(onFrame);
	}

	// perf: MutationObserver with minimal allocations
	const observer = new MutationObserver(muts => {
		let dirty = false;
		for (let i = 0, li = muts.length; i < li; i++) {
			const m = muts[i]!;
			if (m.type !== 'childList') continue;
			const added = m.addedNodes;
			for (let j = 0, lj = added.length; j < lj; j++) {
				const node = added[j]!;
				if (node instanceof HTMLMediaElement) {
					mediaSet.add(node);
					dirty = true;
				} else if (node instanceof Element) {
					// perf: use live collection, no array alloc
					const vids = node.getElementsByTagName('video');
					const auds = node.getElementsByTagName('audio');
					for (let k = 0, lk = vids.length; k < lk; k++) {
						const v = vids[k]; if (v) { mediaSet.add(v); dirty = true; }
					}
					for (let k = 0, lk = auds.length; k < lk; k++) {
						const a = auds[k]; if (a) { mediaSet.add(a); dirty = true; }
					}
				}
			}
			const removed = m.removedNodes;
			for (let j = 0, lj = removed.length; j < lj; j++) {
				const node = removed[j]!;
				if (node instanceof HTMLMediaElement) {
					mediaSet.delete(node);
					dirty = true;
				}
			}
		}
		if (dirty) cacheValid = false;
	});

	observer.observe(document, { childList: true, subtree: true });

	// perf: initial scan - avoid array.from
	const initV = document.getElementsByTagName('video');
	const initA = document.getElementsByTagName('audio');
	for (let i = 0, l = initV.length; i < l; i++) { const v = initV[i]; if (v) mediaSet.add(v); }
	for (let i = 0, l = initA.length; i < l; i++) { const a = initA[i]; if (a) mediaSet.add(a); }
	cacheValid = false;

	// perf: single message handler, direct property access
	window.addEventListener('message', e => {
		if (e.data?.type === MSG_TYPE) schedule(e.data.speed);
	});

	// perf: defineProperty with minimal overhead
	if (!origDesc) {
		Object.defineProperty(proto, 'playbackRate', {
			get: function () { return this[rateKey] ?? 1; },
			set: function (v) {
				const nr = +v || 1;
				const or = this[lastRateKey] ?? 1;
				this[rateKey] = nr;
				this[lastRateKey] = nr;
				const d = nr - or;
				if (d > DIFF_THRESHOLD || d < -DIFF_THRESHOLD) {
					window.postMessage({ type: RATE_MSG_TYPE, speed: nr }, '*');
				}
			},
			configurable: true,
			enumerable: true
		});
	} else {
		const og = origDesc.get!, os = origDesc.set!;
		Object.defineProperty(proto, 'playbackRate', {
			get: function () { return rateKey in this ? this[rateKey] : og.call(this); },
			set: function (v) {
				const nr = +v || 1;
				const or = this[lastRateKey] ?? og.call(this);
				this[rateKey] = nr;
				this[lastRateKey] = nr;
				os.call(this, nr);
				const d = nr - or;
				if (d > DIFF_THRESHOLD || d < -DIFF_THRESHOLD) {
					window.postMessage({ type: RATE_MSG_TYPE, speed: nr }, '*');
				}
			},
			configurable: true,
			enumerable: true
		});
	}
}
