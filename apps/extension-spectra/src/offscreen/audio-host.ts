// goal: acknowledged, revisioned tab-capture processing on one sparse shared graph

import {
	AudioGraphRouter,
	audioConfigToGraphConfig,
	type AudioGraphSnapshot,
} from '@nexus/audio-engine';
import {
	type AudioConfig,
	type AudioProcessorConfig,
	type OffscreenAudioEvent,
	type OffscreenAudioRequest,
	type OffscreenAudioRequestType,
	type OffscreenAudioResult,
	type OffscreenHostResponse,
} from '@nexus/contracts';

export interface AudioHostDescription {
	tabId: number;
	generation: number;
	controlRevision: number;
	graphSignature: string;
	normalizedActualConfig: AudioProcessorConfig;
}

interface AudioProcessor {
	tabId: number;
	generation: number;
	controlRevision: number;
	ctx: AudioContext;
	stream: MediaStream;
	source: MediaStreamAudioSourceNode;
	commitGate: GainNode;
	router: AudioGraphRouter;
	snapshot: AudioGraphSnapshot;
	vizDisposer: (() => void) | null;
	lastVizAt: number;
	lastVizFrame: number[] | null;
	trackEndedDisposers: Array<() => void>;
	disposing: boolean;
}

type AudioIntentKind = 'start' | 'update' | 'stop';

interface AudioIntent {
	generation: number;
	kind: AudioIntentKind;
}

export type AudioHostResult = OffscreenAudioResult;

const processors = new Map<number, AudioProcessor>();
const latestIntents = new Map<number, AudioIntent>();
const lastControlRevisions = new Map<number, number>();
const visualizerSubscriptions = new Set<number>();
const CAPTURE_GATE_SWITCH_LEAD_MS = 20;

function recordIntent(tabId: number, generation: number, kind: AudioIntentKind): AudioIntent {
	const current = latestIntents.get(tabId);
	if (!current || generation > current.generation) {
		const next = { generation, kind };
		latestIntents.set(tabId, next);
		return next;
	}
	if (generation === current.generation && kind === 'stop' && current.kind !== 'stop') {
		const next = { generation, kind };
		latestIntents.set(tabId, next);
		return next;
	}
	return current;
}

function isCurrentStartIntent(tabId: number, generation: number): boolean {
	const intent = latestIntents.get(tabId);
	return intent?.generation === generation && intent.kind === 'start';
}

function setImmediate(param: AudioParam, value: number, time: number): void {
	param.cancelScheduledValues(time);
	param.setValueAtTime(value, time);
}

function idleResult(tabId: number, generation: number, controlRevision: number): AudioHostResult {
	return {
		ok: true,
		tabId,
		generation,
		controlRevision,
		phase: 'idle',
		contextState: 'closed',
		graphSignature: 'none',
		normalizedActualConfig: null,
	};
}

function activeResult(processor: AudioProcessor): AudioHostResult {
	if (processor.ctx.state !== 'running') {
		return errorResult(
			processor.tabId,
			processor.generation,
			processor.controlRevision,
			`Capture AudioContext is ${processor.ctx.state}`,
			'capture_context_not_running',
		);
	}
	return {
		ok: true,
		tabId: processor.tabId,
		generation: processor.generation,
		controlRevision: processor.controlRevision,
		phase: 'active',
		contextState: 'running',
		graphSignature: processor.snapshot.graphSignature,
		normalizedActualConfig: processor.snapshot.normalizedActualConfig,
	};
}

function describeCurrentState(tabId: number, fallbackGeneration: number): AudioHostResult {
	const processor = processors.get(tabId);
	if (processor) return activeResult(processor);
	const generation = Math.max(fallbackGeneration, latestIntents.get(tabId)?.generation ?? 0);
	return idleResult(tabId, generation, lastControlRevisions.get(tabId) ?? 0);
}

function errorResult(
	tabId: number,
	generation: number,
	controlRevision: number,
	error: unknown,
	code = 'capture_start_failed',
): AudioHostResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		ok: false,
		tabId,
		generation,
		controlRevision,
		error: { code, message, retryable: true },
	};
}

