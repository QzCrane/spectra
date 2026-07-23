// goal: shared, side-effect-free content-runtime capability and bootstrap state helpers

import type { ContentRuntimeSourceOwnership, SpectraRequestType } from '@nexus/contracts';

export interface ContentBootstrapState {
	bootstrapRevision: string;
	runtimeRevision: string | null;
	ready: boolean;
	disposeRuntime?: () => Promise<void>;
	getOwnedSources?: () => ContentRuntimeSourceOwnership[];
	dispose(): void;
}

interface ContentBootstrapWindow extends Window {
	__SPECTRA_CONTENT_BOOTSTRAP__?: ContentBootstrapState;
}

const runtimeRequiredTypes: ReadonlySet<SpectraRequestType> = new Set([
	'spectra.audio.runtime.configure',
	'spectra.control.intent.execute',
	'spectra.control.operation.execute',
	'spectra.control.actual.read',
	'spectra.hotkey.trigger',
	'spectra.media.play.toggle',
	'spectra.media.pip.toggle',
	'spectra.media.speed.set',
	'spectra.video.rotate',
	'spectra.video.mirror.toggle',
	'spectra.video.screenshot',
	'spectra.video.fullscreen.toggle',
	'spectra.video.crop.toggle',
	'spectra.video.seek',
	'spectra.video.filter.set',
	'spectra.video.filter.reset',
	'spectra.video.dim.toggle',
	'spectra.video.ab.a.set',
	'spectra.video.ab.b.set',
	'spectra.video.ab.clear',
	'spectra.video.marker.add',
	'spectra.video.marker.remove',
	'spectra.video.marker.jump',
]);

export function requiresContentRuntime(type: SpectraRequestType): boolean {
	return runtimeRequiredTypes.has(type);
}

export function getContentBootstrapState(): ContentBootstrapState | undefined {
	return (window as ContentBootstrapWindow).__SPECTRA_CONTENT_BOOTSTRAP__;
}

export function setContentBootstrapState(state: ContentBootstrapState | undefined): void {
	const host = window as ContentBootstrapWindow;
	if (state) host.__SPECTRA_CONTENT_BOOTSTRAP__ = state;
	else delete host.__SPECTRA_CONTENT_BOOTSTRAP__;
}

export function setContentRuntimeReady(runtimeRevision: string | null): void {
	const state = getContentBootstrapState();
	if (!state) return;
	state.runtimeRevision = runtimeRevision;
	state.ready = runtimeRevision !== null;
}

export function setContentRuntimeDisposer(disposer: (() => Promise<void>) | null): void {
	const state = getContentBootstrapState();
	if (!state) return;
	if (disposer) state.disposeRuntime = disposer;
	else delete state.disposeRuntime;
}

export function setContentRuntimeOwnershipProvider(
	provider: (() => ContentRuntimeSourceOwnership[]) | null,
): () => void {
	const state = getContentBootstrapState();
	if (!state) return () => undefined;
	if (provider) state.getOwnedSources = provider;
	else delete state.getOwnedSources;
	return () => {
		if (state.getOwnedSources === provider) delete state.getOwnedSources;
	};
}
