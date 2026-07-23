// goal: shared serialized operation queue to prevent concurrent read-modify-write races

export interface SerializedQueue {
	<T>(operation: () => Promise<T>): Promise<T>;
	/** Resolves when all currently pending operations have settled. */
	drain(): Promise<void>;
}

export interface KeyedSerializedQueue<K> {
	<T>(key: K, operation: () => Promise<T>): Promise<T>;
	/** Resolves when all currently pending per-key operations have settled. */
	drain(): Promise<void>;
}

/**
 * Creates a single-key serialized queue. Each operation runs only after the
 * previous one completes (success or failure). The queue never rejects — a
 * failed operation does not block subsequent operations.
 */
export function createSerializedQueue(): SerializedQueue {
	let queue: Promise<void> = Promise.resolve();
	const serialized = function serialized<T>(operation: () => Promise<T>): Promise<T> {
		const previous = queue;
		const result = previous.then(operation, operation);
		queue = result.then(() => undefined, () => undefined);
		return result;
	} as SerializedQueue;
	serialized.drain = () => queue;
	return serialized;
}

/**
 * Creates a per-key serialized queue. Operations with different keys run
 * concurrently; operations with the same key run sequentially. Entries are
 * auto-deleted when the queue drains, so idle keys consume no memory.
 */
export function createKeyedSerializedQueue<K>(): KeyedSerializedQueue<K> {
	const queues = new Map<K, Promise<void>>();
	const serialized = function serialized<T>(key: K, operation: () => Promise<T>): Promise<T> {
		const previous = queues.get(key) ?? Promise.resolve();
		const result = previous.then(operation, operation);
		const tail = result.then(() => undefined, () => undefined);
		queues.set(key, tail);
		void tail.finally(() => {
			if (queues.get(key) === tail) queues.delete(key);
		});
		return result;
	} as KeyedSerializedQueue<K>;
	serialized.drain = () =>
		Promise.allSettled([...queues.values()]).then(() => undefined);
	return serialized;
}