function staleIntentResult(
	tabId: number,
	generation: number,
	controlRevision: number,
): AudioHostResult {
	return errorResult(
		tabId,
		generation,
		controlRevision,
		'Capture configuration belongs to a stopped generation',
		'stale_capture_intent',
	);
}

function ensureVisualizerSubscription(processor: AudioProcessor): void {
	if (!visualizerSubscriptions.has(processor.tabId) || processor.vizDisposer) return;
	processor.vizDisposer = processor.router.subscribeVisualizer();
}

function releaseVisualizerSubscription(processor: AudioProcessor): void {
	processor.vizDisposer?.();
	processor.vizDisposer = null;
	processor.lastVizFrame = null;
	processor.lastVizAt = 0;
}

function setVisualizerSubscriptions(tabIds: number[]): { subscribedTabIds: number[] } {
	visualizerSubscriptions.clear();
	for (const tabId of tabIds) visualizerSubscriptions.add(tabId);
	for (const processor of processors.values()) {
		if (visualizerSubscriptions.has(processor.tabId)) ensureVisualizerSubscription(processor);
		else releaseVisualizerSubscription(processor);
	}
	return { subscribedTabIds: [...visualizerSubscriptions].sort((left, right) => left - right) };
}

async function applyProcessorConfig(
	processor: AudioProcessor,
	config: AudioConfig,
	controlRevision: number,
): Promise<void> {
	if (controlRevision < processor.controlRevision) return;
	const snapshot = await processor.router.apply(audioConfigToGraphConfig(config), {
		requireRunning: true,
	});
	processor.controlRevision = controlRevision;
	processor.snapshot = snapshot;
	lastControlRevisions.set(processor.tabId, controlRevision);
}

async function disposeProcessor(processor: AudioProcessor): Promise<void> {
	if (processor.disposing) return;
	processor.disposing = true;
	if (processors.get(processor.tabId) === processor) processors.delete(processor.tabId);
	releaseVisualizerSubscription(processor);
	for (const dispose of processor.trackEndedDisposers) dispose();
	processor.trackEndedDisposers.length = 0;
	setImmediate(processor.commitGate.gain, 0, processor.ctx.currentTime);
	for (const track of processor.stream.getTracks()) track.stop();
	await processor.router.dispose(true);
	try { processor.source.disconnect(); } catch { /* already disconnected */ }
	try { processor.commitGate.disconnect(); } catch { /* already disconnected */ }
	try { await processor.ctx.close(); } catch { /* document teardown may have closed it */ }
}

function notifyProcessorEnded(processor: AudioProcessor): void {
	const runtime = typeof chrome === 'undefined' ? undefined : chrome.runtime;
	if (!runtime?.sendMessage) return;
	const event: OffscreenAudioEvent = {
		type: 'OFFSCREEN_AUDIO_ENDED',
		tabId: processor.tabId,
		generation: processor.generation,
	};
	void runtime.sendMessage(event).catch(() => undefined);
}

function observeTrackEnd(processor: AudioProcessor): void {
	for (const track of processor.stream.getTracks()) {
		if (typeof track.addEventListener !== 'function') continue;
		const handleEnded = () => {
			if (processor.disposing) return;
			const wasCurrent = processors.get(processor.tabId) === processor;
			recordIntent(processor.tabId, processor.generation, 'stop');
			void disposeProcessor(processor).finally(() => {
				if (wasCurrent) notifyProcessorEnded(processor);
			});
		};
		track.addEventListener('ended', handleEnded, { once: true });
		processor.trackEndedDisposers.push(() => track.removeEventListener('ended', handleEnded));
	}
}

