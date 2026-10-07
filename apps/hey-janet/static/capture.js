/* AudioWorklet keeps capture off the UI thread; outputs remain silent. */
class Capture extends AudioWorkletProcessor {
	/** @param {(Float32Array | undefined)[][]} inputs */
	process(inputs) {
		const channel = inputs[0]?.[0];
		if (channel) {
			const copy = channel.slice();
			this.port.postMessage(copy, [copy.buffer]);
		}
		return true;
	}
}
registerProcessor("capture", Capture);
