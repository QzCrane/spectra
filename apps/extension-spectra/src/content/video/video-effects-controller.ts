// goal: reversible extension-owned video presentation effects that preserve site-authored inline styles

import type { ControlField, ControlValues, VideoFilterState } from '@nexus/contracts';

const OWNER_ATTRIBUTE = 'data-spectra-video-effects-owner';

function styleText(ownerToken: string): string {
	return `
video[${OWNER_ATTRIBUTE}="${ownerToken}"][data-spectra-rotate]{rotate:var(--spectra-rotate)!important}
video[${OWNER_ATTRIBUTE}="${ownerToken}"][data-spectra-scale]{scale:var(--spectra-scale-x) var(--spectra-scale-y)!important}
video[${OWNER_ATTRIBUTE}="${ownerToken}"][data-spectra-fill]{object-fit:cover!important}
video[${OWNER_ATTRIBUTE}="${ownerToken}"][data-spectra-filter]{filter:var(--spectra-filter)!important}
`;
}

const OWNER_ATTRIBUTES = [
	OWNER_ATTRIBUTE,
	'data-spectra-rotate',
	'data-spectra-scale',
	'data-spectra-fill',
	'data-spectra-filter',
] as const;
const OWNER_PROPERTIES = [
	'--spectra-rotate',
	'--spectra-scale-x',
	'--spectra-scale-y',
	'--spectra-filter',
] as const;

interface VideoOwnerBaseline {
	attributes: Map<string, string | null>;
	properties: Map<string, { value: string; priority: string }>;
}

export interface VideoEffectState {
	rotation: 0 | 90 | 180 | 270;
	mirrored: boolean;
	fill: boolean;
	filterEnabled: boolean;
	filter: VideoFilterState;
	dimEnabled: boolean;
	dimOpacity: number;
}

const DEFAULT_FILTER: VideoFilterState = {
	brightness: 100,
	contrast: 100,
	saturate: 100,
	grayscale: false,
	invert: false,
};

const DEFAULT_STATE: VideoEffectState = {
	rotation: 0,
	mirrored: false,
	fill: false,
	filterEnabled: false,
	filter: DEFAULT_FILTER,
	dimEnabled: false,
	dimOpacity: 0.7,
};

export class VideoEffectsController {
	private readonly ownerToken = crypto.randomUUID();
	private readonly states = new WeakMap<HTMLVideoElement, VideoEffectState>();
	private readonly filterBaselines = new WeakMap<HTMLVideoElement, string>();
	private readonly ownerBaselines = new WeakMap<HTMLVideoElement, VideoOwnerBaseline>();
	private readonly owned = new Set<HTMLVideoElement>();
	private readonly cssOwned = new Set<HTMLVideoElement>();
	private styleElement: HTMLStyleElement | null = null;
	private dimHost: HTMLDivElement | null = null;
	private dimRegions: HTMLDivElement[] = [];
	private dimTarget: HTMLVideoElement | null = null;
	private dimOpacity = 0.7;
	private resizeObserver: ResizeObserver | null = null;
	private rotationObserver: ResizeObserver | null = null;
	private frameId = 0;

	private dimBoxes(video: HTMLVideoElement): Array<readonly [number, number, number, number]> {
		const rect = video.getBoundingClientRect();
		const viewport = window.visualViewport;
		const width = viewport?.width ?? document.documentElement.clientWidth;
		const height = viewport?.height ?? document.documentElement.clientHeight;
		const offsetLeft = viewport?.offsetLeft ?? 0;
		const offsetTop = viewport?.offsetTop ?? 0;
		const top = Math.max(0, Math.min(height, rect.top - offsetTop));
		const bottom = Math.max(top, Math.min(height, rect.bottom - offsetTop));
		const left = Math.max(0, Math.min(width, rect.left - offsetLeft));
		const right = Math.max(left, Math.min(width, rect.right - offsetLeft));
		return [
			[0, 0, width, top],
			[0, top, left, bottom - top],
			[right, top, width - right, bottom - top],
			[0, bottom, width, height - bottom],
		];
	}

	private state(video: HTMLVideoElement): VideoEffectState {
		let state = this.states.get(video);
		if (!state) {
			state = { ...DEFAULT_STATE, filter: { ...DEFAULT_FILTER } };
			this.states.set(video, state);
		}
		return state;
	}

