// goal: typed client for background-owned registry and hotkey target state

import type {
	HotkeyTargetState,
	MediaRoute,
	RegistryAddResult,
	RegistryQueryResult,
	RegistryRemoveResult,
	RegistrySnapshot,
} from '@nexus/contracts';
import { sendSettingsUiRequest } from './ui-settings-spectra-client';

export async function getRegistrySnapshot(): Promise<RegistrySnapshot> {
	const response = await sendSettingsUiRequest('spectra.registry.get', {});
	if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
	return response.data;
}

export async function addRegistryDomain(domain: string, route: MediaRoute): Promise<RegistryAddResult> {
	const response = await sendSettingsUiRequest('spectra.registry.add', { domain, route });
	if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
	return response.data;
}

export async function removeRegistryDomain(fingerprint: string): Promise<RegistryRemoveResult> {
	const response = await sendSettingsUiRequest('spectra.registry.remove', { fingerprint });
	if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
	return response.data;
}

export async function queryRegistryDomain(
	domain: string,
	fingerprint: string,
): Promise<RegistryQueryResult> {
	const response = await sendSettingsUiRequest('spectra.registry.query', { domain, fingerprint });
	if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
	return response.data;
}

export async function markRegistryDomainProbed(
	domain: string,
	fingerprint: string,
	route: MediaRoute,
	options: { force?: boolean } = {},
): Promise<RegistryAddResult> {
	const response = await sendSettingsUiRequest('spectra.registry.mark-probed', {
		domain,
		fingerprint,
		route,
		...(options.force ? { force: true } : {}),
	});
	if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
	return response.data;
}

export async function getHotkeyTarget(): Promise<HotkeyTargetState> {
	const response = await sendSettingsUiRequest('spectra.hotkey-target.get', {});
	if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
	return response.data;
}

export async function setHotkeyTarget(tabId: number | null): Promise<HotkeyTargetState> {
	const response = await sendSettingsUiRequest('spectra.hotkey-target.set', { tabId });
	if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
	return response.data;
}
