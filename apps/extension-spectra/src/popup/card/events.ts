// goal: binds native DOM events (clicks, inputs, wheel, touch) to audio configuration updates and registry persistence

import type { AudioConfig } from '@nexus/kernel';
import type { CardUIElements } from '../types';
import type { CardInternalState } from './types';
import { AUDIO_UI, TIMING } from '../constants';
import { getDomain, sendToBackground } from '../utils/dom';
import { DEFAULT_CONFIG } from './types';
import { bindMediaControls } from './media-events';

export interface EventsParams {
  ui: CardUIElements;
  state: CardInternalState;
  tabId: number;
  tabUrl: string;
  update: (changes: Partial<AudioConfig>) => void;
  getCapturing: () => boolean;
  onMetricsUpdate: () => void;
  render: () => void;
}

// eff: attaches event listeners to the card UI components, managing the lifecycle of user interactions
export function bindCardEvents(params: EventsParams): void {
  const { ui, state, tabId, tabUrl, update, getCapturing, onMetricsUpdate } = params;
  const domain = getDomain(tabUrl);

  ui.enable.onchange = (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    update({ enabled });

    // rule: explicitly terminate the background capture session if the user disables the master switch
    if (!enabled && getCapturing()) {
      state.isCaptureActive = false;
      sendToBackground('CAPTURE_TOGGLE', {
        enabled: false,
        config: state.config,
        tabId,
      });
    }
  };

  ui.mask.onclick = () => update({ enabled: true });

  const handleVolume = (val: string | number) => {
    const v = typeof val === 'string' ? parseInt(val, 10) : val;
    update({ volume: v, muted: false });
  };

  ui.slider.oninput = (e) => {
    state.isDragging = true;
    handleVolume((e.target as HTMLInputElement).value);
  };

  // note: manage dragging state across various input modalities to prevent "flicker" during external UI sync
  const _endDragging = () => {
    state.isDragging = false;
    params.render?.();
  };

  ui.slider.onchange = () => { state.isDragging = false; };
  ui.slider.onmouseup = () => { state.isDragging = false; };
  ui.slider.ontouchend = () => { state.isDragging = false; };
  ui.slider.onmousedown = () => { state.isDragging = true; };
  ui.slider.ontouchstart = () => { state.isDragging = true; };

  // eff: enable rapid volume adjustment via mouse wheel with preventDefault to avoid scrolling the popup body
  ui.sliderArea.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!state.config.enabled) return;

    let v = parseInt(ui.slider.value, 10);
    v = e.deltaY < 0
      ? Math.min(v + AUDIO_UI.VOLUME_STEP, AUDIO_UI.MAX_VOLUME)
      : Math.max(v - AUDIO_UI.VOLUME_STEP, 0);
    handleVolume(v);
  }, { passive: false });

  ui.mute.onclick = () => update({ muted: !state.config.muted });

  if (ui.comp) ui.comp.onchange = (e) => update({ compressor: (e.target as HTMLInputElement).checked });
  if (ui.bass) ui.bass.onchange = (e) => update({ bass: (e.target as HTMLInputElement).checked });
  if (ui.mono) ui.mono.onchange = (e) => update({ mono: (e.target as HTMLInputElement).checked });

  if (ui.eqTrigger && ui.eqDrawer) {
    ui.eqTrigger.onclick = () => {
      ui.eqDrawer.classList.toggle('open');
      const arrow = ui.eqTrigger.querySelector('.eq-arrow');
      if (arrow) {
        arrow.textContent = ui.eqDrawer.classList.contains('open') ? '▲' : '▼';
      }
      // note: trigger metric recalculation after the CSS transition finishes to align the curve spline
      setTimeout(onMetricsUpdate, TIMING.EQ_DRAWER_DELAY);
    };
  }

  if (ui.eqInputs && ui.eqInputs.length > 0) {
    ui.eqInputs.forEach((inp, i) => {
      inp.oninput = (e) => {
        const arr = [...state.config.eqValues];
        arr[i] = parseFloat((e.target as HTMLInputElement).value);
        update({ eqValues: arr });
      };

      inp.parentElement?.addEventListener('wheel', (e) => {
        e.preventDefault();
        let v = parseFloat(inp.value);
        v = e.deltaY < 0
          ? Math.min(v + AUDIO_UI.EQ_STEP, AUDIO_UI.EQ_MAX)
          : Math.max(v - AUDIO_UI.EQ_STEP, AUDIO_UI.EQ_MIN);
        v = Math.round(v * 10) / 10;

        const arr = [...state.config.eqValues];
        arr[i] = v;
        update({ eqValues: arr });
      }, { passive: false });
    });
  }

  ui.btnSave.onclick = () => {
    chrome.storage.local.get(['siteSettings'], (r) => {
      const s = (r.siteSettings as Record<string, AudioConfig>) || {};
      s[domain] = state.config;
      chrome.storage.local.set({ siteSettings: s }, () => {
        // feedback: provide a transient visual confirmation on the save button
        const old = ui.btnSave.innerText;
        ui.btnSave.innerText = 'OK';
        setTimeout(() => { ui.btnSave.innerText = old; }, TIMING.BUTTON_FEEDBACK_DURATION);
      });
    });
  };

  ui.btnReset.onclick = () => update(DEFAULT_CONFIG);

  bindMediaControls(ui, tabId);
}
