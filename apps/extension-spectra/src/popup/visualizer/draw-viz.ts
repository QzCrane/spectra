// goal: renders the spectrum frequency bars on a canvas using provided spectral data

import { COLORS, UI_SIZES, VIZ_PARAMS } from '../constants';

// eff: clears the canvas and draws a series of vertical bars representing frequency amplitudes
export function drawViz(
  canvas: HTMLCanvasElement,
  data: number[] | Uint8Array | null,
  isMuted: boolean,
  isCapture: boolean
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  // note: gracefully exits if no data is provided or the source is muted (visual silence)
  if (!data || isMuted) return;

  const barW = UI_SIZES.VIZ_BAR_WIDTH;
  const gap = UI_SIZES.VIZ_BAR_GAP;
  const count = Math.floor(w / (barW + gap));
  const step = Math.floor(data.length / count) || 1;

  // rule: use distinct colors to visually indicate whether audio is captured (high fidelity) or native (low fidelity)
  ctx.fillStyle = isCapture ? COLORS.CAPTURE : COLORS.NATIVE;

  for (let i = 0; i < count; i++) {
    // note: sample the frequency bin at a calculated step to fit the requested bar count
    const val = data[i * step] || 0;
    const barH = (val / 255) * h * VIZ_PARAMS.HEIGHT_FACTOR;

    // rule: only draw bars that exceed a minimum visibility threshold to maintain UI cleanliness
    if (barH > VIZ_PARAMS.MIN_VISIBLE_HEIGHT) {
      ctx.fillRect(i * (barW + gap), h - barH, barW, barH);
    }
  }
}
