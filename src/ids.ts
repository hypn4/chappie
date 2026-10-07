import { randomBytes } from "node:crypto";

/** RFC 9562 section 5.7: Unix milliseconds and 74 independently random bits. */
export function uuidV7(now = Date.now()): string {
	if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff)
		throw new RangeError(
			"UUID v7 timestamp must fit unsigned 48-bit milliseconds",
		);
	const bytes = randomBytes(16);
	bytes.writeUIntBE(now, 0, 6);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
