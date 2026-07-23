// goal: exposes the background-owned registry and hotkey target through validated v2 RPC

import {
	SPECTRA_PROTOCOL_VERSION,
	createSiteRouteFingerprint,
	isSpectraRequestEnvelope,
	rpcFailure,
	rpcSuccess,
} from '@nexus/contracts';
import { hotkeyTargetRepository } from '../hotkey-target-repository';
import { registryRepository } from '../registry-repository';
import { router } from '../state';

const REGISTRY_REQUEST_TYPES = new Set([
	'spectra.registry.get',
	'spectra.registry.add',
	'spectra.registry.remove',
	'spectra.registry.query',
	'spectra.registry.mark-probed',
	'spectra.hotkey-target.get',
	'spectra.hotkey-target.set',
]);

function isAttemptedRegistryV2Message(message: unknown): boolean {
	if (!message || typeof message !== 'object') return false;
	const candidate = message as { protocolVersion?: unknown; type?: unknown };
	return candidate.protocolVersion === SPECTRA_PROTOCOL_VERSION
		&& typeof candidate.type === 'string'
		&& REGISTRY_REQUEST_TYPES.has(candidate.type);
}

function registerV2RegistryListener(): void {
	chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
		if (!isAttemptedRegistryV2Message(message)) return false;
		if (sender.id && sender.id !== chrome.runtime.id) {
			sendResponse(rpcFailure('forbidden', 'Registry RPC is extension-internal only'));
			return false;
		}
		if (!isSpectraRequestEnvelope(message)
			|| !REGISTRY_REQUEST_TYPES.has(message.type)) {
			sendResponse(rpcFailure('invalid_request', 'Malformed SPECTRA v2 registry request'));
			return false;
		}

		const operation = async () => {
			if (message.type === 'spectra.registry.get') {
				return rpcSuccess(await registryRepository.getSnapshot());
			}
			if (message.type === 'spectra.registry.add') {
				return rpcSuccess(await registryRepository.add(
					message.payload.domain,
					'user',
					message.payload.route,
					{ force: message.payload.force === true },
				));
			}
			if (message.type === 'spectra.registry.remove') {
				return rpcSuccess(await registryRepository.remove(message.payload.fingerprint));
			}
			if (message.type === 'spectra.registry.query') {
				return rpcSuccess(await registryRepository.query(
					message.payload.domain,
					message.payload.fingerprint,
				));
			}
			if (message.type === 'spectra.registry.mark-probed') {
				return rpcSuccess(await registryRepository.markProbed(
					message.payload.domain,
					message.payload.fingerprint,
					message.payload.route,
					{ force: message.payload.force === true },
				));
			}
			if (message.type === 'spectra.hotkey-target.get') {
				return rpcSuccess(await hotkeyTargetRepository.get());
			}
			if (message.type === 'spectra.hotkey-target.set') {
				return rpcSuccess(await hotkeyTargetRepository.set(message.payload.tabId));
			}
			return rpcFailure('unsupported_request', 'No registry handler for this request');
		};

		void operation()
			.then(sendResponse)
			.catch((error) => sendResponse(rpcFailure(
				'registry_unavailable',
				error instanceof Error ? error.message : String(error),
				true,
			)));
		return true;
	});
}

// eff: keeps one-cycle v1 adapters while routing every mutation through the same queue as v2
export function registerRegistryHandlers(): void {
	registerV2RegistryListener();

	router.on('REGISTRY_ADD_DOMAIN', async (req) => {
		try {
			const result = await registryRepository.add(req.domain, 'auto', 'capture');
			return { success: true, reason: result.created ? undefined : 'updated' };
		} catch (error) {
			return { success: false, reason: error instanceof Error ? error.message : String(error) };
		}
	});

	router.on('REGISTRY_REMOVE_DOMAIN', async (req) => {
		try {
			const fingerprint = createSiteRouteFingerprint(req.domain);
			if (!fingerprint) return { success: false };
			const result = await registryRepository.remove(fingerprint);
			return { success: result.removed };
		} catch {
			return { success: false };
		}
	});

	router.on('REGISTRY_QUERY_DOMAIN', async (req) => {
		try {
			const fingerprint = createSiteRouteFingerprint(req.domain);
			return fingerprint
				? await registryRepository.query(req.domain, fingerprint)
				: { entry: null };
		} catch {
			return { entry: null };
		}
	});

	router.on('REGISTRY_MARK_PROBED', async (req) => {
		try {
			const fingerprint = createSiteRouteFingerprint(req.domain);
			if (!fingerprint) return { success: false, reason: 'invalid_domain' };
			const result = await registryRepository.markProbed(
				req.domain,
				fingerprint,
				req.restricted ? 'capture' : 'direct',
			);
			return { success: true, reason: result.created ? undefined : 'updated' };
		} catch (error) {
			return { success: false, reason: error instanceof Error ? error.message : String(error) };
		}
	});
}
