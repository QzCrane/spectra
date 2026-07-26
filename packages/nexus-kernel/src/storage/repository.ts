// goal: type-safe storage repository providing unified access to split storage modules
// note: exposes background-owned registry and acknowledged tab-session projections

import * as restrictedRegistry from './restricted-registry.js';
import * as tabSessionModule from './tab-session.js';

export class StorageRepository {
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

  // Acknowledged control session (resource observations + origin-portable intent, isolated per tab)
  tabSession = {
	identity: tabSessionModule.createTabControlSessionIdentity,
    get: tabSessionModule.getTabControlSession,
    merge: tabSessionModule.mergeTabControlSession,
	rebind: tabSessionModule.rebindTabControlSession,
    remove: tabSessionModule.removeTabControlSession,
	flush: tabSessionModule.flushTabControlSession,
    has: tabSessionModule.hasTabControlSession,
  };

  // eff: subscribes to 'local' storage area changes
  onChanged(callback: (changes: { [key: string]: chrome.storage.StorageChange }) => void): () => void {
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string
    ) => {
      if (areaName === 'local') callback(changes);
    };

    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener(listener);
      return () => chrome.storage.onChanged.removeListener(listener);
    }
    return () => { };
  }
}
