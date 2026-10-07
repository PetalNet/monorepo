import { crc32 } from "node:zlib";

export interface ZipEntry {
	name: string;
	data: Uint8Array;
}

export async function* zip(entries: AsyncIterable<ZipEntry>) {
	const central: Buffer[] = [];
	let offset = 0;
	for await (const entry of entries) {
		const name = Buffer.from(entry.name),
			size = entry.data.length,
			crc = crc32(entry.data);
		const head = Buffer.alloc(30);
		head.writeUInt32LE(0x04034b50, 0);
		head.writeUInt16LE(20, 4);
		head.writeUInt16LE(0x800, 6);
		head.writeUInt16LE(33, 12);
		head.writeUInt32LE(crc, 14);
		head.writeUInt32LE(size, 18);
		head.writeUInt32LE(size, 22);
		head.writeUInt16LE(name.length, 26);
		const c = Buffer.alloc(46);
		c.writeUInt32LE(0x02014b50, 0);
		c.writeUInt16LE(20, 4);
		c.writeUInt16LE(20, 6);
		c.writeUInt16LE(0x800, 8);
		c.writeUInt16LE(33, 14);
		c.writeUInt32LE(crc, 16);
		c.writeUInt32LE(size, 20);
		c.writeUInt32LE(size, 24);
		c.writeUInt16LE(name.length, 28);
		c.writeUInt32LE(offset, 42);
		central.push(Buffer.concat([c, name]));
		offset += head.length + name.length + size;
		if (offset > 0xffffffff || central.length > 65535)
			throw new Error("Export exceeds ZIP32 limits");
		yield head;
		yield name;
		yield entry.data;
	}
	const size = central.reduce((n, c) => n + c.length, 0);
	for (const c of central) yield c;
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(central.length, 8);
	end.writeUInt16LE(central.length, 10);
	end.writeUInt32LE(size, 12);
	end.writeUInt32LE(offset, 16);
	yield end;
}
