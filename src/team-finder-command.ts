import { SlashCommandBuilder } from "discord.js";
import type { TeamFinderConfig } from "./config.js";

export const teamFinderCommand = new SlashCommandBuilder()
	.setName("team-find").setDescription("Find teammates and manage team requests.")
	.addSubcommand(command => command
		.setName("post")
		.setDescription("Create or change your public listing | Créer ou modifier votre annonce publique"))
	.addSubcommand(command => command
		.setName("dm")
		.setDescription("Create a private thread with the listing owner | Créer un fil privé avec l’auteur de l’annonce")
		.addStringOption(option => option.setName("listing")
			.setDescription("Paste the Discord link for the listing | Collez le lien Discord de l’annonce")
			.setRequired(true).setMinLength(17).setMaxLength(200)))
	.addSubcommand(command => command
		.setName("close")
		.setDescription("Close your public listing | Fermer votre annonce publique"))
	.addSubcommand(command => command
		.setName("rank").setDescription("Set this request's position in your ranking.")
		.addIntegerOption(option => option.setName("position")
			.setDescription("Set position 1 as your first choice.").setRequired(true).setMinValue(1)))
	.addSubcommand(command => command
		.setName("rankings").setDescription("Show your private requester and owner rankings."))
	.addSubcommand(command => command
		.setName("offer").setDescription("Send a team offer for this request."))
	.addSubcommand(command => command
		.setName("accept").setDescription("Accept the team offer for this request.")
		.addStringOption(option => option.setName("team_name")
			.setDescription("Set the team name when both parties are solo.").setMinLength(3).setMaxLength(50)))
	.addSubcommand(command => command
		.setName("reject").setDescription("Reject this team request."))
	.addSubcommand(command => command
		.setName("decline").setDescription("Decline the team offer for this request."));

export function teamFinderRegistration(config: TeamFinderConfig | null) {
	return {
		community: config ? [teamFinderCommand.toJSON()] : [],
		organizer: [],
		shared: [],
	};
}
