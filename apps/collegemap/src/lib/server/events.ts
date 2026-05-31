const controllers = new Set<ReadableStreamDefaultController>();

export function subscribe(controller: ReadableStreamDefaultController) {
	controllers.add(controller);
}

export function unsubscribe(controller: ReadableStreamDefaultController) {
	controllers.delete(controller);
}

export function emit(event: string, data: unknown) {
	const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	for (const controller of controllers) {
		try {
			controller.enqueue(new TextEncoder().encode(payload));
		} catch {
			controllers.delete(controller);
		}
	}
}
