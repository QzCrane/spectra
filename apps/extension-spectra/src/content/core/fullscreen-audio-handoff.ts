// goal: serialize short native-audio handoffs around fullscreen requests

import type { WebAudioController } from '@nexus/audio-engine';
import type { CaptureManager } from '../audio/capture-manager';
import type { PolicyExecutor } from '../logic/policy-executor';
import type { PolicyExecutorState } from '../types';
import { logger } from '../../shared/logger';
import {
	SPECTRA_FULLSCREEN_BRIDGE_READY_ATTRIBUTE,
	SPECTRA_FULLSCREEN_FINISH_EVENT,
	SPECTRA_FULLSCREEN_PREPARE_EVENT,
	SPECTRA_FULLSCREEN_READY_EVENT,
	SPECTRA_FULLSCREEN_REQUEST_ATTRIBUTE,
	SPECTRA_FULLSCREEN_RESULT_ATTRIBUTE,
	type SpectraFullscreenBridgeMessage,
} from '../../shared/fullscreen-bridge';

const log = logger.content;

export interface FullscreenAudioHandoff {
	run<T>(operation: () => Promise<T>): Promise<T>;
	dispose(): void;
}

interface FullscreenAudioHandoffDeps {
	state: PolicyExecutorState;
	policyExecutor: PolicyExecutor;
	audioController: WebAudioController;
	captureManager: CaptureManager;
}

type AudioSuspension = {
	kind: 'capture';
	continuation: NonNullable<Awaited<ReturnType<CaptureManager['suspendForContinuation']>>>;
	mode: PolicyExecutorState['activeMode'];
} | {
	kind: 'webaudio';
};

function decodeRequest(): SpectraFullscreenBridgeMessage | null {
	const encoded = document.documentElement?.getAttribute(SPECTRA_FULLSCREEN_REQUEST_ATTRIBUTE);
	if (!encoded) return null;
	try {
		const value = JSON.parse(encoded) as Partial<SpectraFullscreenBridgeMessage>;
		return typeof value.requestId === 'string' && value.requestId.length > 0
			? { requestId: value.requestId }
			: null;
	} catch {
		return null;
	}
}

export function createFullscreenAudioHandoff(
	deps: FullscreenAudioHandoffDeps,
): FullscreenAudioHandoff {
	let suspension: Promise<AudioSuspension | null> | null = null;
	let suspensionUsers = 0;
	let disposed = false;
	const pending = new Map<string, Promise<() => Promise<void>>>();
	const finishedBeforeReady = new Set<string>();

	const suspend = async (): Promise<AudioSuspension | null> => {
		const captureActive = deps.captureManager.isActive()
			|| deps.state.actualMode === 'capture';
		const webAudioActive = deps.state.actualMode === 'webaudio';
		if (!captureActive && !webAudioActive) return null;

		if (captureActive) {
			await deps.captureManager.waitForSettled();
			if (!deps.captureManager.isActive()) {
				throw new Error('Capture lifecycle had no active processor to hand off');
			}
			const continuation = await deps.captureManager.suspendForContinuation(
				deps.state.config,
				deps.state.generation + 1,
			);
			if (!continuation) throw new Error('Capture did not create a fullscreen continuation');
			deps.state.generation = Math.max(
				deps.state.generation,
				deps.captureManager.getGeneration(),
			);
			deps.state.actualMode = 'bypass';
			deps.state.phase = 'idle';
			return { kind: 'capture', continuation, mode: deps.state.activeMode };
		} else {
			await deps.audioController.cleanup();
		}
		deps.state.actualMode = 'bypass';
		deps.state.phase = 'idle';
		return { kind: 'webaudio' };
	};

	const restore = async (suspended: AudioSuspension | null): Promise<void> => {
		if (!suspended || disposed) return;
		deps.state.userHasInteracted = true;
		if (suspended.kind === 'capture' && deps.state.activeMode === suspended.mode) {
			const result = await suspended.continuation.resume(
				deps.state.config,
				deps.state.generation + 1,
			);
			deps.state.generation = Math.max(deps.state.generation, result.generation ?? 0);
			deps.state.actualMode = 'capture';
			deps.state.phase = 'active';
			deps.state.lastError = undefined;
			const actual = result.actualConfig ?? deps.captureManager.getActualConfig();
			if (actual) deps.state.appliedConfig = { ...actual, eqValues: [...actual.eqValues] };
		}
		await deps.policyExecutor.applyState({ modeIntent: true });
	};

	const acquire = async (): Promise<() => Promise<void>> => {
		suspensionUsers += 1;
		if (!suspension) {
			suspension = suspend().catch((error) => {
				log.warn('[Fullscreen] Audio handoff failed; continuing with native fullscreen', error);
				return null;
			});
		}
		const currentSuspension = suspension;
		// READY means the old processor has actually yielded, not merely that the
		// transition was scheduled. This preserves the original fullscreen gesture
		// while preventing the browser from racing an in-flight Capture stop.
		await currentSuspension;
		let released = false;
		return async () => {
			if (released) return;
			released = true;
			suspensionUsers = Math.max(0, suspensionUsers - 1);
			if (suspensionUsers > 0 || suspension !== currentSuspension) return;
			suspension = null;
			await restore(await currentSuspension).catch((error) => {
				log.warn('[Fullscreen] Audio restore failed', error);
			});
		};
	};

	const onPrepare = (): void => {
		const request = decodeRequest();
		if (!request || pending.has(request.requestId)) return;
		const release = acquire();
		pending.set(request.requestId, release);
		void release.then(async (releaseAudio) => {
			if (disposed || finishedBeforeReady.delete(request.requestId)) {
				pending.delete(request.requestId);
				await releaseAudio();
				return;
			}
			document.documentElement.setAttribute(
				SPECTRA_FULLSCREEN_RESULT_ATTRIBUTE,
				JSON.stringify(request),
			);
			document.dispatchEvent(new Event(SPECTRA_FULLSCREEN_READY_EVENT));
		});
	};

	const onFinish = (): void => {
		const request = decodeRequest();
		if (!request) return;
		const release = pending.get(request.requestId);
		if (!release) {
			finishedBeforeReady.add(request.requestId);
			return;
		}
		pending.delete(request.requestId);
		void release.then((releaseAudio) => releaseAudio());
	};

	document.documentElement?.setAttribute(SPECTRA_FULLSCREEN_BRIDGE_READY_ATTRIBUTE, 'true');
	document.addEventListener(SPECTRA_FULLSCREEN_PREPARE_EVENT, onPrepare);
	document.addEventListener(SPECTRA_FULLSCREEN_FINISH_EVENT, onFinish);

	return {
		async run<T>(operation: () => Promise<T>): Promise<T> {
			const release = await acquire();
			try {
				return await operation();
			} finally {
				await release();
			}
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			document.removeEventListener(SPECTRA_FULLSCREEN_PREPARE_EVENT, onPrepare);
			document.removeEventListener(SPECTRA_FULLSCREEN_FINISH_EVENT, onFinish);
			document.documentElement?.removeAttribute(SPECTRA_FULLSCREEN_BRIDGE_READY_ATTRIBUTE);
			for (const release of pending.values()) {
				void release.then((releaseAudio) => releaseAudio());
			}
			pending.clear();
			finishedBeforeReady.clear();
		},
	};
}
