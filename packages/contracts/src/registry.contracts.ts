// goal: defines contracts for the restricted domain registry (CORS detection & user manual entries)

// auto-detected or user-added
export type DomainSource = 'user' | 'auto';

export interface DomainEntry {
	// domain: e.g. douyin.com
	domain: string;
	source: DomainSource;
	// probed: whether CORS detection has been performed
	probed: boolean;
	// restricted: true=CORS blocked, false=safe, undefined=not probed
	restricted?: boolean;
	// addedAt: timestamp for sorting/cleanup
	addedAt?: number;
}

// RegistryStorage: storage format handled by kernel
export type RegistryStorage = DomainEntry[] | string[];

export interface RegistryResult {
	success: boolean;
	reason?: string;
	entry?: DomainEntry;
}
