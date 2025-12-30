/**
 * SPECTRA Content Script - Visual Filters
 *
 * Responsibility: Video brightness, contrast, saturation, grayscale, invert using CSS filters
 */

import { createLogger } from '../shared/logger';

const log = createLogger('VideoFilter');

// ============================================
// Filter State
// ============================================

interface FilterState {
	brightness: number; // 0-200, 100=default
	contrast: number;   // 0-200, 100=default
	saturate: number;   // 0-200, 100=default
	grayscale: boolean;
	invert: boolean;
}

/** Per-video filter state */
const filterState = new WeakMap<HTMLVideoElement, FilterState>();

const DEFAULT_FILTER: FilterState = {
	brightness: 100,
	contrast: 100,
	saturate: 100,
	grayscale: false,
	invert: false
};

function getState(video: HTMLVideoElement): FilterState {
	let state = filterState.get(video);
	if (!state) {
		state = { ...DEFAULT_FILTER };
		filterState.set(video, state);
	}
	return state;
}

function getPrimaryVideo(): HTMLVideoElement | null {
	const videos = Array.from(document.querySelectorAll('video'));
	if (!videos.length) return null;

	const visible = videos.filter(v => {
		const rect = v.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	});

	if (!visible.length) return videos[0] ?? null;

	visible.sort((a, b) => {
		const aRect = a.getBoundingClientRect();
		const bRect = b.getBoundingClientRect();
		return (bRect.width * bRect.height) - (aRect.width * aRect.height);
	});

	return visible[0] ?? null;
}

// ============================================
// Filter Operations
// ============================================

/** Apply CSS filter */
function applyFilter(video: HTMLVideoElement): void {
	const state = getState(video);
	const filters: string[] = [];

	if (state.brightness !== 100) filters.push(`brightness(${state.brightness}%)`);
	if (state.contrast !== 100) filters.push(`contrast(${state.contrast}%)`);
	if (state.saturate !== 100) filters.push(`saturate(${state.saturate}%)`);
	if (state.grayscale) filters.push('grayscale(100%)');
	if (state.invert) filters.push('invert(100%)');

	video.style.filter = filters.length ? filters.join(' ') : 'none';
	log.info(`Filter applied: ${filters.join(' ') || 'none'}`);
}

/** Set Filter (partial update) */
export function setVideoFilter(params: Partial<FilterState>): boolean {
	const video = getPrimaryVideo();
	if (!video) {
		log.warn('No video element found');
		return false;
	}

	const state = getState(video);
	if (params.brightness !== undefined) state.brightness = Math.max(0, Math.min(200, params.brightness));
	if (params.contrast !== undefined) state.contrast = Math.max(0, Math.min(200, params.contrast));
	if (params.saturate !== undefined) state.saturate = Math.max(0, Math.min(200, params.saturate));
	if (params.grayscale !== undefined) state.grayscale = params.grayscale;
	if (params.invert !== undefined) state.invert = params.invert;

	applyFilter(video);
	return true;
}

/** Reset Filter */
export function resetVideoFilter(): boolean {
	const video = getPrimaryVideo();
	if (!video) {
		log.warn('No video element found');
		return false;
	}

	filterState.set(video, { ...DEFAULT_FILTER });
	applyFilter(video);
	return true;
}

// ============================================
// Dim Background
// ============================================

const DIM_OVERLAY_ID = 'spectra-dim-overlay';
let dimState = { active: false, opacity: 0.7 };

/** Toggle Dim Background */
export function toggleDimBackground(params?: { enabled?: boolean; opacity?: number }): { active: boolean; opacity: number } {
	const video = getPrimaryVideo();
	if (!video) {
		log.warn('No video element found');
		return dimState;
	}

	// Update state
	if (params?.enabled !== undefined) dimState.active = params.enabled;
	else dimState.active = !dimState.active;
	if (params?.opacity !== undefined) dimState.opacity = Math.max(0, Math.min(1, params.opacity));

	let overlay = document.getElementById(DIM_OVERLAY_ID);

	if (dimState.active) {
		if (!overlay) {
			overlay = document.createElement('div');
			overlay.id = DIM_OVERLAY_ID;
			overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;background:#000;';
			document.body.appendChild(overlay);
		}
		overlay.style.opacity = String(dimState.opacity);
		// Promote video z-index
		video.style.position = 'relative';
		video.style.zIndex = '2147483647';
		log.info(`Dim background: ON (opacity=${dimState.opacity})`);
	} else {
		if (overlay) overlay.remove();
		video.style.zIndex = '';
		log.info('Dim background: OFF');
	}

	return dimState;
}


