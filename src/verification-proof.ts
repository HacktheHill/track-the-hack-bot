import { createHmac, timingSafeEqual } from "node:crypto";

// Wire contract mirrored by track-the-hack-bot/src/verification-proof.ts.
// The reference is random; only the bot can resolve it to a Discord account.
export const DISCORD_LINK_TTL_SECONDS = 300;
const tokenPattern = /^v1\.([A-Za-z0-9_-]{43})\.([0-9]{10})\.([a-f0-9]{64})$/;

export const signDiscordLink = (reference: string, expires: number, secret: string) => {
	const payload = `v1.${reference}.${expires}`;
	return `${payload}.${createHmac("sha256", secret).update(`discord-link:${payload}`).digest("hex")}`;
};

export const readDiscordProof = (token: string, secret: string, now = Date.now()) => {
	const match = token.match(tokenPattern);
	if (!match) return null;
	const [, reference, expiresText, signature] = match;
	if (!reference || !expiresText || !signature) return null;
	const expires = Number(expiresText);
	const seconds = Math.floor(now / 1000);
	if (expires <= seconds || expires > seconds + DISCORD_LINK_TTL_SECONDS + 30) return null;
	const expected = signDiscordLink(reference, expires, secret).slice(-64);
	if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) return null;
	return { reference, expiresAt: new Date(expires * 1000) };
};

export const signDiscordRequest = (body: string, timestamp: string, secret: string) =>
	createHmac("sha256", secret).update(`discord-complete:v1:${timestamp}.${body}`).digest("hex");
