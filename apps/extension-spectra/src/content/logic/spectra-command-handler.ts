// goal: one-release legacy media/video adapter delegating every mutation to the v2 coordinator

import {
	rpcFailure,
	rpcSuccess,
	type ControlMutation,
	type ControlOperation,
	type ControlOperationAck,
	type ControlOperationPayload,
	type ControlOperationRequest,
	type SpectraRequestEnvelope,
	type SpectraRequestType,
} from '@nexus/contracts';
import type { PolicyExecutor, PolicyExecutorState } from './policy-executor';
import { executeHotkeyAction } from '../input/hotkey-actions';
import { getActiveMediaRegistry } from '../core/media-registry';
import { getABState } from '../video/ab-loop';
import { listMarkers } from '../video/time-marker';
import { sendSpectraRequest } from '../../shared/spectra-client';
import { submitTrustedActivationControl } from '../input/hotkey-helpers';

type ContentCommandType = Extract<
	SpectraRequestType,
	| 'spectra.audio.visualizer.get'
	| 'spectra.audio.visualizer.subscription.set'
	| 'spectra.hotkey.trigger'
	| `spectra.media.${string}`
	| `spectra.video.${string}`
>;

export interface SpectraCommandHandlerDeps {
	state: PolicyExecutorState;
	policyExecutor?: PolicyExecutor;
	getVisualizerData: () => Uint8Array | null;
	setVisualizerSubscribed: (subscribed: boolean) => Promise<boolean>;
}

export function isContentCommandType(type: SpectraRequestType): type is ContentCommandType {
	return type === 'spectra.audio.visualizer.get'
		|| type === 'spectra.audio.visualizer.subscription.set'
		|| type === 'spectra.hotkey.trigger'
		|| type.startsWith('spectra.media.')
		|| type.startsWith('spectra.video.');
}

function respondWithFailure(sendResponse: (response?: unknown) => void, error: unknown): void {
	sendResponse(rpcFailure(
		'command_failed',
		error instanceof Error ? error.message : String(error),
		true,
	));
}

function activeMediaState(): {
	playing: boolean;
	speed: number;
	pipActive: boolean;
	preservePitch: boolean;
} {
	const media = getActiveMediaRegistry()?.resolve(null)?.element ?? null;
	return {
		playing: media ? !media.paused : false,
		speed: media?.playbackRate ?? 1,
		pipActive: document.pictureInPictureElement === media,
		preservePitch: media && 'preservesPitch' in media
			? (media as HTMLMediaElement & { preservesPitch: boolean }).preservesPitch
			: true,
	};
}

async function submitLegacyOperation<O extends ControlOperation>(
	operation: O,
	payload: ControlOperationPayload<O>,
): Promise<ControlOperationAck<O>> {
	const response = await sendSpectraRequest('spectra.control.operation.submit', {
		source: 'popup',
		target: null,
		operation,
		payload,
	} as unknown as ControlOperationRequest);
	if (!response.ok) throw new Error(response.error.message);
	return response.data as ControlOperationAck<O>;
}

async function submitLegacyMutations(
	mutations: readonly ControlMutation[],
): Promise<import('@nexus/contracts').ControlApplyAck> {
	const response = await sendSpectraRequest('spectra.control.intent.submit', {
		source: 'popup',
		requestedCoverage: 'active-target',
		target: null,
		mutations,
	});
	if (!response.ok) throw new Error(response.error.message);
	const failure = Object.values(response.data.fields)
		.find((field) => field?.phase !== 'applied');
	if (failure) throw new Error(failure.lastError?.message ?? 'Legacy control was not applied');
	return response.data;
}

