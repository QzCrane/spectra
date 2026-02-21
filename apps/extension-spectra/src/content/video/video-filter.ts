// goal: Video brightness, contrast, saturation, grayscale, invert using CSS filters

import { createLogger } from '../../shared/logger';
import { getPrimaryVideo } from '../utils/media-utils';

const log = createLogger('VideoFilter');

interface FilterState { b: number; c: number; s: number; g: boolean; i: boolean; }
const DEF: FilterState = { b: 100, c: 100, s: 100, g: false, i: false };
const fMap = new WeakMap<HTMLVideoElement, FilterState>();

function getState(v: HTMLVideoElement): FilterState {
	let s = fMap.get(v);
	if (!s) { s = { ...DEF }; fMap.set(v, s); }
	return s;
}

function apply(v: HTMLVideoElement) {
	const s = getState(v);
	const f: string[] = [];
	if (s.b !== 100) f.push(`brightness(${s.b}%)`);
	if (s.c !== 100) f.push(`contrast(${s.c}%)`);
	if (s.s !== 100) f.push(`saturate(${s.s}%)`);
	if (s.g) f.push('grayscale(100%)');
	if (s.i) f.push('invert(100%)');
	v.style.filter = f.length ? f.join(' ') : 'none';
	log.info(`Filter: ${f.join(' ') || 'none'}`);
}

export function setVideoFilter(p: { brightness?: number; contrast?: number; saturate?: number; grayscale?: boolean; invert?: boolean }): boolean {
	const v = getPrimaryVideo();
	if (!v) return false;
	const s = getState(v);
	if (p.brightness !== undefined) s.b = Math.max(0, Math.min(200, p.brightness));
	if (p.contrast !== undefined) s.c = Math.max(0, Math.min(200, p.contrast));
	if (p.saturate !== undefined) s.s = Math.max(0, Math.min(200, p.saturate));
	if (p.grayscale !== undefined) s.g = p.grayscale;
	if (p.invert !== undefined) s.i = p.invert;
	apply(v);
	return true;
}

export function resetVideoFilter(): boolean {
	const v = getPrimaryVideo();
	if (!v) return false;
	fMap.set(v, { ...DEF });
	apply(v);
	return true;
}

const DIM_ID = 'spectra-dim-overlay';
let dim = { act: false, op: 0.7 };

export function toggleDimBackground(p?: { enabled?: boolean; opacity?: number }): { active: boolean; opacity: number } {
	const v = getPrimaryVideo();
	if (!v) return { active: dim.act, opacity: dim.op };

	if (p?.enabled !== undefined) dim.act = p.enabled;
	else dim.act = !dim.act;
	if (p?.opacity !== undefined) dim.op = Math.max(0, Math.min(1, p.opacity));

	let o = document.getElementById(DIM_ID);
	if (dim.act) {
		if (!o) {
			o = document.createElement('div');
			o.id = DIM_ID;
			o.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;background:#000;';
			document.body.appendChild(o);
		}
		o.style.opacity = String(dim.op);
		v.style.position = 'relative'; v.style.zIndex = '2147483647';
	} else {
		if (o) o.remove();
		v.style.zIndex = '';
	}
	return { active: dim.act, opacity: dim.op };
}