async function startCapture(
	tabId: number,
	streamId: string,
	config: AudioConfig,
	generation: number,
	controlRevision: number,
): Promise<AudioHostResult> {
	const intent = recordIntent(tabId, generation, 'start');
	if (intent.generation !== generation || intent.kind !== 'start') {
		const current = processors.get(tabId);
		return current
			? activeResult(current)
			: staleIntentResult(tabId, intent.generation, controlRevision);
	}
	const existing = processors.get(tabId);
	if (existing) {
		if (existing.generation > generation) return activeResult(existing);
		if (existing.generation === generation) {
			await applyProcessorConfig(existing, config, controlRevision);
			return activeResult(existing);
		}
	}

	let stream: MediaStream | null = null;
	let ctx: AudioContext | null = null;
	let candidate: AudioProcessor | null = null;
	try {
		stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
			} as MediaTrackConstraints,
			video: false,
		});
		const audioTracks = stream.getAudioTracks();
		if (audioTracks.length === 0 || audioTracks.every((track) => track.readyState === 'ended')) {
			throw new Error('Tab capture returned no live audio track');
		}
		ctx = new AudioContext();
		const source = ctx.createMediaStreamSource(stream);
		const commitGate = ctx.createGain();
		setImmediate(commitGate.gain, 0, ctx.currentTime);
		commitGate.connect(ctx.destination);
		const graphRouter = new AudioGraphRouter(ctx, commitGate);
		graphRouter.connectSource(source);
		if (ctx.state === 'suspended') await ctx.resume();
		if (ctx.state !== 'running') throw new Error(`Capture AudioContext is ${ctx.state}`);
		const snapshot = await graphRouter.apply(audioConfigToGraphConfig(config), {
			requireRunning: true,
		});
		candidate = {
			tabId,
			generation,
			controlRevision,
			ctx,
			stream,
			source,
			commitGate,
			router: graphRouter,
			snapshot,
			vizDisposer: null,
			lastVizAt: 0,
			lastVizFrame: null,
			trackEndedDisposers: [],
			disposing: false,
		};
		observeTrackEnd(candidate);
		if (!isCurrentStartIntent(tabId, generation)) {
			await disposeProcessor(candidate);
			return describeCurrentState(tabId, generation);
		}

		const current = processors.get(tabId);
		if (current?.generation === generation) {
			await applyProcessorConfig(current, config, controlRevision);
			await disposeProcessor(candidate);
			return activeResult(current);
		}
		if (current && current.generation > generation) {
			await disposeProcessor(candidate);
			return activeResult(current);
		}

		// Candidate is connected and running before commit. Replacements schedule
		// both independent AudioContext gates for the same near-future wall-clock
		// boundary, avoiding a full-gain overlap without tearing down the stable
		// processor before the candidate is ready.
		if (current) {
			const leadSeconds = CAPTURE_GATE_SWITCH_LEAD_MS / 1_000;
			setImmediate(candidate.commitGate.gain, 0, candidate.ctx.currentTime);
			candidate.commitGate.gain.setValueAtTime(1, candidate.ctx.currentTime + leadSeconds);
			current.commitGate.gain.cancelScheduledValues(current.ctx.currentTime);
			current.commitGate.gain.setValueAtTime(0, current.ctx.currentTime + leadSeconds);
		} else {
			setImmediate(candidate.commitGate.gain, 1, candidate.ctx.currentTime);
		}
		processors.set(tabId, candidate);
		lastControlRevisions.set(tabId, controlRevision);
		ensureVisualizerSubscription(candidate);
		if (current) {
			await new Promise<void>((resolve) => setTimeout(
				resolve,
				CAPTURE_GATE_SWITCH_LEAD_MS + 5,
			));
			await disposeProcessor(current);
		}
		return activeResult(candidate);
	} catch (error) {
		if (candidate) await disposeProcessor(candidate);
		else {
			if (stream) for (const track of stream.getTracks()) track.stop();
			if (ctx) try { await ctx.close(); } catch { /* ignore */ }
		}
		return errorResult(tabId, generation, controlRevision, error);
	}
}

