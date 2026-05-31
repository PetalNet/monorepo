import { subscribe, unsubscribe } from '$lib/server/events';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
	let controller: ReadableStreamDefaultController;

	const stream = new ReadableStream({
		start(c) {
			controller = c;
			subscribe(controller);
		},
		cancel() {
			unsubscribe(controller);
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
