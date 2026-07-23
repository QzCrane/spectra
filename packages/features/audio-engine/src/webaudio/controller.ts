// goal: one page-lifetime media source owner backed by the shared sparse graph

import type { AudioConfig } from '@nexus/contracts';
import {
	AudioGraphRouter,
	audioConfigToGraphConfig,
	type AudioGraphSnapshot,
} from '../AudioGraphRouter.js';

export type { AudioConfig };

export interface MediaSourceEligibilityEvidence {
	kind: 'preload-cors';
	resourceUrl: string;
}

export type MediaSourceEligibilityReason =
	| 'same-origin'
	| 'origin-owned-data'
	| 'origin-owned-blob'
	| 'explicit-preload-cors'
	| 'resource-unselected'
	| 'cross-origin-unproven'
	| 'invalid-resource-url';

export interface MediaSourceEligibility {
	eligible: boolean;
	reason: MediaSourceEligibilityReason;
	resourceUrl: string;
}

export interface MediaSourceCoverageAssessment {
	eligibility: 'proven' | 'unknown' | 'unsafe';
	fullCoverage: boolean;
	total: number;
	eligible: number;
	failures: MediaSourceEligibility[];
}

interface MediaAudioRuntime {
	version: 2;
	context: AudioContext;
	router: AudioGraphRouter;
	sources: WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>;
	elements: Set<HTMLMediaElement>;
}

interface RuntimeScope extends Window {
	__SPECTRA_MEDIA_AUDIO_RUNTIME_V2__?: MediaAudioRuntime;
}

function pageOrigin(): string | null {
	try {
		const origin = globalThis.location?.origin;
		return origin && origin !== 'null' ? origin : null;
	} catch {
		return null;
	}
}

function resolveResourceUrl(element: HTMLMediaElement): string {
	return element.currentSrc || element.src || '';
}

export function assessMediaSourceEligibility(
	element: HTMLMediaElement,
	evidence?: MediaSourceEligibilityEvidence,
): MediaSourceEligibility {
	const resourceUrl = resolveResourceUrl(element);
	if (!resourceUrl) return { eligible: false, reason: 'resource-unselected', resourceUrl };
	if (evidence?.resourceUrl === resourceUrl) {
		return {
			eligible: true,
			reason: 'explicit-preload-cors',
			resourceUrl,
		};
	}
	if (resourceUrl.startsWith('data:')) {
		return { eligible: true, reason: 'origin-owned-data', resourceUrl };
	}
	try {
		const base = globalThis.document?.baseURI || globalThis.location?.href;
		const url = new URL(resourceUrl, base);
		const origin = pageOrigin();
		if (url.protocol === 'blob:' && origin && url.origin === origin) {
			return { eligible: true, reason: 'origin-owned-blob', resourceUrl: url.href };
		}
		if (origin && url.origin === origin) {
			return { eligible: true, reason: 'same-origin', resourceUrl: url.href };
		}
		return { eligible: false, reason: 'cross-origin-unproven', resourceUrl: url.href };
	} catch {
		return { eligible: false, reason: 'invalid-resource-url', resourceUrl };
	}
}

// post: full Media WebAudio coverage is prospective only when every current
// registry source is selected and proven safe before any irreversible binding.
export function assessMediaSourceCoverage(
	elements: readonly HTMLMediaElement[],
	evidenceFor: (element: HTMLMediaElement) => MediaSourceEligibilityEvidence | undefined = () => undefined,
): MediaSourceCoverageAssessment {
	const assessments = elements.map((element) => assessMediaSourceEligibility(element, evidenceFor(element)));
	const failures = assessments.filter((assessment) => !assessment.eligible);
	const hasUnsafe = failures.some((failure) => failure.reason !== 'resource-unselected');
	return {
		eligibility: elements.length === 0 || (!hasUnsafe && failures.length > 0)
			? 'unknown'
			: hasUnsafe
				? 'unsafe'
				: 'proven',
		fullCoverage: elements.length > 0 && failures.length === 0,
		total: elements.length,
		eligible: assessments.length - failures.length,
		failures,
	};
}

export class WebAudioController {
	private runtime: MediaAudioRuntime | null = null;
	private readonly ownedSources = new Set<HTMLMediaElement>();
	private visualizerRequested = false;
	private visualizerDisposer: (() => void) | null = null;
	private readonly bindingFailures = new WeakMap<HTMLMediaElement, string>();

	private synchronizeVisualizerTap(): boolean {
		const canSubscribe = this.visualizerRequested
			&& this.runtime !== null
			&& this.runtime.context.state !== 'closed'
			&& this.runtime.elements.size > 0;
		if (canSubscribe && !this.visualizerDisposer) {
			this.visualizerDisposer = this.runtime?.router.subscribeVisualizer() ?? null;
		}
		if (!canSubscribe && this.visualizerDisposer) {
			this.visualizerDisposer();
			this.visualizerDisposer = null;
		}
		return this.visualizerDisposer !== null;
	}

