// goal: service worker entry point for SPECTRA
// note: coordinates message routing between popup, content script, offscreen, and remote services

import { router } from './state';
import { registerAudioHandlers } from './handlers/audio';
import { registerSettingsHandlers } from './handlers/settings';
import { registerCaptureHandlers } from './handlers/capture';
import { registerBadgeHandlers } from './handlers/badge';
import { registerRegistryHandlers } from './handlers/registry';
import { registerTabStateHandlers } from './handlers/tab-state';
import { registerUserScriptsHandler } from './handlers/user-scripts';
import { registerCommandHandlers } from './handlers/commands';
import { registerScreenshotHandler } from './handlers/screenshot';
import { setupShortcutListeners } from './shortcuts';
import { setupLifecycleListeners } from './lifecycle';
import { initRemoteService } from './remote-service';
import { performWarmUpdate } from './upgrade-manager';
import { swLog } from '../shared/logger';
import { registryRepository } from './registry-repository';
import {
	initializeOffscreenCoordinator,
	retireLegacyOffscreenDocument,
} from './offscreen-coordinator';
import { initializeContentRuntimeLoader } from './runtime-loader';
import { initializeMainRuntimeManager } from './main-runtime-manager';
import { initializeControlCoordinator } from './control-coordinator';

// eff: initialize all functional modules and start message routing
initializeOffscreenCoordinator();
initializeMainRuntimeManager();
initializeContentRuntimeLoader();
initializeControlCoordinator();
registerAudioHandlers();
registerSettingsHandlers();
registerCaptureHandlers();
registerBadgeHandlers();
registerRegistryHandlers();
registerTabStateHandlers();
registerUserScriptsHandler();
registerCommandHandlers();
registerScreenshotHandler();
initRemoteService();

setupShortcutListeners();
setupLifecycleListeners();

router.listen();

// eff: ensure core storage modules (registry, config) are initialized on fresh install
// note: performs zero-refresh update on existing tabs when extension is updated
chrome.runtime.onInstalled.addListener(async (details) => {
	if (details.reason === 'install') {
		await registryRepository.getSnapshot();
		swLog.info('Installed: empty registry initialized, awaiting CORS-based population');
	} else if (details.reason === 'update') {
		swLog.info(`Updated from ${details.previousVersion} to ${chrome.runtime.getManifest().version}`);
		try {
			// v1 used a six-character peer ID as the credential. Its in-memory
			// offscreen host is deliberately destroyed before any v2 warm refresh.
			await retireLegacyOffscreenDocument();
			await performWarmUpdate();
		} catch (error) {
			swLog.error('Warm update failed', error);
		}
	}
});

swLog.info('Background Service Worker started.');
