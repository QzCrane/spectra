// goal: calculates and caches DOM-relative coordinates for EQ sliders to ensure the overlay curve aligns perfectly with the UI

import { TIMING } from '../constants';

export interface MetricsCacheData {
  xCoords: Float32Array;
  midY: number;
  width: number;
  height: number;
  dpr: number;
  scaleFactor: number;
  isValid: boolean;
}

// goal: real-time observer that monitors the EQ slider row and updates the curve projection metrics
export class MetricsCache implements MetricsCacheData {
  private row: HTMLElement;
  private canvas: HTMLCanvasElement;
  private onChange: (() => void) | null;
  private observer: ResizeObserver;

  public xCoords: Float32Array = new Float32Array(10);
  public midY = 0;
  public width = 0;
  public height = 0;
  public dpr = 1;
  // scaleFactor: mapping ratio between decibels (-12 to +12) and pixel offsets on the vertical slider track
  public scaleFactor = 3.66;
  public isValid = false;

  constructor(
    rowElement: HTMLElement,
    canvas: HTMLCanvasElement,
    onChange?: () => void
  ) {
    this.row = rowElement;
    this.canvas = canvas;
    this.onChange = onChange || null;

    // eff: listen for layout shifts (e.g. side panel opening, window resizing) to keep the canvas aligned
    this.observer = new ResizeObserver(() => this.update());
    this.observer.observe(rowElement);

    this.update();

    // note: boot loop to handle cases where initial layout takes several frames to settle (common in Chrome popups)
    const initLoop = (count: number) => {
      if (this.update() || count <= 0) return;
      requestAnimationFrame(() => initLoop(count - 1));
    };
    initLoop(TIMING.METRICS_INIT_LOOPS);
  }

  // eff: recalculates bounding boxes and scales the canvas backing store to match the physical pixel density
  update(): boolean {
    if (!this.row) return false;

    const rect = this.row.getBoundingClientRect();
    if (rect.width === 0) return false;

    const canvasRect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;

    // rule: sync canvas internal resolution with DPR to prevent blurriness on Retina/High-DPI screens
    const physW = canvasRect.width * this.dpr;
    const physH = canvasRect.height * this.dpr;
    if (this.canvas.width !== physW || this.canvas.height !== physH) {
      this.canvas.width = physW;
      this.canvas.height = physH;
    }

    this.width = canvasRect.width;
    this.height = canvasRect.height;
    // note: midY is the 0dB reference line relative to the canvas top boundary
    this.midY = (rect.top - canvasRect.top) + (rect.height / 2);

    const inputs = this.row.querySelectorAll('input');
    const firstInput = inputs[0];
    if (inputs.length > 0 && firstInput) {
      const inputRect = firstInput.getBoundingClientRect();
      // note: derive scale factor dynamically from the actual slider height minus track padding
      this.scaleFactor = (inputRect.height - 12) / 24;
    }

    inputs.forEach((input, i) => {
      const r = input.getBoundingClientRect();
      // note: calculate the horizontal center of each slider relative to the canvas to anchor the spline nodes
      this.xCoords[i] = (r.left - canvasRect.left) + (r.width / 2);
    });

    this.isValid = true;
    if (this.onChange) this.onChange();

    return true;
  }

  destroy(): void {
    this.observer.disconnect();
  }
}
