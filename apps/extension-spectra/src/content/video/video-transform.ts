// goal: save a verified visible video crop through Chrome without image IPC

import type { MediaTarget, ScreenshotResult } from '@nexus/contracts';
import { sendSpectraRequest } from '../../shared/spectra-client';
import { getActiveMediaRegistry } from '../core/media-registry';

interface ScreenshotTargetProof {
	video: HTMLVideoElement;
	target: MediaTarget;
	rect: ScreenshotRect;
	expiresAt: number;
}

interface ScreenshotRect {
	x: number;
	y: number;
	width: number;
	height: number;
	viewportWidth: number;
	viewportHeight: number;
}

const pendingScreenshotTargets = new Map<string, ScreenshotTargetProof>();
const SCREENSHOT_TARGET_TTL_MS = 10_000;

function currentScreenshotRect(video: HTMLVideoElement): ScreenshotRect {
	const rect = video.getBoundingClientRect();
	const viewport = window.visualViewport;
	const viewportWidth = viewport?.width ?? document.documentElement.clientWidth;
	const viewportHeight = viewport?.height ?? document.documentElement.clientHeight;
	const offsetLeft = viewport?.offsetLeft ?? 0;
	const offsetTop = viewport?.offsetTop ?? 0;
	if (rect.width < 1 || rect.height < 1
		|| rect.left < offsetLeft
		|| rect.top < offsetTop
		|| rect.right > offsetLeft + viewportWidth
		|| rect.bottom > offsetTop + viewportHeight) {
		throw new Error('The complete active video must be visible before taking a screenshot');
	}
	return {
		x: rect.left - offsetLeft,
		y: rect.top - offsetTop,
		width: rect.width,
		height: rect.height,
		viewportWidth,
		viewportHeight,
	};
}

function sameScreenshotRect(left: ScreenshotRect, right: ScreenshotRect): boolean {
	return (Object.keys(left) as Array<keyof ScreenshotRect>)
		.every((key) => Math.abs(left[key] - right[key]) <= 0.5);
}

export function verifyScreenshotTarget(captureToken: string): boolean {
	const now = performance.now();
	for (const [token, proof] of pendingScreenshotTargets) {
		if (proof.expiresAt <= now) pendingScreenshotTargets.delete(token);
	}
	const proof = pendingScreenshotTargets.get(captureToken);
	if (!proof || proof.video.mediaKeys
		|| proof.video.videoWidth <= 0
		|| proof.video.videoHeight <= 0
		|| proof.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
		|| getActiveMediaRegistry()?.resolve(proof.target)?.element !== proof.video) return false;
	try {
		return sameScreenshotRect(currentScreenshotRect(proof.video), proof.rect);
	} catch {
		return false;
	}
}

async function captureVisible(
	video: HTMLVideoElement,
	target: MediaTarget,
	generation: number,
): Promise<ScreenshotResult> {
	if (video.mediaKeys) throw new Error('Protected media cannot be verified as a saved video frame');
	if (video.videoWidth <= 0 || video.videoHeight <= 0
		|| video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
		throw new Error('The active video has no current frame');
	}
	const rect = currentScreenshotRect(video);
	if (getActiveMediaRegistry()?.resolve(target)?.element !== video) {
		throw new Error('The active video source changed before screenshot capture');
	}
	const captureToken = crypto.randomUUID();
	pendingScreenshotTargets.set(captureToken, {
		video,
		target: { ...target },
		rect,
		expiresAt: performance.now() + SCREENSHOT_TARGET_TTL_MS,
	});
	try {
		const response = await sendSpectraRequest('spectra.screenshot.capture-visible', {
			captureToken,
			rect,
		}, { documentId: target.documentId, generation });
		if (!response.ok) throw new Error(response.error.message);
		return response.data;
	} finally {
		pendingScreenshotTargets.delete(captureToken);
	}
}

export async function takeScreenshot(
	target: MediaTarget | null,
	generation: number,
): Promise<ScreenshotResult> {
	const resolved = getActiveMediaRegistry()?.resolve(target) ?? null;
	if (!resolved || !(resolved.element instanceof HTMLVideoElement)) {
		throw new Error('No active video target');
	}
	return captureVisible(resolved.element, resolved.target, generation);
}
