// goal: manages the main visualization rendering loop in the popup, polling spectral data from appropriate sources

import type { GlobalSettings } from '@nexus/kernel';
import { OffscreenActions } from '@nexus/contracts';
import { TIMING } from '../constants';
import { sendToTab } from '../utils/dom';
import { drawViz } from './draw-viz';

export interface VizLoopParams {
  canvas: HTMLCanvasElement;
  tabId: number;
  getConfig: () => { enabled: boolean; muted: boolean };
  getCapturing: () => boolean;
  getGlobalSettings: () => GlobalSettings;
  initialPredictedCapture: boolean;
  isCaptureActive: boolean;
}

// post: returns a deferred start function that initiates the recursive requestAnimationFrame loop
export function createVizLoop(params: VizLoopParams): () => void {
  const { canvas, tabId, getConfig, getCapturing, getGlobalSettings, initialPredictedCapture, isCaptureActive } = params;

  let isRequesting = false;
  let lastDraw = 0;
  let loopStarted = false;

  // eff: reusable msg objects to reduce gc pressure
  const msgOffscreen = { target: 'offscreen', action: OffscreenActions.OFFSCREEN_GET_VIZ, tabId };
  // note: sendToTab wrapper might still alloc, but at least we can optimize the payload if needed
  // sendToTab signature: (tabId, action, payload), payload is {} here

  const loop = async (timestamp: number) => {
    // rule: throttle rendering to ~30 FPS to reduce CPU overhead in the popup process
    if (timestamp - lastDraw < TIMING.VIZ_FRAME_INTERVAL) {
      requestAnimationFrame(loop);
      return;
    }
    lastDraw = timestamp;

    const config = getConfig();
    const gSettings = getGlobalSettings();

    if (config.enabled && !config.muted) {
      // rule: if visualizer is globally disabled, render a flat baseline and continue the loop silently
      if (gSettings.visualizerEnabled === false) {
        drawViz(canvas, null, true, getCapturing());
        requestAnimationFrame(loop);
        return;
      }

      if (!isRequesting) {
        isRequesting = true;
        let buffer: number[] | null = null;
        const currentCapturing = getCapturing();

        try {
          if (currentCapturing) {
            // mode: Capture -> poll high-fidelity spectral data from the offscreen document
            const res = await chrome.runtime.sendMessage(msgOffscreen).catch(() => null);
            if (res?.buffer) {
              buffer = res.buffer;
            } else {
              // note: fallback to content script probe
              const data = await sendToTab<{ buffer: number[] }>(tabId, 'AUDIO_GET_VISUALIZER', {});
              if (data?.buffer) buffer = data.buffer;
            }
          } else {
            // mode: Native -> poll data directly from the content script
            const data = await sendToTab<{ buffer: number[] }>(tabId, 'AUDIO_GET_VISUALIZER', {});
            if (data?.buffer) buffer = data.buffer;
          }
        } catch { } // silent fail

        drawViz(canvas, buffer, false, currentCapturing);
        isRequesting = false;
      }
    } else {
      drawViz(canvas, null, true, getCapturing());
    }

    requestAnimationFrame(loop);
  };

  const startLoop = () => {
    if (!loopStarted) { loopStarted = true; requestAnimationFrame(loop); }
  };

  return () => {
    if (initialPredictedCapture && !isCaptureActive) {
      setTimeout(startLoop, TIMING.CAPTURE_INIT_DELAY);
    } else {
      startLoop();
    }
  };
}
