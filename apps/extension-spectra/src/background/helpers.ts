// goal: utility functions for background service worker operations

// post: returns true if the tab exists and is accessible
export async function isTabExists(tabId: number): Promise<boolean> {
	try {
		await chrome.tabs.get(tabId);
		return true;
	} catch {
		return false;
	}
}
