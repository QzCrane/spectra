// goal: handles messages for managing the restricted domain registry (add, remove, query, and CORS status updates)

import { router, storage } from '../state';

// eff: registers listeners for domain registry management actions
export function registerRegistryHandlers(): void {
	router.on('REGISTRY_ADD_DOMAIN', async (req) => {
		const result = await storage.registry.add(req.domain, 'auto', true);
		return { success: result.success, reason: result.reason };
	});

	router.on('REGISTRY_REMOVE_DOMAIN', async (req) => {
		const result = await storage.registry.remove(req.domain);
		return { success: result.success };
	});

	router.on('REGISTRY_QUERY_DOMAIN', async (req) => {
		const entry = await storage.registry.query(req.domain);
		return { entry };
	});

	router.on('REGISTRY_MARK_PROBED', async (req) => {
		const result = await storage.registry.markProbed(req.domain, req.restricted);
		return { success: result.success, reason: result.reason };
	});
}