	snapshot(video: HTMLVideoElement): VideoEffectState {
		// Status/read paths are projections only. Do not allocate target ownership
		// state merely because Popup or remote asks for the current native view.
		const state = this.states.get(video) ?? DEFAULT_STATE;
		return { ...state, filter: { ...state.filter } };
	}

	private ensureStyle(): void {
		if (this.styleElement?.isConnected) return;
		const style = document.createElement('style');
		style.dataset.spectraOwner = 'video-effects';
		style.textContent = styleText(this.ownerToken);
		(document.head ?? document.documentElement).appendChild(style);
		this.styleElement = style;
	}

	async apply<K extends Extract<ControlField,
		'rotation' | 'mirrored' | 'fill' | 'filterEnabled' | 'filter' | 'dimEnabled' | 'dimOpacity'>>(
		video: HTMLVideoElement,
		field: K,
		value: ControlValues[K],
	): Promise<ControlValues[K]> {
		const state = this.state(video);
		if (field === 'dimEnabled' || field === 'dimOpacity') {
			if (field === 'dimEnabled') state.dimEnabled = value as boolean;
			else state.dimOpacity = value as number;
			if (state.dimEnabled) this.owned.add(video);
			this.applyDim(video, state.dimEnabled, state.dimOpacity);
			await this.settleDimReadback(video, state);
			const actual = state[field] as ControlValues[K];
			if (!this.hasActiveEffect(state)) {
				if (this.hasConfiguredState(state)) this.releaseDomOwnership(video);
				else this.release(video);
			}
			return actual;
		}

		const predicted = { ...state, filter: { ...state.filter } };
		(predicted as unknown as Record<string, unknown>)[field] = value;
		if (!this.ownerBaselines.has(video) && !this.hasActiveCssEffect(predicted)) {
			// A neutral value on a never-owned video is a state-only no-op. Touching
			// the DOM here would both allocate the shared stylesheet unnecessarily and
			// risk deleting a page-authored attribute/custom property with the same
			// name. Existing owners continue through the normal release path below so
			// their captured baseline is restored.
			(state as unknown as Record<string, unknown>)[field] = field === 'filter'
				? { ...(value as VideoFilterState) }
				: value;
			return state[field] as ControlValues[K];
		}
		if (this.hasActiveCssEffect(predicted) || this.ownerBaselines.has(video)) {
			this.captureOwnerBaseline(video);
		}
		if (field === 'rotation') {
			state.rotation = value as VideoEffectState['rotation'];
			video.toggleAttribute('data-spectra-rotate', state.rotation !== 0);
			if (state.rotation === 0) video.style.removeProperty('--spectra-rotate');
			else video.style.setProperty('--spectra-rotate', `${state.rotation}deg`);
			this.updateScale(video, state);
			this.updateRotationObservation(video, state);
		} else if (field === 'mirrored') {
			state.mirrored = value as boolean;
			this.updateScale(video, state);
		} else if (field === 'fill') {
			state.fill = value as boolean;
			video.toggleAttribute('data-spectra-fill', state.fill);
		} else if (field === 'filterEnabled') {
			state.filterEnabled = value as boolean;
			if (state.filterEnabled) {
				this.captureFilterBaseline(video);
				video.style.setProperty('--spectra-filter', this.composedFilterCss(video, state.filter));
				video.setAttribute('data-spectra-filter', '');
			} else {
				video.removeAttribute('data-spectra-filter');
				video.style.removeProperty('--spectra-filter');
				this.filterBaselines.delete(video);
			}
		} else {
			state.filter = { ...(value as VideoFilterState) };
			if (state.filterEnabled) {
				this.captureFilterBaseline(video);
				video.style.setProperty('--spectra-filter', this.composedFilterCss(video, state.filter));
				video.setAttribute('data-spectra-filter', '');
			}
		}
		this.assertOwnerReadback(video, state, field);
		this.assertComputedReadback(video, state, field);
		const actual = state[field] as ControlValues[K];
		if (this.hasActiveEffect(state)) this.owned.add(video);
		else if (this.hasConfiguredState(state)) this.releaseDomOwnership(video);
		else this.release(video);
		return actual;
	}

