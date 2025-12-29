// goal: type-safe storage repository providing unified access to split storage modules
// note: acts as a compatibility layer for audio config, settings, and domain registries

import {
  AudioConfig, DEFAULT_AUDIO_CONFIG,
  GlobalSettings, DEFAULT_GLOBAL_SETTINGS
} from '../messages/protocol.js';

import * as audioConfig from './audio-config.js';
import * as globalSettings from './global-settings.js';
import * as userRegistry from './user-registry.js';
import * as restrictedRegistry from './restricted-registry.js';

export class StorageRepository {
  // Audio config operations
  getAudioConfig = audioConfig.getAudioConfig;
  setAudioConfig = audioConfig.setAudioConfig;
  removeAudioConfig = audioConfig.removeAudioConfig;

  // Global settings operations
  getGlobalSettings = globalSettings.getGlobalSettings;
  setGlobalSettings = globalSettings.setGlobalSettings;

  // @deprecated: legacy user registry interfaces
  getUserRegistry = userRegistry.getUserRegistry;
  addToUserRegistry = userRegistry.addToUserRegistry;
  removeFromUserRegistry = userRegistry.removeFromUserRegistry;
  setUserRegistry = userRegistry.setUserRegistry;

  // Restricted domain registry (v3.0+)
  registry = {
    init: restrictedRegistry.initRegistry,
    get: restrictedRegistry.getRegistry,
    query: restrictedRegistry.queryDomain,
    isRestricted: restrictedRegistry.isRestricted,
    add: restrictedRegistry.addDomain,
    remove: restrictedRegistry.removeDomain,
    markProbed: restrictedRegistry.markProbed,
    getDomainList: restrictedRegistry.getDomainList,
    set: restrictedRegistry.setRegistry,
  };

  // eff: subscribes to 'local' storage area changes
  onChanged(callback: (changes: { [key: string]: chrome.storage.StorageChange }) => void): () => void {
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string
    ) => {
      if (areaName === 'local') callback(changes);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }
}

