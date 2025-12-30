// goal: manages the navigation and content visibility for different settings categories (e.g. general, site-specific)

// eff: binds click listeners to navigation buttons to toggle corresponding tab content areas
export function initTabs(): void {
	const navBtns = document.querySelectorAll<HTMLButtonElement>('.nav-btn');
	const tabContents = document.querySelectorAll<HTMLElement>('.tab-content');

	navBtns.forEach(btn => {
		btn.addEventListener('click', () => {
			const tabId = btn.dataset.tab;
			if (!tabId) return;

			navBtns.forEach(b => b.classList.remove('active'));
			btn.classList.add('active');

			tabContents.forEach(content => {
				content.classList.toggle('hidden', content.id !== `tab-${tabId}`);
			});
		});
	});
}
