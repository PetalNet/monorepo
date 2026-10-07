export function wavInfo(bytes: Uint8Array, maxSeconds = 8) {
	const b = Buffer.from(bytes);
	if (
		b.length < 44 ||
		b.length > 44 + maxSeconds * 32000 ||
		b.toString("ascii", 0, 4) !== "RIFF" ||
		b.readUInt32LE(4) !== b.length - 8 ||
		b.toString("ascii", 8, 16) !== "WAVEfmt " ||
		b.readUInt32LE(16) !== 16 ||
		b.readUInt16LE(20) !== 1 ||
		b.readUInt16LE(22) !== 1 ||
		b.readUInt32LE(24) !== 16000 ||
		b.readUInt32LE(28) !== 32000 ||
		b.readUInt16LE(32) !== 2 ||
		b.readUInt16LE(34) !== 16 ||
		b.toString("ascii", 36, 40) !== "data" ||
		b.readUInt32LE(40) !== b.length - 44 ||
		(b.length - 44) % 2
	)
		throw new Error(`Use a 16 kHz mono 16-bit PCM WAV, up to ${String(maxSeconds)} seconds.`);
	const duration = (b.length - 44) / 32000;
	if (duration < 0.2) throw new Error("Recording is too short.");
	let peak = 0,
		clipped = 0;
	for (let i = 44; i < b.length; i += 2) {
		const sample = Math.abs(b.readInt16LE(i));
		peak = Math.max(peak, sample);
		if (sample >= 32700) clipped++;
	}
	return {
		duration,
		peak,
		flags: [
			...(peak < 1500 ? ["too-quiet"] : []),
			...(clipped / ((b.length - 44) / 2) > 0.005 ? ["clipped"] : []),
		],
	};
}
