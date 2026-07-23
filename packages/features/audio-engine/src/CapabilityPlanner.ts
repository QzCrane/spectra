// goal: select the least invasive complete strategy independently for each control field

import {
	CONTROL_ALGORITHM_POLICIES,
	CONTROL_ALGORITHM_ADJUDICATIONS,
	CONTROL_STRATEGY_RULES,
	shouldTryNextControlStrategy,
	type ControlAlgorithmPolicy,
	type ControlAugmentationAdmission,
	ControlCapability,
	ControlCoverage,
	ControlStrategy,
	type ControlStrategyFailure,
} from '@nexus/contracts';

export interface CapabilitySupport {
	write: boolean;
	readback: boolean;
	coverage: ControlCoverage;
}

export interface CapabilityPlannerContext {
	explicitIntent: boolean;
	requiredCoverage: 'active-target' | 'full';
	pageNative?: Partial<Record<ControlCapability, CapabilitySupport>>;
	domNative?: Partial<Record<ControlCapability, CapabilitySupport>>;
	chromeNative?: Partial<Record<ControlCapability, CapabilitySupport>>;
	extensionState?: Partial<Record<ControlCapability, CapabilitySupport>>;
	extensionCss?: Partial<Record<ControlCapability, CapabilitySupport>>;
	extensionOverlay?: Partial<Record<ControlCapability, CapabilitySupport>>;
	mediaWebAudio: {
		eligibility: 'proven' | 'unknown' | 'unsafe';
		fullCoverage: boolean;
		actualReadback: boolean;
	};
	capture: {
		available: boolean;
		authorized: boolean;
		activationAvailable: boolean;
		actualReadback: boolean;
	};
	activeProcessor: 'none' | 'media-webaudio' | 'capture';
}

export interface CapabilityPlan {
	field: ControlCapability;
	strategy: ControlStrategy;
	coverage: ControlCoverage;
	reason:
		| 'observe-only'
		| 'page-controller-complete'
		| 'dom-api-complete'
		| 'chrome-api-complete'
		| 'extension-state-complete'
		| 'extension-css-complete'
		| 'extension-overlay-complete'
		| 'safe-media-processing'
		| 'tab-capture-required'
		| 'existing-processor-observation'
		| 'boundary-blocked'
		| 'unsupported';
	terminalFailure?: ControlStrategyFailure;
}

export interface CapabilityAttempt {
	strategy: Exclude<ControlStrategy, 'observe' | 'unsupported'>;
	failure: ControlStrategyFailure;
}

function coverageSatisfies(actual: ControlCoverage, required: 'active-target' | 'full'): boolean {
	if (required === 'active-target') return actual === 'active-target' || actual === 'full';
	return actual === 'full' || actual === 'opaque';
}

function declaredSupport(
	strategy: ControlStrategy,
	field: ControlCapability,
	context: CapabilityPlannerContext,
): CapabilitySupport | undefined {
	switch (strategy) {
		case 'page-native': return context.pageNative?.[field];
		case 'dom-native': return context.domNative?.[field];
		case 'chrome-native': return context.chromeNative?.[field];
		case 'extension-state': return context.extensionState?.[field];
		case 'extension-css': return context.extensionCss?.[field];
		case 'extension-overlay': return context.extensionOverlay?.[field];
		default: return undefined;
	}
}

function usable(
	support: CapabilitySupport | undefined,
	requiredCoverage: 'active-target' | 'full',
	requiresActualReadback: boolean,
): support is CapabilitySupport {
	return support?.write === true
		&& (!requiresActualReadback || support.readback === true)
		&& coverageSatisfies(support.coverage, requiredCoverage);
}

function admitsCapture(admission: ControlAugmentationAdmission): boolean {
	return admission === 'explicit-full-output-only'
		|| admission === 'proven-safe-source-or-explicit-full-output';
}

