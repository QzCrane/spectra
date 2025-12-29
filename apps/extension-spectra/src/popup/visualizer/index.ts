// goal: entry point for the visualizer module, providing factory functions for EQ curve rendering and metrics management

export { MetricsCache, type MetricsCacheData } from './metrics-cache';

export { drawViz } from './draw-viz';
export { drawEqCurve } from './draw-eq-curve';

export { createVizLoop, type VizLoopParams } from './loop';

import { MetricsCache } from './metrics-cache';
import { drawEqCurve } from './draw-eq-curve';

// goal: factory function to initialize an EQ curve drawer with persistent metrics and a canvas context
export function createEqCurveDrawer(
  canvas: HTMLCanvasElement | null,
  sliderRow: HTMLElement | null,
  getEqValues: () => number[]
): { draw: (color?: string) => void; updateMetrics: () => void } {
  // note: gracefully degrades if elements are missing (e.g. side panel target not yet rendered)
  if (!canvas || !sliderRow) {
    return {
      draw: () => { },
      updateMetrics: () => { },
    };
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return {
      draw: () => { },
      updateMetrics: () => { },
    };
  }

  let renderRef: (() => void) | null = null;
  let lastColor: string = '#2563eb';

  const metrics = new MetricsCache(sliderRow, canvas, () => {
    if (renderRef) renderRef();
  });

  const draw = (color?: string) => {
    if (color) lastColor = color;
    drawEqCurve(ctx, getEqValues(), metrics, lastColor);
  };

  renderRef = () => draw(lastColor);

  return {
    draw,
    updateMetrics: () => metrics.update(),
  };
}
