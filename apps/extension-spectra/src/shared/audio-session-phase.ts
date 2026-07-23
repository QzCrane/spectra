// goal: reject same-generation phase regressions at every audio-state boundary

import type { AudioSessionPhase } from '@nexus/contracts';

const TRANSITIONAL_PHASES = new Set<AudioSessionPhase>(['starting', 'stopping']);

export function shouldAcceptAudioSessionPhase(
	currentGeneration: number,
	currentPhase: AudioSessionPhase,
	nextGeneration: number,
	nextPhase: AudioSessionPhase,
): boolean {
	if (nextGeneration !== currentGeneration) return nextGeneration > currentGeneration;
	if (nextPhase === currentPhase) return true;

	// A stable/error ACK is authoritative for its generation. A delayed intent
	// notification must never put the UI or persistence mirror back in flight.
	if (!TRANSITIONAL_PHASES.has(currentPhase) && TRANSITIONAL_PHASES.has(nextPhase)) {
		return false;
	}

	if (currentPhase === 'starting') {
		// A processor may stop or fail before reaching 'active'.
		return nextPhase === 'active' || nextPhase === 'idle' || nextPhase === 'error';
	}
	if (currentPhase === 'stopping') {
		// A user may re-enable audio before the processor finishes stopping.
		return nextPhase === 'idle' || nextPhase === 'active' || nextPhase === 'error';
	}

	// Stable phases (idle, active) must not jump directly to another stable
	// phase. They must go through a transitional phase (already gated above)
	// or report an error. Error retains its original same-generation behavior:
	// error→active/idle is allowed, while recovery to 'starting' requires a
	// new generation (accepted by the generation check above).
	if (currentPhase === 'idle' || currentPhase === 'active') {
		return nextPhase === 'error';
	}
	if (currentPhase === 'error') {
		return nextPhase === 'active' || nextPhase === 'idle';
	}
	return false;
}
