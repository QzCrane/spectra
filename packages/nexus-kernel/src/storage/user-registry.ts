// goal: legacy persistence for user-defined restricted domains using 'userRegistry' key
// note: @deprecated in favor of restricted-registry.ts structured storage

const KEY = 'userRegistry';

export async function getUserRegistry(): Promise<string[]> {
	const result = await chrome.storage.local.get(KEY);
	return result[KEY] || [];
}

export async function addToUserRegistry(domain: string): Promise<boolean> {
	const registry = await getUserRegistry();
	const exists = registry.some(d => domain.includes(d) || d.includes(domain));
	if (exists) return false;
	registry.push(domain);
	await chrome.storage.local.set({ [KEY]: registry });
	return true;
}

export async function removeFromUserRegistry(domain: string): Promise<boolean> {
	const registry = await getUserRegistry();
	const filtered = registry.filter(d => d !== domain);
	if (filtered.length === registry.length) return false;
	await chrome.storage.local.set({ [KEY]: filtered });
	return true;
}

export async function setUserRegistry(registry: string[]): Promise<void> {
	await chrome.storage.local.set({ [KEY]: registry });
}
