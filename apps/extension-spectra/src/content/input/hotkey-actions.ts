// goal: routes global hotkey actions to their respective functional handlers (media, video, audio, etc.)

import { isHotkeyParamsForAction, type HotkeyAction, type HotkeyParams } from '@nexus/contracts';
import { createLogger } from '../../shared/logger';
import { showToast } from '../ui/toast';
import {
	sendVolumeAction, sendSpeedAction, sendAudioAdjustment, toggleLoop, sendTabAction,
	submitHotkeyMutations, submitHotkeyOperation, submitTrustedActivationControl,
} from './hotkey-helpers';

const log = createLogger('HotkeyActions');

type HotkeyHandler = (params?: HotkeyParams) => unknown | Promise<unknown>;

function executeUserScript(params?: HotkeyParams): Promise<unknown> | undefined {
	if (!params?.script) return;
	return submitHotkeyOperation('run-user-script', { script: params.script });
}

function openUrl(params?: HotkeyParams): Promise<unknown> | undefined {
	if (!params?.url) return undefined;
	try {
		const url = new URL(params.url);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Unsupported URL protocol');
		return submitHotkeyOperation('open-url', { url: url.href });
	} catch {
		showToast('Only HTTP and HTTPS URLs are allowed');
		return undefined;
	}
}

// inv: every persisted HotkeyAction has an explicit runtime disposition.
export const HOTKEY_ACTION_HANDLERS = {
	none: () => undefined,
	play_pause: () => submitTrustedActivationControl('playing'),
	seek_forward_5s: () => submitHotkeyOperation('seek-relative', { delta: 5 }),
	seek_forward_10s: () => submitHotkeyOperation('seek-relative', { delta: 10 }),
	seek_forward_30s: () => submitHotkeyOperation('seek-relative', { delta: 30 }),
	seek_backward_5s: () => submitHotkeyOperation('seek-relative', { delta: -5 }),
	seek_backward_10s: () => submitHotkeyOperation('seek-relative', { delta: -10 }),
	seek_backward_30s: () => submitHotkeyOperation('seek-relative', { delta: -30 }),
	seek_frame_forward: () => submitHotkeyOperation('frame-step', { direction: 1 }),
	seek_frame_backward: () => submitHotkeyOperation('frame-step', { direction: -1 }),
	speed_up: (params) => sendSpeedAction('speed_up', params),
	speed_down: (params) => sendSpeedAction('speed_down', params),
	speed_reset: (params) => sendSpeedAction('speed_reset', params),
	speed_set: (params) => sendSpeedAction('speed_set', params),
	volume_up: (params) => sendVolumeAction('volume_up', params),
	volume_down: (params) => sendVolumeAction('volume_down', params),
	volume_mute: (params) => sendVolumeAction('volume_mute', params),
	volume_set: (params) => sendVolumeAction('volume_set', params),
	audio_reset: () => submitHotkeyOperation('audio-reset', {}),
	gain_up: (params) => sendAudioAdjustment('gain_up', params),
	gain_down: (params) => sendAudioAdjustment('gain_down', params),
	pitch_up: () => showToast('Pitch controls are unavailable; reassign this shortcut in Options'),
	pitch_down: () => showToast('Pitch controls are unavailable; reassign this shortcut in Options'),
	pitch_reset: () => showToast('Pitch controls are unavailable; reassign this shortcut in Options'),
	delay_up: (params) => sendAudioAdjustment('delay_up', params),
	delay_down: (params) => sendAudioAdjustment('delay_down', params),
	delay_reset: (params) => sendAudioAdjustment('delay_reset', params),
	pan_left: (params) => sendAudioAdjustment('pan_left', params),
	pan_right: (params) => sendAudioAdjustment('pan_right', params),
	pan_reset: (params) => sendAudioAdjustment('pan_reset', params),
	mono_toggle: (params) => sendAudioAdjustment('mono_toggle', params),
	capture_toggle: () => showToast('Capture is automatic; reassign this legacy shortcut in Options'),
	fullscreen_toggle: () => submitTrustedActivationControl('fullscreen'),
	pip_toggle: () => submitTrustedActivationControl('pip'),
	rotate_cw: () => submitHotkeyMutations([{ field: 'rotation', operation: 'delta', value: 90 }]),
	rotate_ccw: () => submitHotkeyMutations([{ field: 'rotation', operation: 'delta', value: -90 }]),
	mirror_toggle: () => submitHotkeyMutations([{ field: 'mirrored', operation: 'toggle' }]),
	screenshot: () => submitHotkeyOperation('screenshot', {}),
	dim_background: () => submitHotkeyMutations([{ field: 'dimEnabled', operation: 'toggle' }]),
	marker_add: async () => {
		const ack = await submitHotkeyOperation('marker-add', {});
		showToast(ack.result.marker ? 'Marker added' : 'No active media target');
	},
	marker_jump_prev: async () => {
		const ack = await submitHotkeyOperation('marker-jump-previous', {});
		showToast(ack.result.marker ? `Jump to ${ack.result.marker.label}` : 'No marker available');
	},
	marker_jump_next: async () => {
		const ack = await submitHotkeyOperation('marker-jump-next', {});
		showToast(ack.result.marker ? `Jump to ${ack.result.marker.label}` : 'No marker available');
	},
	ab_set_a: async () => { await submitHotkeyOperation('ab-set-a', {}); showToast('Point A set'); },
	ab_set_b: async () => { await submitHotkeyOperation('ab-set-b', {}); showToast('Point B set'); },
	ab_clear: async () => { await submitHotkeyOperation('ab-clear', {}); showToast('AB loop cleared'); },
	ab_skip: async () => {
		const ack = await submitHotkeyOperation('ab-skip', {});
		showToast(ack.result.skipped ? 'Skipped A/B segment' : 'Set A and B first');
	},
	loop_toggle: async () => { await toggleLoop(); },
	fx_toggle: () => submitHotkeyOperation('video-effects-toggle', {}),
	fx_reset: () => submitHotkeyOperation('video-effects-reset', {}),
	tab_pin: async () => { await sendTabAction('tab_pin'); },
	tab_mute: async () => { await sendTabAction('tab_mute'); },
	show_info: () => submitHotkeyOperation('show-info', {}),
	open_popup: () => submitHotkeyOperation('open-popup', {}),
	open_options: () => submitHotkeyOperation('open-options', {}),
	run_js: executeUserScript,
	open_url: openUrl,
} satisfies Record<HotkeyAction, HotkeyHandler>;

export const HANDLED_HOTKEY_ACTIONS: ReadonlySet<HotkeyAction> = new Set(
	Object.keys(HOTKEY_ACTION_HANDLERS) as HotkeyAction[],
);

// eff: executes the requested action through the exhaustive, testable registry
export async function executeHotkeyAction(action: HotkeyAction, params?: HotkeyParams): Promise<void> {
	log.debug(`Executing action: ${action}`, params);
	if (!isHotkeyParamsForAction(action, params)) {
		throw new Error(`Invalid parameters for hotkey action ${action}`);
	}
	await HOTKEY_ACTION_HANDLERS[action](params);
}
