// goal: discover an exact-media page controller and execute synchronous semantic read/write ACKs in MAIN

import {
	SPECTRA_PAGE_MEDIA_EVENT,
	SPECTRA_PAGE_MEDIA_FIELDS,
	SPECTRA_PAGE_MEDIA_REQUEST_ATTRIBUTE,
	SPECTRA_PAGE_MEDIA_RESULT_ATTRIBUTE,
	type SpectraPageMediaField,
	type SpectraPageMediaRequest,
	type SpectraPageMediaResult,
	type SpectraPageMediaValue,
} from '../../shared/page-media-bridge';

interface MainPageMediaWindow extends Window {
	__SPECTRA_PAGE_MEDIA_BRIDGE_V2__?: true;
}

interface PageMediaCapability {
	read(): SpectraPageMediaValue;
	write(value: SpectraPageMediaValue): void;
}

interface ControllerCandidate {
	controller: object;
	distance: number;
	association: 'ancestor' | 'media-reference' | 'root-reference';
}

const pageMediaFields = new Set<string>(SPECTRA_PAGE_MEDIA_FIELDS);
const MAX_ANCESTOR_DEPTH = 12;
const MAX_ATTACHED_PROPERTIES = 96;
const MAX_PROTOTYPE_DEPTH = 8;

function composedParent(element: Element): Element | null {
	if (element.parentElement) return element.parentElement;
	const root = element.getRootNode();
	return root instanceof ShadowRoot ? root.host : null;
}

function propertyDescriptor(target: object, key: PropertyKey): PropertyDescriptor | null {
	let current: object | null = target;
	for (let depth = 0; current && depth < MAX_PROTOTYPE_DEPTH; depth += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(current, key);
		if (descriptor) return descriptor;
		current = Object.getPrototypeOf(current) as object | null;
	}
	return null;
}

