import { createHmac, randomUUID } from "node:crypto";

export type TeamFinderMember = {
	id: string; name: string; firstName: string; lastName: string; discordId: string | null;
};

export type TeamFinderTeam = {
	id: string; name: string; captainHackerId: string | null; members: TeamFinderMember[];
};

export type TeamFinderParty = {
	hacker: { id: string; name: string; discordId: string };
	team: TeamFinderTeam | null;
};

export type TeamFinderRequest = {
	id: string; listingDiscordThreadId: string; conversationDiscordThreadId: string;
	status: string; requesterRank: number | null; ownerRank: number | null;
};

export type Ranking = {
	id: string; conversationDiscordThreadId: string; label: string; rank: number | null; status: string;
};

type Action =
	| { action: "resolve"; actorDiscordId: string }
	| { action: "interest"; actorDiscordId: string; targetDiscordId: string; listingDiscordThreadId: string; conversationDiscordThreadId: string }
	| { action: "rank"; actorDiscordId: string; conversationDiscordThreadId: string; position: number }
	| { action: "list"; actorDiscordId: string; side: "requester" | "owner" }
	| { action: "offer" | "reject" | "decline"; actorDiscordId: string; conversationDiscordThreadId: string }
	| { action: "accept"; actorDiscordId: string; conversationDiscordThreadId: string; teamName?: string };

export class TeamFinderApiError extends Error {}

export class TeamFinderApi {
	readonly endpoint: string;

	constructor(
		baseUrl: string,
		private readonly secret: string,
		private readonly request: typeof fetch = fetch,
	) {
		this.endpoint = new URL("api/internal/team-operations", `${baseUrl.replace(/\/+$/, "")}/`).toString();
	}

	async execute<T>(action: Action): Promise<T> {
		const body = JSON.stringify(action);
		const timestamp = String(Math.floor(Date.now() / 1000));
		const requestId = randomUUID();
		const signature = createHmac("sha256", this.secret)
			.update(`${timestamp}.${requestId}.${body}`).digest("hex");
		const response = await this.request(this.endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-track-the-hack-timestamp": timestamp,
				"x-track-the-hack-request-id": requestId,
				"x-track-the-hack-signature": signature,
			},
			body,
		});
		const value = await response.json().catch(() => null) as { error?: unknown } | null;
		if (!response.ok) {
			const message = typeof value?.error === "string" ? value.error : `Track the Hack returned ${response.status}`;
			throw new TeamFinderApiError(message);
		}
		return value as T;
	}

	resolve(actorDiscordId: string) {
		return this.execute<TeamFinderParty>({ action: "resolve", actorDiscordId });
	}

	interest(actorDiscordId: string, targetDiscordId: string, listingDiscordThreadId: string, conversationDiscordThreadId: string) {
		return this.execute<TeamFinderRequest>({
			action: "interest", actorDiscordId, targetDiscordId, listingDiscordThreadId, conversationDiscordThreadId,
		});
	}

	rank(actorDiscordId: string, conversationDiscordThreadId: string, position: number) {
		return this.execute<{ rankings: { id: string; rank: number }[] }>({
			action: "rank", actorDiscordId, conversationDiscordThreadId, position,
		});
	}

	list(actorDiscordId: string, side: "requester" | "owner") {
		return this.execute<{ requests: Ranking[] }>({ action: "list", actorDiscordId, side });
	}

	decide(action: "offer" | "reject" | "decline", actorDiscordId: string, conversationDiscordThreadId: string) {
		return this.execute<TeamFinderRequest>({ action, actorDiscordId, conversationDiscordThreadId });
	}

	accept(actorDiscordId: string, conversationDiscordThreadId: string, teamName?: string) {
		return this.execute<{ requestId: string; status: string; team: TeamFinderTeam }>({
			action: "accept", actorDiscordId, conversationDiscordThreadId, ...(teamName ? { teamName } : {}),
		});
	}
}

export function linkedDiscordIds(party: TeamFinderParty) {
	return (party.team?.members ?? [{ discordId: party.hacker.discordId }])
		.flatMap(member => member.discordId ? [member.discordId] : []);
}

export function formatRankings(requester: Ranking[], owner: Ranking[]) {
	const section = (title: string, values: Ranking[]) => {
		const lines = values.map((item, index) =>
			`${item.rank ?? index + 1}. ${item.label} — ${item.status} — <#${item.conversationDiscordThreadId}>`);
		return `**${title}**\n${lines.length ? lines.join("\n") : "No open requests."}`;
	};
	return `${section("Your requester choices", requester)}\n\n${section("Your owner choices", owner)}`.slice(0, 2_000);
}