function supportedPlan(
	field: ControlCapability,
	strategy: Extract<ControlStrategy,
		| 'page-native'
		| 'dom-native'
		| 'chrome-native'
		| 'extension-state'
		| 'extension-css'
		| 'extension-overlay'>,
	support: CapabilitySupport,
): CapabilityPlan {
	return {
		field,
		strategy,
		coverage: support.coverage,
		reason: strategy === 'page-native'
				? 'page-controller-complete'
				: strategy === 'dom-native'
					? 'dom-api-complete'
					: strategy === 'chrome-native'
						? 'chrome-api-complete'
						: strategy === 'extension-state'
							? 'extension-state-complete'
							: strategy === 'extension-css'
								? 'extension-css-complete'
								: 'extension-overlay-complete',
	};
}

export class CapabilityPlanner {
	public plan(
		field: ControlCapability,
		context: CapabilityPlannerContext,
		attempts: readonly CapabilityAttempt[] = [],
	): CapabilityPlan {
		if (!context.explicitIntent) {
			if (field === 'visualizer' && context.activeProcessor !== 'none') {
				return { field, strategy: 'observe', coverage: 'active-target', reason: 'existing-processor-observation' };
			}
			return { field, strategy: 'observe', coverage: 'active-target', reason: 'observe-only' };
		}

		const terminalAttempt = attempts.find((attempt) =>
			!shouldTryNextControlStrategy(attempt.failure));
		if (terminalAttempt) {
			return {
				field,
				strategy: 'unsupported',
				coverage: 'partial',
				reason: 'boundary-blocked',
				terminalFailure: terminalAttempt.failure,
			};
		}
		const attemptedStrategies = new Set(attempts.map((attempt) => attempt.strategy));

		const policy: ControlAlgorithmPolicy = CONTROL_ALGORITHM_POLICIES[field];
		const adjudication = CONTROL_ALGORITHM_ADJUDICATIONS[field];
		const augmentationAdmission: ControlAugmentationAdmission =
			adjudication.augmentationAdmission;
		for (const strategy of policy.orderedStrategies) {
			const rule = CONTROL_STRATEGY_RULES[strategy];
			if (rule.requiresExplicitIntent && !context.explicitIntent) continue;
			if (strategy !== 'observe' && attemptedStrategies.has(strategy)) continue;
			if (strategy === 'observe') {
				if (field === 'visualizer' && context.activeProcessor === 'none') continue;
				return {
					field,
					strategy: 'observe',
					coverage: field === 'visualizer' ? 'full' : 'active-target',
					reason: field === 'visualizer'
						? 'existing-processor-observation'
						: 'observe-only',
				};
			}
			if (strategy === 'media-webaudio') {
				if (augmentationAdmission !== 'proven-safe-source-or-explicit-full-output') {
					continue;
				}
				// The current document graph is a shared mix, not a selected-media
				// processor. Admitting it for an active-target request would silently
				// widen ownership even when every source is individually safe.
				if (context.requiredCoverage !== 'full') continue;
				if (context.mediaWebAudio.eligibility !== 'proven'
					|| !context.mediaWebAudio.actualReadback
					|| !context.mediaWebAudio.fullCoverage) continue;
				return {
					field,
					strategy,
					coverage: 'full',
					reason: 'safe-media-processing',
				};
			}
			if (strategy === 'capture') {
				const captureAdmitted = admitsCapture(augmentationAdmission);
				// Capture owns the whole tab output. It is never a target-level fallback,
				// because widening scope would break page/extension state equivalence.
				if (!captureAdmitted || context.requiredCoverage !== 'full') continue;
				if (!context.capture.available
					|| !context.capture.authorized
					|| !context.capture.activationAvailable
					|| !context.capture.actualReadback) continue;
				return { field, strategy, coverage: 'opaque', reason: 'tab-capture-required' };
			}
			if (rule.class === 'augmentation'
				&& augmentationAdmission === 'none') continue;
			const support = declaredSupport(strategy, field, context);
			if (usable(support, context.requiredCoverage, rule.requiresActualReadback)) {
				return supportedPlan(field, strategy, support);
			}
		}

		return { field, strategy: 'unsupported', coverage: 'partial', reason: 'unsupported' };
	}
}