function dataProperty(target: object, key: PropertyKey): unknown {
	const descriptor = propertyDescriptor(target, key);
	return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function boundMethod(target: object, name: string): ((...args: unknown[]) => unknown) | null {
	const candidate = dataProperty(target, name);
	return typeof candidate === 'function'
		? (...args: unknown[]) => Reflect.apply(candidate, target, args)
		: null;
}

function accessorCapability(
	target: object,
	property: 'muted' | 'playbackRate',
): PageMediaCapability | null {
	const descriptor = propertyDescriptor(target, property);
	if (!descriptor?.get || !descriptor.set) return null;
	return {
		read: () => Reflect.apply(descriptor.get!, target, []),
		write: (value) => { Reflect.apply(descriptor.set!, target, [value]); },
	};
}

function finiteNumber(value: unknown, minimum: number, maximum: number, label: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${label} getter returned an invalid value`);
	}
	return value;
}

function booleanValue(value: unknown, label: string): boolean {
	if (typeof value !== 'boolean') throw new Error(`${label} getter returned an invalid value`);
	return value;
}

function playbackRatePropertyReader(target: object): (() => number) | null {
	const descriptor = propertyDescriptor(target, 'playbackRate');
	if (!descriptor
		|| (!descriptor.get && (!('value' in descriptor) || typeof descriptor.value !== 'number'))) {
		return null;
	}
	return () => finiteNumber(
		Reflect.get(target, 'playbackRate'),
		0.1,
		16,
		'Page playback rate',
	);
}

function capabilityFor(
	controller: object,
	field: SpectraPageMediaField,
): PageMediaCapability | null {
	if (field === 'volumeBase') {
		const getVolume = boundMethod(controller, 'getVolume');
		const setVolume = boundMethod(controller, 'setVolume');
		if (!getVolume || !setVolume) return null;
		return {
			read: () => finiteNumber(getVolume(), 0, 100, 'Page volume'),
			write: (value) => {
				setVolume(finiteNumber(value, 0, 100, 'Requested volume'));
			},
		};
	}
	if (field === 'mediaMuted') {
		const isMuted = boundMethod(controller, 'isMuted') ?? boundMethod(controller, 'getMuted');
		const setMuted = boundMethod(controller, 'setMuted');
		const mute = boundMethod(controller, 'mute');
		const unMute = boundMethod(controller, 'unMute') ?? boundMethod(controller, 'unmute');
		if (isMuted && (setMuted || mute && unMute)) {
			return {
				read: () => booleanValue(isMuted(), 'Page mute'),
				write: (value) => {
					const muted = booleanValue(value, 'Requested mute');
					if (setMuted) setMuted(muted);
					else if (muted) mute!();
					else unMute!();
				},
			};
		}
		const accessor = accessorCapability(controller, 'muted');
		return accessor && !(controller instanceof HTMLMediaElement) ? {
			read: () => booleanValue(accessor.read(), 'Page mute'),
			write: (value) => accessor.write(booleanValue(value, 'Requested mute')),
		} : null;
	}
	const getPlaybackRate = boundMethod(controller, 'getPlaybackRate');
	const readPlaybackRate = getPlaybackRate
		? () => finiteNumber(getPlaybackRate(), 0.1, 16, 'Page playback rate')
		: playbackRatePropertyReader(controller);
	const setPlaybackRate = boundMethod(controller, 'setPlaybackRate')
		?? boundMethod(controller, 'setPlaybackRateByUser')
		?? boundMethod(controller, 'changePlaybackRate');
	if (readPlaybackRate && setPlaybackRate) {
		return {
			read: readPlaybackRate,
			write: (value) => {
				setPlaybackRate(finiteNumber(value, 0.1, 16, 'Requested playback rate'));
			},
		};
	}
	const accessor = accessorCapability(controller, 'playbackRate');
	return accessor && !(controller instanceof HTMLMediaElement) ? {
		read: () => finiteNumber(accessor.read(), 0.1, 16, 'Page playback rate'),
		write: (value) => accessor.write(finiteNumber(value, 0.1, 16, 'Requested playback rate')),
	} : null;
}

function controllerAssociation(
	controller: object,
	element: HTMLMediaElement,
	host: Element,
): ControllerCandidate['association'] | null {
	for (const key of ['video', 'media', 'mediaElement', 'element']) {
		if (dataProperty(controller, key) === element) return 'media-reference';
	}
	for (const key of ['root', 'el', 'container']) {
		const root = dataProperty(controller, key);
		if (root instanceof Element && (root === host || root.contains(element))) return 'root-reference';
	}
	return null;
}

function collectControllerCandidates(element: HTMLMediaElement): ControllerCandidate[] {
	const candidates = new Map<object, ControllerCandidate>();
	let host = composedParent(element);
	for (let distance = 1; host && distance <= MAX_ANCESTOR_DEPTH; distance += 1) {
		candidates.set(host, { controller: host, distance, association: 'ancestor' });
		for (const key of Object.getOwnPropertyNames(host).slice(0, MAX_ATTACHED_PROPERTIES)) {
			const value = dataProperty(host, key);
			if ((!value || typeof value !== 'object') && typeof value !== 'function') continue;
			const controller = value as object;
			const association = controllerAssociation(controller, element, host);
			if (!association || candidates.has(controller)) continue;
			candidates.set(controller, { controller, distance, association });
		}
		host = composedParent(host);
	}
	return [...candidates.values()];
}

function capabilityCount(controller: object): number {
	return SPECTRA_PAGE_MEDIA_FIELDS.reduce(
		(count, field) => count + (capabilityFor(controller, field) ? 1 : 0),
		0,
	);
}

function associationRank(value: ControllerCandidate['association']): number {
	return value === 'media-reference' ? 2 : value === 'root-reference' ? 1 : 0;
}

function findCapability(
	element: HTMLMediaElement,
	field: SpectraPageMediaField,
): PageMediaCapability | null {
	const ranked = collectControllerCandidates(element)
		.map((candidate) => ({
			...candidate,
			capability: capabilityFor(candidate.controller, field),
			capabilityCount: capabilityCount(candidate.controller),
		}))
		.filter((candidate) => candidate.capability !== null)
		.sort((left, right) => {
			// Exact media/root ownership outranks feature count. Otherwise a broad
			// outer player with three generic methods could steal a field from the
			// explicitly associated controller of a nested media element.
			return associationRank(right.association) - associationRank(left.association)
				|| left.distance - right.distance
				|| right.capabilityCount - left.capabilityCount;
		});
	return ranked[0]?.capability ?? null;
}

function decodeRequest(element: HTMLMediaElement): SpectraPageMediaRequest | null {
	const encoded = element.getAttribute(SPECTRA_PAGE_MEDIA_REQUEST_ATTRIBUTE);
	if (!encoded) return null;
	try {
		const request = JSON.parse(encoded) as Partial<SpectraPageMediaRequest>;
		if (typeof request.requestId !== 'string' || request.requestId.length === 0
			|| (request.operation !== 'read' && request.operation !== 'write')
			|| typeof request.field !== 'string' || !pageMediaFields.has(request.field)) return null;
		if (request.operation === 'read') {
			return { requestId: request.requestId, operation: 'read', field: request.field as SpectraPageMediaField };
		}
		const valueValid = request.field === 'mediaMuted'
			? typeof request.value === 'boolean'
			: typeof request.value === 'number' && Number.isFinite(request.value);
		return valueValid ? request as SpectraPageMediaRequest : null;
	} catch {
		return null;
	}
}

function valuesMatch(field: SpectraPageMediaField, expected: SpectraPageMediaValue, actual: SpectraPageMediaValue): boolean {
	if (field === 'mediaMuted') return expected === actual;
	return typeof expected === 'number' && typeof actual === 'number'
		&& Math.abs(expected - actual) <= 0.005;
}

function onPageMediaRequest(event: Event): void {
	const element = event.target;
	if (!(element instanceof HTMLMediaElement)) return;
	const request = decodeRequest(element);
	if (!request) return;
	const capability = findCapability(element, request.field);
	if (!capability) {
		const unsupported: SpectraPageMediaResult = {
			requestId: request.requestId,
			field: request.field,
			supported: false,
			actual: null,
		};
		element.setAttribute(SPECTRA_PAGE_MEDIA_RESULT_ATTRIBUTE, JSON.stringify(unsupported));
		return;
	}

	let before: SpectraPageMediaValue | null = null;
	let result: SpectraPageMediaResult;
	try {
		before = capability.read();
		if (request.operation === 'write') {
			capability.write(request.value!);
		}
		const actual = capability.read();
		if (request.operation === 'write' && !valuesMatch(request.field, request.value!, actual)) {
			capability.write(before);
			const restored = capability.read();
			throw new Error(
				`Page ${request.field} readback mismatch; baseline ${valuesMatch(request.field, before, restored) ? 'restored' : 'restore failed'}`,
			);
		}
		result = {
			requestId: request.requestId,
			field: request.field,
			supported: true,
			actual,
		};
	} catch (error) {
		if (request.operation === 'write' && before !== null) {
			try {
				const current = capability.read();
				if (!valuesMatch(request.field, current, before)) capability.write(before);
			} catch {
				// The returned failure remains authoritative; executor ownership is not committed.
			}
		}
		result = {
			requestId: request.requestId,
			field: request.field,
			supported: true,
			actual: null,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	element.setAttribute(SPECTRA_PAGE_MEDIA_RESULT_ATTRIBUTE, JSON.stringify(result));
}

const mainWindow = window as MainPageMediaWindow;
if (!mainWindow.__SPECTRA_PAGE_MEDIA_BRIDGE_V2__) {
	mainWindow.__SPECTRA_PAGE_MEDIA_BRIDGE_V2__ = true;
	document.addEventListener(SPECTRA_PAGE_MEDIA_EVENT, onPageMediaRequest, true);
}
