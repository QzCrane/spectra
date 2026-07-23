// goal: binds native DOM events (clicks, inputs, wheel, touch) to audio configuration updates and registry persistence

import type { CardUIElements } from '../types';
import type { CardInternalState } from './types';
import type { ConfigUpdateFn } from './state';
import type { ControlOperationAck } from '@nexus/contracts';
import { AUDIO_UI, TIMING } from '../constants';
import { getDomain } from '../utils/dom';
import { bindMediaControls } from './media-events';
import { patchSettings } from '../../shared/settings-client';
import { sendSpectraRequest } from '../../shared/ui-spectra-client';
import { mergeAudioConfig, mergeControlFields } from './types';
import { showPopupToast } from '../toast';

export interface EventsParams {
  ui: CardUIElements;
  state: CardInternalState;
  tabId: number;
  tabUrl: string;
  update: ConfigUpdateFn;
  getCapturing: () => boolean;
  onMetricsUpdate: () => void;
  render: () => void;
}

// eff: transiently swaps a save button's icon for a localized success/failure
// label. Both .btn-save and .btn-save-global share this helper so the feedback
// style stays consistent. The .feedback/.saved/.failed classes in popup.css
// auto-size the button and tint it green/red; after the feedback window the
// original icon HTML is restored.
function showSaveFeedback(button: HTMLElement, success: boolean, dict: { saveSuccess: string; saveFailed: string }): void {
  const originalHTML = button.innerHTML;
  button.classList.remove('saved', 'failed');
  button.classList.add('feedback', success ? 'saved' : 'failed');
  const candidate = success ? dict.saveSuccess : dict.saveFailed;
  button.innerText = typeof candidate === 'string' && candidate.trim().length > 0
    ? candidate
    : success ? 'Saved' : 'Failed';
  setTimeout(() => {
    button.classList.remove('feedback', 'saved', 'failed');
    button.innerHTML = originalHTML;
  }, TIMING.BUTTON_FEEDBACK_DURATION);
}

