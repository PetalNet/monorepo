const charset = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const cipher = "MPWZQVXLDTYSNHJCF A92E36BKR748U5".replaceAll(" ", "");
const toBase = (value: number, width: number) => {
	let result = "";

	do {
		result = charset[value % charset.length] + result;
		value = Math.floor(value / charset.length);
	} while (value > 0);

	return result.padStart(width, charset[0]);
};

const rotate = (value: number, rotation: number) =>
	((value << (rotation % 16)) | (value >>> (16 - (rotation % 16)))) & 0xffff;

export function encodeRelicId({
	typeId,
	varietyId,
	index,
}: {
	typeId: number;
	varietyId: number;
	index: number;
}) {
	const checksum = ((typeId * 31) ^ (varietyId * 37) ^ (index * 41)) & 0xffff;
	const rotation = checksum % 13;
	const parts = [
		toBase(rotate(typeId ^ 23, rotation), 4),
		toBase(rotate(varietyId ^ 40, rotation + 1), 4),
		toBase(rotate(index ^ 57, rotation + 2), 5),
		toBase(checksum ^ 74, 4),
	];
	let result = "";

	for (let i = 0; i < 5; i++) {
		for (const part of parts) {
			if (i < part.length) {
				result += part[i];
			}
		}
	}

	return result
		.split("")
		.map((c) => cipher[charset.indexOf(c)])
		.join("");
}
