// goal: projects per-tab extension usage plus acknowledged audio state onto the Action badge
// rule: untouched page-native 0-100 observations stay hidden; every successful extension action is sticky until tab close

import { router, badgeState, BADGE_COLORS } from '../state';
import { isTabExists } from '../helpers';
import {
	audioSessionMatchesControlDocument,
	compileEffectiveVolume,
	isActiveCaptureLifecycle,
	resolveAudioVolumeState,
	type AudioSessionSnapshot,
	type ControlSessionPatch,
	type ControlSnapshot,
} from '@nexus/contracts';
import { hasBadgeUsage, markBadgeUsed } from '../badge-usage';

interface BadgeUpdate {
	volume: number;
	muted: boolean;
	enabled?: boolean;
	isCapture: boolean;
	userInteracted?: boolean;
}

type BadgeAuthority = 'control' | 'session' | 'legacy';
type BadgeIdentity = Pick<ControlSnapshot, 'documentId' | 'origin' | 'generation'>;

async function applyBadgeForTab(
	tabId: number,
	update: BadgeUpdate,
	authority: BadgeAuthority,
	identity: BadgeIdentity | null = null,
): Promise<void> {
	if (!await isTabExists(tabId)) {
		badgeState.delete(tabId);
		return;
	}

	const { volume, muted, isCapture, userInteracted } = update;
	if (!userInteracted) {
		badgeState.delete(tabId);
		try {
			await chrome.action.setBadgeText({ tabId, text: '' });
		} catch {
			return;
		}
		return;
	}

	let badgeText = '';
	const enabled = update.enabled ?? true;
	const volumeState = resolveAudioVolumeState({
		volume,
		muted,
		actualMode: isCapture ? 'capture' : 'bypass',
		phase: isCapture ? 'active' : 'idle',
	});
	let badgeColor: string = volumeState === 'capture'
		? BADGE_COLORS.CAPTURE
		: volumeState === 'silent'
			? BADGE_COLORS.MUTED
			: BADGE_COLORS.NATIVE;
	if (!enabled) {
		badgeText = volume.toString();
		badgeColor = '#94a3b8';
	} else if (volumeState === 'silent') {
		badgeText = 'M';
		badgeColor = BADGE_COLORS.MUTED;
	} else {
		badgeText = volume.toString();
	}

	badgeState.set(tabId, {
		volume,
		muted,
		enabled,
		isCapture,
		userInteracted: true,
		authority,
		text: badgeText,
		documentId: identity?.documentId ?? null,
		origin: identity?.origin ?? null,
		generation: identity?.generation ?? null,
	});
	try {
		await chrome.action.setBadgeText({ tabId, text: badgeText });
		await chrome.action.setBadgeBackgroundColor({ tabId, color: badgeColor });
		await chrome.action.setBadgeTextColor({ tabId, color: BADGE_COLORS.WHITE });
	} catch {
		badgeState.delete(tabId);
	}
}

async function resolveStickyUsage(tabId: number, userInteracted: boolean | undefined): Promise<boolean> {
	return userInteracted ? markBadgeUsed(tabId) : hasBadgeUsage(tabId);
}

// post: successful plugin use remains sticky without inventing presentation.
// Rendering starts only after a complete acknowledged volume projection exists.
export async function markBadgeUsedForTab(tabId: number): Promise<void> {
	await markBadgeUsed(tabId);
}

// Chrome may clear the visible per-tab Action projection on navigation even
// though the monotonic usage fact remains valid. Restore only an existing fact;
// this function never turns a passive page observation into extension usage.
export async function restoreBadgeUsageForTab(tabId: number): Promise<void> {
	if (await hasBadgeUsage(tabId)) await markBadgeUsedForTab(tabId);
}

export async function updateBadgeForTab(tabId: number, update: BadgeUpdate): Promise<void> {
	return applyBadgeForTab(tabId, {
		...update,
		userInteracted: await resolveStickyUsage(tabId, update.userInteracted),
	}, 'legacy');
}

export async function updateBadgeFromControlProjection(
	snapshot: Pick<ControlSnapshot, 'tabId' | 'documentId' | 'origin' | 'generation'>,
	projection: ControlSessionPatch,
	isCaptureActive: boolean,
	userInteracted: boolean,
): Promise<void> {
	const stickyInteraction = badgeState.get(snapshot.tabId)?.userInteracted === true
		|| await resolveStickyUsage(snapshot.tabId, userInteracted);
	if (typeof projection.volumeBase !== 'number' || typeof projection.boost !== 'number') {
		if (stickyInteraction) {
			await markBadgeUsedForTab(snapshot.tabId);
			return;
		}
		return applyBadgeForTab(snapshot.tabId, {
			volume: 0,
			muted: false,
			isCapture: false,
			userInteracted: false,
		}, 'control', snapshot);
	}
	return applyBadgeForTab(snapshot.tabId, {
		volume: compileEffectiveVolume(projection.volumeBase, projection.boost),
		muted: projection.mediaMuted === true,
		enabled: projection.audioEnabled ?? true,
		isCapture: isCaptureActive,
		userInteracted: stickyInteraction,
	}, 'control', snapshot);
}

export async function updateBadgeFromSession(
	snapshot: AudioSessionSnapshot,
	userInteracted: boolean,
): Promise<void> {
	const previous = badgeState.get(snapshot.tabId);
	const stickyInteraction = previous?.userInteracted === true
		|| await resolveStickyUsage(snapshot.tabId, userInteracted);
	const keepControlActual = previous?.authority === 'control'
		&& audioSessionMatchesControlDocument(snapshot, {
			tabId: snapshot.tabId,
			documentId: previous.documentId ?? '',
			origin: previous.origin ?? '',
		});
	// AudioSessionSnapshot owns lifecycle only. Without a matching actual control
	// projection, hiding the badge is safer than publishing stale volume/color.
	if (!keepControlActual) {
		badgeState.delete(snapshot.tabId);
		// Chrome retains the last per-tab Action projection across navigation and
		// worker suspension. Once this tab has used SPECTRA, do not erase that
		// truthful last ACK while the new document is still establishing its own
		// matching control projection; equally, do not invent a Capture color.
		if (stickyInteraction) return;
		// Badge rendering is a best-effort projection of acknowledged audio state.
		// A missing/unavailable Action API must never turn a successful processor
		// transition into a failed Capture operation.
		return chrome.action?.setBadgeText?.({ tabId: snapshot.tabId, text: '' })
			.catch(() => undefined) ?? Promise.resolve();
	}
	return applyBadgeForTab(snapshot.tabId, {
		volume: previous.volume,
		muted: previous.muted,
		enabled: previous.enabled,
		isCapture: isActiveCaptureLifecycle(snapshot),
		userInteracted: stickyInteraction,
	}, 'control', snapshot);
}

// eff: registers listeners for BADGE_UPDATE and BADGE_CLEAR actions
export function registerBadgeHandlers(): void {
	router.on('BADGE_UPDATE', async (req, sender) => {
		const tabId = req.tabId ?? sender.tab?.id;
		if (!tabId) return;
		await updateBadgeForTab(tabId, req);
	});

	router.on('BADGE_CLEAR', async (req, sender) => {
		const tabId = req.tabId ?? sender.tab?.id;
		if (!tabId) return;

		badgeState.delete(tabId);
		if (await hasBadgeUsage(tabId)) {
			await markBadgeUsedForTab(tabId);
			return;
		}
		await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
	});
}
