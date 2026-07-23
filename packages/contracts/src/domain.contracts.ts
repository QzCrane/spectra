// goal: canonical hostname handling shared by registries, settings, and runtime policy

const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function stripIpv6Brackets(hostname: string): string {
	return hostname.startsWith('[') && hostname.endsWith(']')
		? hostname.slice(1, -1)
		: hostname;
}

// post: returns a lowercase ASCII hostname without a trailing dot, or null for invalid input
// note: URL performs IDNA conversion so Unicode and punycode settings share one key
export function normalizeHostname(input: string): string | null {
	const value = input.trim();
	if (!value || /\s/.test(value) || value.includes('*')) return null;

	try {
		const looksLikeIpv6 = value.includes(':') && !value.includes('://') && !value.includes('/');
		const candidate = value.includes('://')
			? value
			: looksLikeIpv6
				? `http://[${value}]`
				: `http://${value}`;
		const url = new URL(candidate);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		if (url.username || url.password) return null;

		const hostname = stripIpv6Brackets(url.hostname)
			.toLowerCase()
			.replace(/\.+$/, '');
		return hostname || null;
	} catch {
		return null;
	}
}

export function isIpHostname(input: string): boolean {
	const hostname = normalizeHostname(input);
	if (!hostname) return false;
	if (hostname.includes(':')) return true;
	if (!IPV4_PATTERN.test(hostname)) return false;
	return hostname.split('.').every((part) => Number(part) <= 255);
}

// post: a rule matches only itself and true DNS subdomains; IP addresses are exact-only
export function hostnameMatchesRule(hostnameInput: string, ruleInput: string): boolean {
	const hostname = normalizeHostname(hostnameInput);
	const rule = normalizeHostname(ruleInput);
	if (!hostname || !rule) return false;
	if (hostname === rule) return true;
	if (isIpHostname(hostname) || isIpHostname(rule)) return false;
	return hostname.endsWith(`.${rule}`);
}

// post: returns the most-specific matching rule, independent of storage order
export function findBestHostnameMatch<T>(
	hostname: string,
	items: readonly T[],
	getDomain: (item: T) => string,
): T | null {
	let best: T | null = null;
	let bestLength = -1;
	for (const item of items) {
		const domain = normalizeHostname(getDomain(item));
		if (domain && domain.length > bestLength && hostnameMatchesRule(hostname, domain)) {
			best = item;
			bestLength = domain.length;
		}
	}
	return best;
}
