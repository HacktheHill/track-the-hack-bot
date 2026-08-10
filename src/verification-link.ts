import { createHmac } from "node:crypto";

export function verificationLink(baseUrl: string, secret: string, discordId: string, now = Date.now()) {
	const timestamp = String(Math.floor(now / 1_000));
	const signature = createHmac("sha256", secret).update(`verify:${timestamp}:${discordId}`).digest("hex");
	const url = new URL("discord", `${baseUrl.replace(/\/+$/, "")}/`);
	url.searchParams.set("id", discordId);
	url.searchParams.set("timestamp", timestamp);
	url.searchParams.set("signature", signature);
	return url.toString();
}