// eff: attaches event listeners to the card UI components, managing the lifecycle of user interactions
export function bindCardEvents(params: EventsParams): void {
  const { ui, state, tabId, tabUrl, update, onMetricsUpdate, render } = params;
  const domain = getDomain(tabUrl);

	const readActualSpeed = async (): Promise<number | null> => {
		const response = await sendSpectraRequest(
			'spectra.control.snapshot.get',
			{ tabId },
			{ tabId },
		);
		if (!response.ok) return null;
		const speed = response.data?.fields.speed?.actual;
		return typeof speed === 'number' ? speed : null;
	};

  ui.enable.onchange = (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    update({ enabled });

  };

  ui.mask.onclick = () => update({ enabled: true });
  ui.mask.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      update({ enabled: true });
    }
  };

  const handleVolume = (val: string | number) => {
    const raw = typeof val === 'string' ? Number.parseFloat(val) : val;
    const volume = Math.max(0, Math.min(AUDIO_UI.MAX_VOLUME, raw));
    // `volume` is the single product-level control. mergeAudioConfig performs
    // the internal native-volume/processor-boost split atomically in UI state.
    update({ volume });
  };

	const submitToggle = async (field: 'mediaMuted'): Promise<void> => {
		await update.runControl(async () => {
			const response = await sendSpectraRequest(
				'spectra.control.intent.submit',
				{
					tabId,
					source: 'popup',
					requestedCoverage: 'active-target',
					target: state.controlSnapshot?.activeMedia ?? null,
					baseRevision: state.controlRevision,
					mutations: [{ field, operation: 'toggle' }],
				},
				{ tabId },
			);
			if (!response.ok) {
				state.lastError = response.error;
				throw new Error(response.error.message);
			}
			state.controlRevision = Math.max(state.controlRevision, response.data.revision);
			state.controlGeneration = Math.max(state.controlGeneration, response.data.generation);
			const fieldState = response.data.fields[field];
			if (fieldState?.phase !== 'applied') {
				const error = fieldState?.lastError ?? {
					code: 'control_not_applied',
					message: 'Mute state was not applied',
					retryable: true,
				};
				state.lastError = error;
				throw new Error(error.message);
			}
		});
	};

  const setDragging = (field: CardInternalState['draggingField']) => {
    state.draggingField = field;
    state.isDragging = field !== null;
  };

  ui.slider.oninput = (e) => {
    setDragging('volume');
    handleVolume((e.target as HTMLInputElement).value);
  };

  // note: manage dragging state across various input modalities to prevent "flicker" during external UI sync
  ui.slider.onchange = () => {
    setDragging(null);
    void update.flush().catch(() => undefined);
  };
  ui.slider.onmouseup = () => setDragging(null);
  ui.slider.ontouchend = () => setDragging(null);
  ui.slider.onmousedown = () => setDragging('volume');
  ui.slider.ontouchstart = () => setDragging('volume');

  // eff: enable rapid volume adjustment via mouse wheel with preventDefault to avoid scrolling the popup body
  let wheelTimer: ReturnType<typeof setTimeout> | null = null;
  ui.sliderArea.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!state.config.enabled) return;

    // Set dragging state to prevent render from updating slider.value
    setDragging('volume');

    let v = parseInt(ui.slider.value, 10);
    v = e.deltaY < 0
      ? Math.min(v + AUDIO_UI.VOLUME_STEP, AUDIO_UI.MAX_VOLUME)
      : Math.max(v - AUDIO_UI.VOLUME_STEP, 0);
    handleVolume(v);

    // Clear dragging state after wheel stops (300ms debounce)
    if (wheelTimer) clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      setDragging(null);
      void update.flush().catch(() => undefined);
    }, 300);
  }, { passive: false });

  ui.mute.onclick = () => {
	void submitToggle('mediaMuted').catch(() => render());
  };

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
      inp.onchange = () => {
        void update.flush().catch(() => undefined);
      };

      inp.parentElement?.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.stopPropagation();
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

  ui.btnSave.onclick = async () => {
    // eff: capture current playback speed to include in the preset
    try {
      const speed = await readActualSpeed();
	  if (speed !== null) {
		state.config.speed = speed;
	  }
    } catch (e) {
      console.warn('Failed to get speed for preset save', e);
    }

    const { getCurrentDict } = await import('../views/i18n-apply');
    const dict = getCurrentDict();
    try {
      await patchSettings({ scope: 'audio-site', domain, value: state.config, mode: 'replace' });
      // feedback: shared i18n success indicator on the save button
      if (dict) showSaveFeedback(ui.btnSave, true, dict);
    } catch (error) {
      console.error('Failed to save config:', error);
      // feedback: shared i18n failure indicator on the save button
      if (dict) showSaveFeedback(ui.btnSave, false, dict);
    }
  };

  // eff: save as global preset — zero-interaction save. The preset name is
  // auto-generated inside saveGlobalPreset so the user is never prompted.
  if (ui.btnSaveGlobal) {
    ui.btnSaveGlobal.onclick = async () => {
      // eff: capture current playback speed
      try {
        const speed = await readActualSpeed();
		if (speed !== null) {
		  state.config.speed = speed;
        }
      } catch (e) {
        console.warn('Failed to get speed for global preset save', e);
      }

      const { getCurrentDict } = await import('../views/i18n-apply');
      const dict = getCurrentDict();
      try {
        const { saveGlobalPreset } = await import('../views/presets-ui');
        await saveGlobalPreset(state.config);
        // feedback: shared i18n success indicator — same style as btnSave
        if (dict) showSaveFeedback(ui.btnSaveGlobal!, true, dict);
      } catch (error) {
        console.error('Failed to save global preset:', error);
        // feedback: previously btnSaveGlobal had no failure feedback at all;
        // share the same failure indicator as btnSave for consistency.
        if (dict) showSaveFeedback(ui.btnSaveGlobal!, false, dict);
      }
    };
  }

  ui.btnReset.onclick = () => {
	ui.btnReset.setAttribute('aria-busy', 'true');
	ui.btnReset.setAttribute('disabled', '');
	void (async () => {
		// Drain local slider/EQ mutations first so reset cannot race a trailing
		// debounce that would immediately re-apply the pre-reset values. A failed
		// stale mutation must not cancel the explicit reset that follows it.
		await update.flush().catch(() => undefined);
		const response = await sendSpectraRequest(
			'spectra.control.operation.submit',
			{
				tabId,
				source: 'popup',
				// Reset is an execution-time command: let the serialized coordinator
				// resolve the current media instead of pinning stale Popup identity.
				target: null,
				operation: 'audio-reset',
				payload: {},
			},
			{ tabId },
		);
		if (!response.ok) throw new Error(response.error.message);
		const acknowledgement = response.data as ControlOperationAck<'audio-reset'>;
		if (acknowledgement.result.reset !== true) throw new Error('Audio reset was not acknowledged');
		state.controlRevision = Math.max(state.controlRevision, acknowledgement.revision);
		state.controlGeneration = Math.max(state.controlGeneration, acknowledgement.generation);
		const acknowledged = mergeControlFields(state.stableConfig, acknowledgement.fields);
		state.stableConfig = mergeAudioConfig(acknowledged, {
			enabled: true,
			volume: 100,
			volumeBase: 100,
			speed: 1,
			boost: 1,
			muted: false,
			compressor: false,
			mono: false,
			bass: false,
			eqValues: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			pan: 0,
			delay: 0,
		});
		state.config = mergeAudioConfig(state.stableConfig, {
			eqValues: [...state.stableConfig.eqValues],
		});
		state.lastError = null;
	})().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		state.lastError = { code: 'audio_reset_failed', message, retryable: true };
		showPopupToast(message, 'error');
	}).finally(() => {
		ui.btnReset.removeAttribute('disabled');
		ui.btnReset.removeAttribute('aria-busy');
		render();
	});
  };

  bindMediaControls(ui, tabId, state, update);
}