// post: returns true when an asynchronous response keeps the message port open
export function handleSpectraContentCommand(
	message: SpectraRequestEnvelope,
	deps: SpectraCommandHandlerDeps,
	sendResponse: (response?: unknown) => void,
): boolean {
	try {
		switch (message.type) {
		case 'spectra.audio.visualizer.get': {
				const data = deps.getVisualizerData();
				sendResponse(rpcSuccess({ buffer: data ? Array.from(data) : null }));
				return false;
			}
			case 'spectra.audio.visualizer.subscription.set': {
				void deps.setVisualizerSubscribed(message.payload.subscribed).then(
					(subscribed) => sendResponse(rpcSuccess({ subscribed })),
					(error) => respondWithFailure(sendResponse, error),
				);
				return true;
			}
			case 'spectra.hotkey.trigger':
				void executeHotkeyAction(message.payload.action).then(
					() => sendResponse(rpcSuccess({ handled: true as const })),
					(error) => respondWithFailure(sendResponse, error),
				);
				return true;
			case 'spectra.media.state.get':
				sendResponse(rpcSuccess(activeMediaState()));
				return false;
			case 'spectra.media.play.toggle':
				void submitLegacyOperation('playback-toggle', {}).then(
					(ack) => sendResponse(rpcSuccess({ playing: ack.result.playing })),
					(error) => respondWithFailure(sendResponse, error),
				);
				return true;
			case 'spectra.media.pip.toggle':
				void submitTrustedActivationControl('pip').then(
					(result) => sendResponse(rpcSuccess({ active: result.actual })),
					(error) => respondWithFailure(sendResponse, error),
				);
				return true;
			case 'spectra.media.speed.set': {
				const mutations: ControlMutation[] = [];
				if (message.payload.delta !== undefined) {
					mutations.push({ field: 'speed', operation: 'delta', value: message.payload.delta });
				} else {
					mutations.push({ field: 'speed', operation: 'set', value: message.payload.speed ?? 1 });
				}
				if (message.payload.preservePitch !== undefined) {
					mutations.push({
						field: 'preservePitch',
						operation: 'set',
						value: message.payload.preservePitch,
					});
				}
				void submitLegacyMutations(mutations).then(
					(ack) => sendResponse(rpcSuccess({
						speed: Number(ack.fields.speed?.actual ?? activeMediaState().speed),
						preservePitch: Boolean(
							ack.fields.preservePitch?.actual ?? activeMediaState().preservePitch,
						),
					})),
					(error) => respondWithFailure(sendResponse, error),
				);
				return true;
			}
			case 'spectra.video.rotate':
				void submitLegacyMutations([{ field: 'rotation', operation: 'delta', value: message.payload.delta }]).then(
					(ack) => sendResponse(rpcSuccess({ rotation: Number(ack.fields.rotation?.actual ?? 0) })),
					(error) => respondWithFailure(sendResponse, error),
				);
				return true;
			case 'spectra.video.mirror.toggle':
				void submitLegacyMutations([{ field: 'mirrored', operation: 'toggle' }]).then(
					(ack) => sendResponse(rpcSuccess({ mirrored: ack.fields.mirrored?.actual === true })),
					(error) => respondWithFailure(sendResponse, error),
				);
				return true;
			case 'spectra.video.screenshot':
				void submitLegacyOperation('screenshot', {}).then(
					(ack) => sendResponse(rpcSuccess(ack.result)),
					(error) => respondWithFailure(sendResponse, error),
				);
				return true;
			case 'spectra.video.fullscreen.toggle':
				void submitLegacyMutations([{ field: 'fullscreen', operation: 'toggle' }]).then(
					(ack) => sendResponse(rpcSuccess({ active: ack.fields.fullscreen?.actual === true })),
					(error) => respondWithFailure(sendResponse, error),
				);
				return true;
			case 'spectra.video.crop.toggle':
				void submitLegacyMutations([{ field: 'fill', operation: 'toggle' }]).then(
					(ack) => sendResponse(rpcSuccess({ cropped: ack.fields.fill?.actual === true })),
					(error) => respondWithFailure(sendResponse, error),
				);
				return true;
			case 'spectra.video.seek':
				void submitLegacyOperation('seek-relative', { delta: message.payload.delta }).then(
					(ack) => sendResponse(rpcSuccess({ currentTime: ack.result.currentTime })),
					(error) => respondWithFailure(sendResponse, error),
				);
				return true;
			case 'spectra.video.filter.set':
				void submitLegacyMutations([
					{ field: 'filter', operation: 'set', value: {
						brightness: message.payload.brightness ?? 100,
						contrast: message.payload.contrast ?? 100,
						saturate: message.payload.saturate ?? 100,
						grayscale: message.payload.grayscale ?? false,
						invert: message.payload.invert ?? false,
					} },
					{ field: 'filterEnabled', operation: 'set', value: true },
				]).then(
					(ack) => sendResponse(rpcSuccess({ applied: ack.fields.filter?.phase === 'applied' })),
					(error) => respondWithFailure(sendResponse, error),
				);
				return true;
			case 'spectra.video.filter.reset':
				void submitLegacyOperation('video-effects-reset', {}).then(
					() => sendResponse(rpcSuccess({ reset: true as const })),
					(error) => respondWithFailure(sendResponse, error),
				);
				return true;
			case 'spectra.video.dim.toggle': {
				const mutations: ControlMutation[] = [{
					field: 'dimEnabled',
					operation: message.payload.enabled === undefined ? 'toggle' : 'set',
					...(message.payload.enabled === undefined ? {} : { value: message.payload.enabled }),
				}];
				if (message.payload.opacity !== undefined) mutations.push({
					field: 'dimOpacity', operation: 'set', value: message.payload.opacity,
				});
				void submitLegacyMutations(mutations).then(
					(ack) => sendResponse(rpcSuccess({
						active: ack.fields.dimEnabled?.actual === true,
						opacity: Number(ack.fields.dimOpacity?.actual ?? message.payload.opacity ?? 0.72),
					})),
					(error) => respondWithFailure(sendResponse, error),
				);
				return true;
			}
			case 'spectra.video.ab.a.set':
				void submitLegacyOperation('ab-set-a', {}).then(
					(ack) => sendResponse(rpcSuccess({ pointA: ack.result.abLoop.pointA })),
					(error) => respondWithFailure(sendResponse, error),
				);
				return true;
			case 'spectra.video.ab.b.set':
				void submitLegacyOperation('ab-set-b', {}).then(
					(ack) => sendResponse(rpcSuccess({
						pointB: ack.result.abLoop.pointB,
						looping: ack.result.abLoop.enabled,
					})),
					(error) => respondWithFailure(sendResponse, error),
				);
				return true;
			case 'spectra.video.ab.clear':
				void submitLegacyOperation('ab-clear', {}).then(
					(ack) => sendResponse(rpcSuccess({ cleared: ack.result.cleared })),
					(error) => respondWithFailure(sendResponse, error),
				);
				return true;
			case 'spectra.video.ab.get':
				sendResponse(rpcSuccess(getABState()));
				return false;
			case 'spectra.video.marker.add':
				void submitLegacyOperation('marker-add', message.payload).then(
					(ack) => sendResponse(rpcSuccess({ marker: ack.result.marker })),
					(error) => respondWithFailure(sendResponse, error),
				);
				return true;
			case 'spectra.video.marker.remove':
				void submitLegacyOperation('marker-remove', message.payload).then(
					(ack) => sendResponse(rpcSuccess({ removed: ack.result.removed })),
					(error) => respondWithFailure(sendResponse, error),
				);
				return true;
			case 'spectra.video.marker.jump':
				void submitLegacyOperation('marker-jump', message.payload).then(
					(ack) => sendResponse(rpcSuccess(ack.result)),
					(error) => respondWithFailure(sendResponse, error),
				);
				return true;
			case 'spectra.video.marker.list':
				sendResponse(rpcSuccess({ markers: listMarkers() }));
				return false;
		}
	} catch (error) {
		respondWithFailure(sendResponse, error);
	}
	return false;
}