async function stopCapture(tabId: number, generation: number): Promise<AudioHostResult> {
	const intent = recordIntent(tabId, generation, 'stop');
	const processor = processors.get(tabId);
	if (!processor) return describeCurrentState(tabId, intent.generation);
	if (processor.generation > generation) return activeResult(processor);
	const controlRevision = processor.controlRevision;
	await disposeProcessor(processor);
	return idleResult(tabId, generation, controlRevision);
}

async function cancelPendingStart(
	tabId: number,
	generation: number,
	stopCommitted: boolean,
): Promise<AudioHostResult> {
	recordIntent(tabId, generation, 'stop');
	const processor = processors.get(tabId);
	if (stopCommitted && processor?.generation === generation) await disposeProcessor(processor);
	return describeCurrentState(tabId, generation);
}

function getVisualizerFrame(tabId: number): { buffer: number[] | null } {
	const processor = processors.get(tabId);
	if (!processor || !visualizerSubscriptions.has(tabId)) return { buffer: null };
	ensureVisualizerSubscription(processor);
	const now = performance.now();
	if (!processor.lastVizFrame || now - processor.lastVizAt >= 1_000 / 15) {
		const data = processor.router.getVisualizerData();
		processor.lastVizFrame = data ? Array.from(data) : null;
		processor.lastVizAt = now;
	}
	return { buffer: processor.lastVizFrame };
}

export function describeAudioHost(): AudioHostDescription[] {
	return [...processors.values()].map(({ tabId, generation, controlRevision, snapshot }) => ({
		tabId,
		generation,
		controlRevision,
		graphSignature: snapshot.graphSignature,
		normalizedActualConfig: {
			...snapshot.normalizedActualConfig,
			eqValues: [...snapshot.normalizedActualConfig.eqValues],
		},
	}));
}

export async function handleAudioHostMessage(
	message: OffscreenAudioRequest,
): Promise<OffscreenHostResponse<OffscreenAudioRequestType>> {
	switch (message.type) {
		case 'OFFSCREEN_AUDIO_START':
			return startCapture(
				message.tabId,
				message.streamId,
				message.config,
				message.generation,
				message.controlRevision ?? 0,
			);
		case 'OFFSCREEN_AUDIO_STOP':
			return stopCapture(message.tabId, message.generation);
		case 'OFFSCREEN_AUDIO_CANCEL_START':
			return cancelPendingStart(message.tabId, message.generation, message.stopCommitted);
		case 'OFFSCREEN_AUDIO_UPDATE': {
			const { tabId, generation, controlRevision: requestedControlRevision } = message;
			const controlRevision = requestedControlRevision ?? 0;
			const previousIntent = latestIntents.get(tabId);
			if (previousIntent?.kind === 'stop' && generation <= previousIntent.generation) {
				return staleIntentResult(tabId, previousIntent.generation, controlRevision);
			}
			if (!previousIntent || generation > previousIntent.generation) {
				recordIntent(tabId, generation, 'update');
			}
			const processor = processors.get(tabId);
			if (!processor) {
				return errorResult(
					tabId,
					generation,
					controlRevision,
					'Capture is not active',
					'capture_not_active',
				);
			}
			if (generation < processor.generation || controlRevision < processor.controlRevision) {
				return activeResult(processor);
			}
			processor.generation = generation;
			await applyProcessorConfig(processor, message.config, controlRevision);
			return activeResult(processor);
		}
		case 'OFFSCREEN_AUDIO_GET_VIZ':
			return getVisualizerFrame(message.tabId);
		case 'OFFSCREEN_AUDIO_GET_VIZ_BATCH': {
			const frames: Record<string, number[] | null> = {};
			for (const tabId of message.tabIds) frames[String(tabId)] = getVisualizerFrame(tabId).buffer;
			return { frames };
		}
		case 'OFFSCREEN_AUDIO_SET_VIZ_SUBSCRIPTIONS':
			return setVisualizerSubscriptions(message.tabIds);
	}
}

export async function destroyAudioHost(): Promise<void> {
	await Promise.all([...processors.values()].map(disposeProcessor));
	latestIntents.clear();
	lastControlRevisions.clear();
	visualizerSubscriptions.clear();
}
