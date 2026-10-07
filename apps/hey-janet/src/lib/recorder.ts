export interface Recording {
	wav: Blob;
	peak: number;
	clipped: boolean;
	duration: number;
}
export class Recorder {
	context: AudioContext | null = null;
	listeners = new AbortController();
	stream: MediaStream | null = null;
	node: AudioWorkletNode | null = null;
	chunks: Float32Array[] = [];
	active = false;
	started = 0;
	lastVoice = 0;
	timer = 0;
	constructor(
		private level: (v: number) => void,
		private ended: (r: Recording) => void,
		private interrupted: () => void,
	) {}
	async open() {
		this.context = new AudioContext();
		await this.context.resume();
		try {
			this.stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					channelCount: 1,
					echoCancellation: false,
					noiseSuppression: false,
					autoGainControl: false,
				},
			});
			await this.context.audioWorklet.addModule("/capture.js");
			this.node = new AudioWorkletNode(this.context, "capture");
			this.context.createMediaStreamSource(this.stream).connect(this.node);
			this.node.connect(this.context.destination);
			this.node.port.addEventListener(
				"message",
				(event: MessageEvent<Float32Array>) => {
					const data = event.data;
					let peak = 0;
					for (const v of data) peak = Math.max(peak, Math.abs(v));
					this.level(peak);
					if (this.active) {
						this.chunks.push(data);
						if (peak > 0.015) this.lastVoice = performance.now();
					}
				},
				{ signal: this.listeners.signal },
			);
			this.node.port.start();
			for (const track of this.stream.getTracks())
				track.addEventListener(
					"ended",
					() => {
						this.interrupted();
						this.close();
					},
					{ signal: this.listeners.signal },
				);
		} catch (e) {
			this.close();
			throw e;
		}
	}
	async start() {
		await this.context?.resume();
		this.chunks = [];
		this.active = true;
		this.started = performance.now();
		this.lastVoice = 0;
		this.timer = window.setInterval(() => {
			const now = performance.now();
			if (
				now - this.started >= 6500 ||
				(this.lastVoice > 0 && now - this.started > 1300 && now - this.lastVoice > 1100)
			)
				this.stop();
		}, 100);
	}
	stop() {
		if (!this.active) return;
		this.active = false;
		clearInterval(this.timer);
		const rate = this.context?.sampleRate ?? 48000;
		const length = this.chunks.reduce((n, c) => n + c.length, 0);
		const raw = new Float32Array(length);
		let at = 0;
		for (const chunk of this.chunks) {
			raw.set(chunk, at);
			at += chunk.length;
		}
		let start = 0,
			end = raw.length;
		while (start < end && Math.abs(raw[start]) < 0.008) start++;
		while (end > start && Math.abs(raw[end - 1]) < 0.008) end--;
		if (start === end) {
			start = 0;
			end = raw.length;
		}
		start = Math.max(0, start - Math.round(rate * 0.15));
		end = Math.min(raw.length, end + Math.round(rate * 0.25));
		const count = Math.max(3200, Math.ceil(((end - start) * 16000) / rate));
		const bytes = new ArrayBuffer(44 + count * 2),
			view = new DataView(bytes);
		const str = (offset: number, text: string) => {
			for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
		};
		str(0, "RIFF");
		view.setUint32(4, 36 + count * 2, true);
		str(8, "WAVEfmt ");
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, 1, true);
		view.setUint32(24, 16000, true);
		view.setUint32(28, 32000, true);
		view.setUint16(32, 2, true);
		view.setUint16(34, 16, true);
		str(36, "data");
		view.setUint32(40, count * 2, true);
		let peak = 0,
			clipped = 0;
		for (let i = 0; i < count; i++) {
			const from = start + (i * rate) / 16000,
				to = Math.min(end, from + rate / 16000);
			let sum = 0,
				weight = 0;
			for (let j = Math.floor(from); j < Math.ceil(to); j++) {
				const w = Math.max(0, Math.min(j + 1, to) - Math.max(j, from));
				sum += (raw[j] ?? 0) * w;
				weight += w;
			}
			const value = Math.max(-1, Math.min(1, weight ? sum / weight : 0));
			peak = Math.max(peak, Math.abs(value));
			if (Math.abs(value) >= 0.998) clipped++;
			view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
		}
		this.ended({
			wav: new Blob([bytes], { type: "audio/wav" }),
			peak,
			clipped: clipped / count > 0.005,
			duration: count / 16000,
		});
	}
	close() {
		this.listeners.abort();
		this.active = false;
		clearInterval(this.timer);
		this.node?.disconnect();
		for (const track of this.stream?.getTracks() ?? []) {
			track.stop();
		}
		void this.context?.close();
		this.context = null;
		this.stream = null;
		this.level(0);
	}
}
