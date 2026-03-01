// goal: service worker entry point for SPECTRA
console.log('[SPECTRA] [DEBUG] background.js execution started');
// note: coordinates message routing between popup, content script, offscreen, and remote services

import { router, storage } from './state';
import { registerAudioHandlers } from './handlers/audio';
import { registerSettingsHandlers } from './handlers/settings';
import { registerCaptureHandlers } from './handlers/capture';
import { registerBadgeHandlers } from './handlers/badge';
import { registerRegistryHandlers } from './handlers/registry';
import { registerTabStateHandlers } from './handlers/tab-state';
import { registerUserScriptsHandler } from './handlers/user-scripts';
import { setupShortcutListeners } from './shortcuts';
import { setupLifecycleListeners } from './lifecycle';
import { initRemoteService } from './remote-service';
import { performWarmUpdate } from './upgrade-manager';
import { swLog } from '../shared/logger';

// eff: initialize all functional modules and start message routing
registerAudioHandlers();
registerSettingsHandlers();
registerCaptureHandlers();
registerBadgeHandlers();
registerRegistryHandlers();
registerTabStateHandlers();
registerUserScriptsHandler();
initRemoteService();

setupShortcutListeners();
setupLifecycleListeners();

router.listen();

// eff: ensure core storage modules (registry, config) are initialized on fresh install
// note: performs zero-refresh update on existing tabs when extension is updated
chrome.runtime.onInstalled.addListener(async (details) => {
	if (details.reason === 'install') {
		await storage.registry.init();
		swLog.info('Installed: empty registry initialized, awaiting CORS-based population');
	} else if (details.reason === 'update') {
		swLog.info(`Updated from ${details.previousVersion} to ${chrome.runtime.getManifest().version}`);
		performWarmUpdate().catch(err => swLog.error('Warm update failed', err));
	}
});

swLog.info('Background Service Worker started.');
