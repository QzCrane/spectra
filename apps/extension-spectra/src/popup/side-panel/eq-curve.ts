// goal: renders the EQ curve in the side panel by bridging input slider positions with the spline drawing utility

import { MetricsCache, type MetricsCacheData } from '../visualizer/metrics-cache';
import { drawEqCurve } from '../visualizer/draw-eq-curve';

let metricsCache: MetricsCache | null = null;
let cachedCanvas: HTMLCanvasElement | null = null;
let cachedInputs: NodeListOf<HTMLInputElement> | null = null;

function internalDraw(): void {
	if (!cachedCanvas || !cachedInputs || cachedInputs.length === 0) return;
	if (!metricsCache?.isValid) return;

	const ctx = cachedCanvas.getContext('2d');
	if (!ctx) return;

	const values: number[] = [];
	cachedInputs.forEach((inp) => values.push(parseFloat(inp.value) || 0));
	drawEqCurve(ctx, values, metricsCache, '#2563eb');
}

// eff: initializes the metrics observer and establishes the relationship between UI sliders and their canvas coordinates
export function initSidePanelEqCurve(
	canvas: HTMLCanvasElement | null,
	sliderRow: HTMLElement | null,
	inputs: NodeListOf<HTMLInputElement>
): void {
	if (!canvas || !sliderRow || inputs.length === 0) return;

	cachedCanvas = canvas;
	cachedInputs = inputs;

	if (metricsCache) metricsCache.destroy();

	metricsCache = new MetricsCache(sliderRow, canvas, internalDraw);
}

// eff: draws the current EQ curve on the canvas, attempting to use cached metrics first
export function drawSidePanelEqCurve(
	canvas: HTMLCanvasElement | null,
	inputs: NodeListOf<HTMLInputElement>
): void {
	if (!canvas || inputs.length === 0) return;

	const ctx = canvas.getContext('2d');
	if (!ctx) return;

	const values: number[] = [];
	inputs.forEach((inp) => values.push(parseFloat(inp.value) || 0));

	if (metricsCache?.isValid) {
		drawEqCurve(ctx, values, metricsCache, '#2563eb');
		return;
	}

	// rule: use fallback for initial render or when dimensions are changing and the ResizeObserver hasn't fired yet
	fallbackDraw(ctx, canvas, inputs, values);
}

// eff: performs a synchronous, one-time metric calculation and draw for situations where the MetricsCache observer is unavailable
function fallbackDraw(
	ctx: CanvasRenderingContext2D,
	canvas: HTMLCanvasElement,
	inputs: NodeListOf<HTMLInputElement>,
	values: number[]
): void {
	const canvasRect = canvas.getBoundingClientRect();
	if (canvasRect.width === 0 || canvasRect.height === 0) return;

	const dpr = window.devicePixelRatio || 1;

	// note: ensure canvas internal resolution matches display density for visual sharpness
	if (canvas.width !== canvasRect.width * dpr) {
		canvas.width = canvasRect.width * dpr;
		canvas.height = canvasRect.height * dpr;
	}

	const w = canvasRect.width;
	const h = canvasRect.height;
	const midY = h / 2;
	const scaleFactor = (h - 20) / 24; // map 24dB range (-12 to +12) to canvas height with padding

	const xCoords: number[] = [];
	inputs.forEach((inp) => {
		const r = inp.getBoundingClientRect();
		xCoords.push((r.left - canvasRect.left) + (r.width / 2));
	});

	const cache: MetricsCacheData = {
		xCoords: new Float32Array(xCoords),
		midY,
		width: w,
		height: h,
		dpr,
		scaleFactor,
		isValid: true,
	};

	drawEqCurve(ctx, values, cache, '#2563eb');
}

// post: cleans up DOM observers and shared references to prevent memory leaks after panel is dismissed
export function destroySidePanelEqCurve(): void {
	if (metricsCache) {
		metricsCache.destroy();
		metricsCache = null;
	}
	cachedCanvas = null;
	cachedInputs = null;
}