	private hasActiveCssEffect(state: VideoEffectState): boolean {
		return state.rotation !== 0
			|| state.mirrored
			|| state.fill
			|| state.filterEnabled;
	}

	private hasActiveEffect(state: VideoEffectState): boolean {
		return this.hasActiveCssEffect(state)
			|| state.dimEnabled;
	}

	private hasConfiguredState(state: VideoEffectState): boolean {
		return this.hasActiveEffect(state)
			|| state.dimOpacity !== DEFAULT_STATE.dimOpacity
			|| JSON.stringify(state.filter) !== JSON.stringify(DEFAULT_FILTER);
	}

	private captureOwnerBaseline(video: HTMLVideoElement): void {
		if (this.ownerBaselines.has(video)) return;
		const attributes = new Map<string, string | null>();
		for (const name of OWNER_ATTRIBUTES) attributes.set(name, video.getAttribute(name));
		const properties = new Map<string, { value: string; priority: string }>();
		for (const name of OWNER_PROPERTIES) {
			properties.set(name, {
				value: video.style.getPropertyValue(name),
				priority: video.style.getPropertyPriority(name),
			});
		}
		this.ownerBaselines.set(video, { attributes, properties });
		this.cssOwned.add(video);
		video.setAttribute(OWNER_ATTRIBUTE, this.ownerToken);
		this.ensureStyle();
	}

