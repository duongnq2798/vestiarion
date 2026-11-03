import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far a delivery's signed time may be from now, as Vestiarion's own docs check it. */
export const TOLERANCE_SECONDS = 300;

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether `header`, a delivery's Vestiarion-Signature (`t=<unix seconds>,v1=<hex>`), is the HMAC-SHA256 of
 * `<t>.<raw body>` under `secret`, the endpoint's signing secret as Settings shows it, `whsec_` included. The body is
 * the bytes as they arrived: a parsed and re-serialised copy differs. Every v1 the header carries is tried, in constant
 * time, so a rotated secret's deliveries verify.
 */
export function checkSignature(secret: string, rawBody: string, header: string | undefined, nowMs: number): SignatureCheck {
	if (!header) return { ok: false, reason: 'The delivery has no Vestiarion-Signature header.' };
	let timestamp: string | undefined;
	const signatures: string[] = [];
	for (const part of header.split(',')) {
		const at = part.indexOf('=');
		if (at < 0) continue;
		const name = part.slice(0, at).trim();
		const value = part.slice(at + 1).trim();
		if (name === 't') timestamp = value;
		else if (name === 'v1') signatures.push(value);
	}
	if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) {
		return { ok: false, reason: 'The Vestiarion-Signature header is not t=<seconds>,v1=<hex>.' };
	}
	if (Math.abs(nowMs / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) {
		return { ok: false, reason: `The signature is more than ${TOLERANCE_SECONDS} seconds from now.` };
	}
	const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex'), 'utf8');
	for (const signature of signatures) {
		const given = Buffer.from(signature, 'utf8');
		if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
	}
	return { ok: false, reason: 'The signature does not match the body under this signing secret.' };
}
