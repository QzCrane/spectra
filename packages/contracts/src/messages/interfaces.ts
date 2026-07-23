// goal: defines messaging interfaces for both client (messenger) and server (router) roles

import type { NexusAction, NexusRequest, NexusResponse } from './definitions.js';

// goal: generic client for sending and receiving Nexus protocol messages
export interface INexusMessenger {
	send<A extends NexusAction>(
		action: A,
		...args: NexusRequest<A> extends void ? [] : [NexusRequest<A>]
	): Promise<NexusResponse<A>>;

	sendToTab<A extends NexusAction>(
		tabId: number,
		action: A,
		...args: NexusRequest<A> extends void ? [] : [NexusRequest<A>]
	): Promise<NexusResponse<A>>;

	on<A extends NexusAction>(
		action: A,
		handler: (req: NexusRequest<A>) => undefined | NexusResponse<A>
	): () => void;
}

// goal: central message dispatcher for background script
export interface INexusRouter {
	on<A extends NexusAction>(
		action: A,
		handler: (
			req: NexusRequest<A>,
			sender: chrome.runtime.MessageSender
		) => NexusResponse<A> | Promise<NexusResponse<A>>
	): this;

	// eff: begin listening to chrome.runtime.onMessage
	listen(): void;
	destroy(): void;
}