	async initialize(attemptResume = false): Promise<boolean> {
		const scope = window as RuntimeScope;
		const existing = scope.__SPECTRA_MEDIA_AUDIO_RUNTIME_V2__;
		if (existing?.version === 2 && existing.context.state !== 'closed') {
			this.runtime = existing;
			if (attemptResume && existing.context.state === 'suspended') {
				try { await existing.context.resume(); } catch { return false; }
			}
			this.synchronizeVisualizerTap();
			return existing.context.state === 'running';
		}
		try {
			const AudioContextConstructor = window.AudioContext
				|| (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
			const context = new AudioContextConstructor();
			const runtime: MediaAudioRuntime = {
				version: 2,
				context,
				router: new AudioGraphRouter(context),
				sources: new WeakMap(),
				elements: new Set(),
			};
			scope.__SPECTRA_MEDIA_AUDIO_RUNTIME_V2__ = runtime;
			this.runtime = runtime;
			if (attemptResume && context.state === 'suspended') await context.resume();
			this.synchronizeVisualizerTap();
			return context.state === 'running';
		} catch {
			return false;
		}
	}

	async cleanup(): Promise<void> {
		if (!this.runtime || this.runtime.context.state === 'closed') return;
		// Mode transitions own only the processing route. The explicit visualizer
		// subscriber lease owns the analyser request, so a temporary bypass or a
		// failed Capture handoff must not silently cancel an existing consumer.
		await this.runtime.router.bypass();
	}

	isReady(): boolean {
		return this.runtime !== null && this.runtime.context.state !== 'closed';
	}

	ensureAttached(
		element: HTMLMediaElement,
		evidence?: MediaSourceEligibilityEvidence,
	): boolean {
		if (!this.runtime || this.runtime.context.state === 'closed') return false;
		const eligibility = assessMediaSourceEligibility(element, evidence);
		if (!eligibility.eligible) return false;
		// A MediaElementSourceNode is page-lifetime and cannot be recreated. DOM
		// removal disconnects only its graph route; reinsertion reconnects the
		// existing binding and still counts as successful coverage.
		const existing = this.runtime.sources.get(element);
		if (existing) {
			if (!this.runtime.elements.has(element)) {
				this.runtime.router.connectSource(existing);
			}
			this.runtime.elements.add(element);
			this.ownedSources.add(element);
			this.bindingFailures.delete(element);
			this.synchronizeVisualizerTap();
			return true;
		}
		try {
			const source = this.runtime.context.createMediaElementSource(element);
			this.runtime.sources.set(element, source);
			this.runtime.elements.add(element);
			this.ownedSources.add(element);
			this.runtime.router.connectSource(source);
			this.bindingFailures.delete(element);
			this.synchronizeVisualizerTap();
			return true;
		} catch {
			this.bindingFailures.set(element, eligibility.resourceUrl);
			return false;
		}
	}

	attachNode(
		element: HTMLMediaElement,
		evidence?: MediaSourceEligibilityEvidence,
	): boolean {
		return this.ensureAttached(element, evidence);
	}

	hasKnownBindingFailure(element: HTMLMediaElement): boolean {
		return this.bindingFailures.get(element) === resolveResourceUrl(element);
	}

	hasCompleteCoverage(
		elements: readonly HTMLMediaElement[],
		evidenceFor: (element: HTMLMediaElement) => MediaSourceEligibilityEvidence | undefined = () => undefined,
	): boolean {
		const runtime = this.runtime;
		if (!runtime || runtime.context.state === 'closed') return false;
		if (!assessMediaSourceCoverage(elements, evidenceFor).fullCoverage) return false;
		return elements.length > 0 && elements.every((element) =>
			!this.hasKnownBindingFailure(element)
			&& runtime.sources.has(element)
			&& runtime.elements.has(element));
	}

	// The element-to-source binding is page-lifetime, but its shared graph route
	// is connected only while the registry owns the element.
	detachNode(element: HTMLMediaElement): void {
		if (!this.ownedSources.delete(element)) return;
		if (!this.runtime?.elements.delete(element)) return;
		const source = this.runtime.sources.get(element);
		if (source) this.runtime.router.disconnectSource(source);
		this.synchronizeVisualizerTap();
	}

	async applyConfig(config: AudioConfig): Promise<AudioGraphSnapshot> {
		if (!this.runtime || this.runtime.elements.size === 0) {
			throw new Error('No proven media source is attached');
		}
		return this.runtime.router.apply(audioConfigToGraphConfig(config), {
			requireRunning: true,
		});
	}

	getActualSnapshot(): AudioGraphSnapshot | null {
		return this.runtime?.router.getSnapshot() ?? null;
	}

	getVisualizerData(): Uint8Array | null {
		if (!this.synchronizeVisualizerTap() || !this.runtime) return null;
		return this.runtime.router.getVisualizerData();
	}

	setVisualizerSubscribed(subscribed: boolean): boolean {
		this.visualizerRequested = subscribed;
		return this.synchronizeVisualizerTap();
	}
}
