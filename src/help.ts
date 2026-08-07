import { Client, EmbedBuilder } from "discord.js";

const EMBED_COLOR = 0xea885f;

type HelpEmbedOptions = {
	guildId: string | null;
	organizerGuildId: string;
	communityGuildId: string;
	uptimeSeconds: number;
	serverCount: number;
};

function uptimeText(totalSeconds: number) {
	const uptime = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(uptime / 3600);
	const minutes = Math.floor((uptime % 3600) / 60);
	const seconds = uptime % 60;
	return `${hours}h ${minutes}m ${seconds}s`;
}

export function buildHelpEmbeds(options: HelpEmbedOptions) {
	const isOrganizer = options.guildId === options.organizerGuildId;
	const isCommunity = options.guildId === options.communityGuildId;
	const status = [
		{ name: "Uptime", value: uptimeText(options.uptimeSeconds), inline: true },
		{ name: "Servers", value: String(options.serverCount), inline: true },
	];

	const english = new EmbedBuilder()
		.setColor(EMBED_COLOR)
		.setTitle("Help")
		.setDescription("Track the Hack Discord commands. Commands shown below depend on this server.")
		.addFields(...status);
	const french = new EmbedBuilder()
		.setColor(EMBED_COLOR)
		.setTitle("Aide")
		.setDescription("Commandes Discord de Track the Hack. Les commandes ci-dessous dépendent de ce serveur.")
		.addFields(
			{ name: "Temps d’activité", value: uptimeText(options.uptimeSeconds), inline: true },
			{ name: "Serveurs", value: String(options.serverCount), inline: true },
		);

	if (isCommunity) {
		english.addFields({
			name: "Community",
			value: "`/verify` sends a private Track the Hack link used to receive the Hacker role after verification.",
		});
		french.addFields({
			name: "Communauté",
			value: "`/verify` envoie un lien privé Track the Hack permettant de recevoir le rôle Hacker après vérification.",
		});
	}

	if (isOrganizer) {
		english.addFields(
			{
				name: "Create and find tasks",
				value: [
					"`/task create` prepares a private preview before creating an OpenProject task. Project defaults come from the channel/category or an unambiguous owner team.",
					"Message → Apps → `Create OpenProject task` starts from one message. `Draft OpenProject task with AI` creates an editable proposal for review.",
					"`/task extract [message_count]` runs AI extraction on recent channel messages (20 by default, up to 50). It proposes tasks for review; it does not create them immediately.",
				].join("\n"),
			},
			{
				name: "Dates",
				value: "Use `YYYY-MM-DD`. Create uses configured start/due defaults when omitted. Start-date autocomplete includes past and future dates; due-date autocomplete includes today through the next 30 days. `/task reschedule` changes dates; enter `clear` to remove one.",
			},
			{
				name: "Manage tasks",
				value: "`/task view`, `assign`, `reschedule`, `close`, `reopen`, and `announce` manage an existing task. `metrics`, `link-user`, and `reconcile` are organizer maintenance commands.",
			},
			{
				name: "Other organizer commands",
				value: "`/schedule create|list|cancel` manages scheduled channel messages. `/sync` synchronizes organizer roles and nicknames to the community server.",
			},
		);
		french.addFields(
			{
				name: "Créer et trouver des tâches",
				value: [
					"`/task create` prépare un aperçu privé avant de créer une tâche OpenProject. Le projet par défaut vient du canal, de sa catégorie ou de l’équipe non ambiguë du responsable.",
					"Message → Applications → `Create OpenProject task` part d’un message. `Draft OpenProject task with AI` crée une proposition modifiable à réviser.",
					"`/task extract [message_count]` analyse les messages récents par IA (20 par défaut, jusqu’à 50). Les tâches sont proposées pour révision, sans création immédiate.",
				].join("\n"),
			},
			{
				name: "Dates",
				value: "Utilisez `AAAA-MM-JJ`. Les valeurs configurées sont utilisées si les dates sont omises. L’autocomplétion du début inclut le passé et le futur; celle de l’échéance couvre aujourd’hui et les 30 prochains jours. `/task reschedule` modifie les dates; `clear` en supprime une.",
			},
			{
				name: "Gérer les tâches",
				value: "`/task view`, `assign`, `reschedule`, `close`, `reopen` et `announce` gèrent une tâche existante. `metrics`, `link-user` et `reconcile` servent à la maintenance par les organisateurs.",
			},
			{
				name: "Autres commandes d’organisation",
				value: "`/schedule create|list|cancel` gère les messages planifiés. `/sync` synchronise les rôles et surnoms vers le serveur communautaire.",
			},
		);
	}

	english.addFields({ name: "Everywhere", value: "`/help` displays this private help message." });
	french.addFields({ name: "Partout", value: "`/help` affiche ce message d’aide privé." });
	return [english, french];
}

const registerHelpCommand = (client: Client) => {
	const organizerGuildId = process.env.ORGANIZER_GUILD_ID;
	const communityGuildId = process.env.COMMUNITY_GUILD_ID;
	if (!organizerGuildId || !communityGuildId) throw new Error("Missing environment variables for help");

	client.on("interactionCreate", async interaction => {
		if (!interaction.isCommand() || interaction.commandName !== "help") return;
		try {
			await interaction.deferReply({ ephemeral: true });
			await interaction.editReply({
				embeds: buildHelpEmbeds({
					guildId: interaction.guildId,
					organizerGuildId,
					communityGuildId,
					uptimeSeconds: (client.uptime ?? 0) / 1000,
					serverCount: client.guilds.cache.size,
				}),
			});
		} catch (error) {
			console.error("Error providing help information:", error);
			const content = "Could not provide help. Please try again later. | Impossible d’afficher l’aide. Veuillez réessayer plus tard.";
			try {
				if (interaction.replied || interaction.deferred) await interaction.editReply({ content, embeds: [] });
				else await interaction.reply({ content, ephemeral: true });
			} catch (replyError) {
				console.error("Failed to send help error message:", replyError);
			}
		}
	});
};

export default registerHelpCommand;
