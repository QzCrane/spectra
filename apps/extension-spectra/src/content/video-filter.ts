/**
 * SPECTRA Content Script - Visual Filters
 * Responsibility: Video brightness, contrast, saturation, grayscale using CSS filters
 */

import { createLogger } from '../shared/logger';

const log = createLogger('VideoFilter');

interface FilterState {
	brightness: number; contrast: number; saturate: number;
	grayscale: boolean; invert: boolean;
}

const DEFAULT_FILTER: FilterState = {
	brightness: 100, contrast: 100, saturate: 100,
	grayscale: false, invert: false
};

// eff: WeakMap for O(1) state
const filterState = new WeakMap<HTMLVideoElement, FilterState>();

function getState(video: HTMLVideoElement): FilterState {
	let state = filterState.get(video);
	if (!state) {
		filterState.set(video, state = { ...DEFAULT_FILTER });
	}
	return state;
}

// eff: O(N) Zero-Alloc
function getPrimaryVideo(): HTMLVideoElement | null {
	const videos = document.getElementsByTagName('video');
	let best: HTMLVideoElement | null = null;
	let maxArea = 0;

	for (let i = 0, len = videos.length; i < len; i++) {
		const v = videos[i];
		if (!v) continue;
		const rect = v.getBoundingClientRect();
		const area = rect.width * rect.height;
		if (area > maxArea) {
			maxArea = area;
			best = v;
		}
	}
	return best || videos[0] || null;
}

function applyFilter(video: HTMLVideoElement): void {
	const s = getState(video);
	let css = '';
	if (s.brightness !== 100) css += `brightness(${s.brightness}%) `;
	if (s.contrast !== 100) css += `contrast(${s.contrast}%) `;
	if (s.saturate !== 100) css += `saturate(${s.saturate}%) `;
	if (s.grayscale) css += 'grayscale(100%) ';
	if (s.invert) css += 'invert(100%)';

	video.style.filter = css || 'none';
	log.info(`Filter: ${css || 'none'}`);
}

const clamp = (v: number) => v < 0 ? 0 : v > 200 ? 200 : v;

export function setVideoFilter(p: Partial<FilterState>): boolean {
	const video = getPrimaryVideo();
	if (!video) return false;

	const s = getState(video);
	if (p.brightness !== undefined) s.brightness = clamp(p.brightness);
	if (p.contrast !== undefined) s.contrast = clamp(p.contrast);
	if (p.saturate !== undefined) s.saturate = clamp(p.saturate);
	if (p.grayscale !== undefined) s.grayscale = p.grayscale;
	if (p.invert !== undefined) s.invert = p.invert;

	applyFilter(video);
	return true;
}

export function resetVideoFilter(): boolean {
	const video = getPrimaryVideo();
	if (!video) return false;
	filterState.set(video, { ...DEFAULT_FILTER });
	applyFilter(video);
	return true;
}

// Dim Background State
const DIM_ID = 'spectra-dim-overlay';
let dimState = { active: false, opacity: 0.7 };

export function toggleDimBackground(p?: { enabled?: boolean; opacity?: number }): typeof dimState {
	const video = getPrimaryVideo();
	if (!video) return dimState;

	if (p?.enabled !== undefined) dimState.active = p.enabled;
	else dimState.active = !dimState.active;

	if (p?.opacity !== undefined) dimState.opacity = p.opacity < 0 ? 0 : p.opacity > 1 ? 1 : p.opacity;

	let overlay = document.getElementById(DIM_ID);

	if (dimState.active) {
		if (!overlay) {
			overlay = document.createElement('div');
			overlay.id = DIM_ID;
			overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;background:#000';
			document.body.appendChild(overlay);
		}
		overlay.style.opacity = String(dimState.opacity);
		video.style.position = 'relative';
		video.style.zIndex = '2147483647';
	} else {
		overlay?.remove();
		video.style.zIndex = '';
		video.style.position = '';
	}

	log.info(`Dim: ${dimState.active} (${dimState.opacity})`);
	return dimState;
}