	private settleDimReadback(
		video: HTMLVideoElement,
		state: VideoEffectState,
	): Promise<void> {
		if (!state.dimEnabled) {
			if (this.dimTarget === video) {
				return Promise.reject(new Error('Dim overlay release readback failed'));
			}
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			requestAnimationFrame(() => {
				const boxes = this.dimBoxes(video);
				if (!this.dimHost?.isConnected
					|| this.dimTarget !== video
					|| this.dimRegions.length !== 4
					|| this.dimRegions.some((region, index) => {
						const expected = boxes[index]!;
						const actual = [
							Number.parseFloat(region.style.left),
							Number.parseFloat(region.style.top),
							Number.parseFloat(region.style.width),
							Number.parseFloat(region.style.height),
						];
						return Math.abs(Number(region.style.opacity) - state.dimOpacity) > 0.001
							|| actual.some((value, coordinate) =>
								!Number.isFinite(value) || Math.abs(value - expected[coordinate]!) > 0.5);
					})) {
					reject(new Error('Dim overlay geometry/opacity readback failed'));
					return;
				}
				resolve();
			});
		});
	}

	private updateScale(video: HTMLVideoElement, state: VideoEffectState): void {
		const swapsAxes = state.rotation === 90 || state.rotation === 270;
		const width = Math.max(1, video.clientWidth);
		const height = Math.max(1, video.clientHeight);
		const fit = swapsAxes ? Math.min(width / height, height / width) : 1;
		const ownsScale = state.mirrored || fit !== 1;
		video.toggleAttribute('data-spectra-scale', ownsScale);
		if (ownsScale) {
			video.style.setProperty('--spectra-scale-x', String(state.mirrored ? -fit : fit));
			video.style.setProperty('--spectra-scale-y', String(fit));
		} else {
			video.style.removeProperty('--spectra-scale-x');
			video.style.removeProperty('--spectra-scale-y');
		}
	}

	private assertOwnerReadback(
		video: HTMLVideoElement,
		state: VideoEffectState,
		field: Extract<ControlField,
			'rotation' | 'mirrored' | 'fill' | 'filterEnabled' | 'filter'>,
	): void {
		if (field === 'rotation') {
			if (video.hasAttribute('data-spectra-rotate') !== (state.rotation !== 0)
				|| (state.rotation === 0 && video.style.getPropertyValue('--spectra-rotate') !== '')) {
				throw new Error('Video rotation owner readback failed');
			}
		}
		if (field === 'rotation' || field === 'mirrored') {
			const swapsAxes = state.rotation === 90 || state.rotation === 270;
			const width = Math.max(1, video.clientWidth);
			const height = Math.max(1, video.clientHeight);
			const ownsScale = state.mirrored
				|| (swapsAxes && Math.min(width / height, height / width) !== 1);
			if (video.hasAttribute('data-spectra-scale') !== ownsScale
				|| (!ownsScale && (
					video.style.getPropertyValue('--spectra-scale-x') !== ''
					|| video.style.getPropertyValue('--spectra-scale-y') !== ''
				))) throw new Error('Video scale owner readback failed');
		}
		if (field === 'fill'
			&& video.hasAttribute('data-spectra-fill') !== state.fill) {
			throw new Error('Video fill owner readback failed');
		}
		if ((field === 'filter' || field === 'filterEnabled')
			&& (video.hasAttribute('data-spectra-filter') !== state.filterEnabled
				|| (!state.filterEnabled
					&& video.style.getPropertyValue('--spectra-filter') !== ''))) {
			throw new Error('Video filter owner readback failed');
		}
	}

	private updateRotationObservation(video: HTMLVideoElement, state: VideoEffectState): void {
		const swapsAxes = state.rotation === 90 || state.rotation === 270;
		if (!swapsAxes) {
			this.rotationObserver?.unobserve(video);
			return;
		}
		this.rotationObserver ??= new ResizeObserver((entries) => {
			for (const entry of entries) {
				if (!(entry.target instanceof HTMLVideoElement)) continue;
				const current = this.states.get(entry.target);
				if (current) this.updateScale(entry.target, current);
			}
		});
		this.rotationObserver.observe(video);
	}

	private assertComputedReadback(
		video: HTMLVideoElement,
		state: VideoEffectState,
		field: Exclude<ControlField, 'audioEnabled'>,
	): void {
		const computed = getComputedStyle(video);
		if (this.hasActiveCssEffect(state)
			&& video.getAttribute(OWNER_ATTRIBUTE) !== this.ownerToken) {
			throw new Error('Video effect owner token readback failed');
		}
		if (field === 'fill' && state.fill && computed.objectFit !== 'cover') {
			throw new Error('Video fill computed-style readback failed');
		}
		if (field === 'rotation'
			&& state.rotation !== 0
			&& this.normalizeCss(computed.rotate) !== `${state.rotation}deg`) {
			throw new Error('Video transform computed-style readback failed');
		}
		if (field === 'mirrored' && state.mirrored) {
			const expected = this.normalizeCss(
				`${video.style.getPropertyValue('--spectra-scale-x')} ${video.style.getPropertyValue('--spectra-scale-y')}`,
			);
			if (this.normalizeCss(computed.scale) !== expected) {
			throw new Error('Video mirror computed-style readback failed');
			}
		}
		if ((field === 'filter' || field === 'filterEnabled')
			&& state.filterEnabled
			&& this.normalizeCss(computed.filter) !== this.normalizeCss(
				video.style.getPropertyValue('--spectra-filter'),
			)) {
			throw new Error('Video filter computed-style readback failed');
		}
	}

	private normalizeCss(value: string): string {
		return value.trim().replace(/\s+/gu, ' ');
	}

	private filterCss(filter: VideoFilterState): string {
		return [
			`brightness(${filter.brightness}%)`,
			`contrast(${filter.contrast}%)`,
			`saturate(${filter.saturate}%)`,
			`grayscale(${filter.grayscale ? 100 : 0}%)`,
			`invert(${filter.invert ? 100 : 0}%)`,
		].join(' ');
	}

	private captureFilterBaseline(video: HTMLVideoElement): void {
		if (this.filterBaselines.has(video)) return;
		const baseline = getComputedStyle(video).filter;
		this.filterBaselines.set(video, baseline && baseline !== 'none' ? baseline : '');
	}

	private composedFilterCss(video: HTMLVideoElement, filter: VideoFilterState): string {
		const baseline = this.filterBaselines.get(video) ?? '';
		return `${baseline} ${this.filterCss(filter)}`.trim();
	}

	private applyDim(video: HTMLVideoElement, enabled: boolean, opacity: number): void {
		this.dimOpacity = opacity;
		if (!enabled) {
			if (this.dimTarget === video) this.disposeDim();
			return;
		}
		if (this.dimTarget && this.dimTarget !== video) {
			const previous = this.dimTarget;
			const previousState = this.states.get(previous);
			if (previousState) previousState.dimEnabled = false;
			this.disposeDim();
			if (previousState && !this.hasActiveEffect(previousState)) {
				if (this.hasConfiguredState(previousState)) this.releaseDomOwnership(previous);
				else this.release(previous);
			}
		}
		if (!this.dimHost) {
			const host = document.createElement('div');
			host.dataset.spectraOwner = 'dim-overlay';
			host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
			const root = host.attachShadow({ mode: 'closed' });
			this.dimRegions = Array.from({ length: 4 }, () => {
				const region = document.createElement('div');
				region.style.cssText = 'position:fixed;background:#000;pointer-events:none;';
				root.appendChild(region);
				return region;
			});
			this.overlayRoot(video).appendChild(host);
			this.dimHost = host;
			window.addEventListener('resize', this.scheduleDim, true);
			window.addEventListener('scroll', this.scheduleDim, true);
			window.visualViewport?.addEventListener('resize', this.scheduleDim);
			window.visualViewport?.addEventListener('scroll', this.scheduleDim);
			document.addEventListener('fullscreenchange', this.scheduleDim, true);
			this.resizeObserver = new ResizeObserver(this.scheduleDim);
		}
		if (this.dimTarget !== video) {
			this.resizeObserver?.disconnect();
			this.dimTarget = video;
			this.resizeObserver?.observe(video);
		}
		this.scheduleDim();
	}

	private readonly scheduleDim = (): void => {
		if (this.frameId !== 0) return;
		this.frameId = requestAnimationFrame(() => {
			this.frameId = 0;
			const video = this.dimTarget;
			if (!video || !this.dimHost) return;
			const root = this.overlayRoot(video);
			if (this.dimHost.parentElement !== root) root.appendChild(this.dimHost);
			const boxes = this.dimBoxes(video);
			for (let index = 0; index < boxes.length; index += 1) {
				const [x, y, w, h] = boxes[index]!;
				const region = this.dimRegions[index]!;
				region.style.left = `${x}px`;
				region.style.top = `${y}px`;
				region.style.width = `${w}px`;
				region.style.height = `${h}px`;
				region.style.opacity = String(this.dimOpacity);
			}
		});
	};

	private overlayRoot(video: HTMLVideoElement): HTMLElement {
		const fullscreen = document.fullscreenElement;
		return fullscreen instanceof HTMLElement && fullscreen.contains(video)
			? fullscreen
			: document.documentElement;
	}

	private disposeDim(): void {
		if (this.frameId !== 0) cancelAnimationFrame(this.frameId);
		this.frameId = 0;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		window.removeEventListener('resize', this.scheduleDim, true);
		window.removeEventListener('scroll', this.scheduleDim, true);
		window.visualViewport?.removeEventListener('resize', this.scheduleDim);
		window.visualViewport?.removeEventListener('scroll', this.scheduleDim);
		document.removeEventListener('fullscreenchange', this.scheduleDim, true);
		this.dimHost?.remove();
		this.dimHost = null;
		this.dimRegions = [];
		this.dimTarget = null;
	}

	private releaseDomOwnership(video: HTMLVideoElement): void {
		if (this.dimTarget === video) this.disposeDim();
		this.rotationObserver?.unobserve(video);
		const baseline = this.ownerBaselines.get(video);
		if (baseline) {
			for (const attribute of OWNER_ATTRIBUTES) {
				const original = baseline.attributes.get(attribute) ?? null;
				if (original === null) video.removeAttribute(attribute);
				else video.setAttribute(attribute, original);
			}
			for (const property of OWNER_PROPERTIES) {
				const original = baseline.properties.get(property);
				if (!original?.value) video.style.removeProperty(property);
				else video.style.setProperty(property, original.value, original.priority);
			}
		}
		this.ownerBaselines.delete(video);
		this.cssOwned.delete(video);
		this.filterBaselines.delete(video);
		this.owned.delete(video);
		if (this.cssOwned.size === 0) {
			this.styleElement?.remove();
			this.styleElement = null;
		}
	}

	release(video: HTMLVideoElement): VideoEffectState {
		this.releaseDomOwnership(video);
		this.states.delete(video);
		return { ...DEFAULT_STATE, filter: { ...DEFAULT_FILTER } };
	}

	dispose(): void {
		this.disposeDim();
		this.rotationObserver?.disconnect();
		this.rotationObserver = null;
		for (const video of [...this.owned]) this.release(video);
		this.owned.clear();
		this.cssOwned.clear();
		this.styleElement?.remove();
		this.styleElement = null;
	}
}
