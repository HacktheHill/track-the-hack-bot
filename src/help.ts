import { Client, EmbedBuilder } from "discord.js";
import { config } from "dotenv";

config();

const { ORGANIZER_GUILD_ID, COMMUNITY_GUILD_ID } = process.env;

if (!ORGANIZER_GUILD_ID || !COMMUNITY_GUILD_ID) {
	console.error("Missing environment variables for help");
	process.exit(1);
}

const registerHelpCommand = async (client: Client) => {
	client.on("interactionCreate", async interaction => {
		if (!interaction.isCommand()) return;

		const { commandName, guildId } = interaction;

		if (commandName === "help") {
			try {
				await interaction.deferReply({ ephemeral: true });

				const organizerGuild = await client.guilds.fetch(
					ORGANIZER_GUILD_ID,
				);
				const communityGuild = await client.guilds.fetch(
					COMMUNITY_GUILD_ID,
				);
				const permissions = {
					organizer: organizerGuild.members.me?.permissions.toArray(),
					community: communityGuild.members.me?.permissions.toArray(),
				};

				const uptime = Math.floor((client.uptime ?? 0) / 1000);
				const uptimeHours = Math.floor(uptime / 3600);
				const uptimeMinutes = Math.floor((uptime % 3600) / 60);
				const uptimeSeconds = uptime % 60;

				const embedColor = 0xea885f;
				const helpEmbeds = [
					{
						language: "en",
						title: "Help & Information",
						description: `
This bot helps manage and coordinate activities across Hack the Hill's Discord servers and integrates with the Track the Hack app.
                        `,
						baseFields: [
							{
								name: "Uptime",
								value: `${uptimeHours}h ${uptimeMinutes}m ${uptimeSeconds}s`,
								inline: true,
							},
							{
								name: "Servers",
								value: `${client.guilds.cache.size}`,
								inline: true,
							},
						],
						community: [
							{
								name: "Permissions",
								value:
									permissions.community?.join(", ") ??
									"Unknown",
								inline: false,
							},
							{
								name: "Commands",
								value: `
\`/verify\`: Get a verification link to verify your account in the community server.
- Users interact with the bot on Discord with \`/verify\` or the button in [this channel](https://discord.com/channels/1214618719507058739/1263275546633044032/126696769226342406).
- The bot sends a unique verification link (\`tracker.hackthehill.com/discord?id=<Discord User ID>\`).
- Users follow the link to the Track the Hack app, log in, and complete the verification process.
- The Track the Hack app checks the user's identity and sends a POST request to the bot's secure API endpoint with the user's Discord ID and a secret key.
- The bot verifies the request using the secret key to ensure it's from the Track the Hack app.
- Upon successful verification, the bot retrieves the user's information from Discord and assigns them the "Hacker" role in the server.
`,
								inline: false,
							},
						],
						organizer: [
							{
								name: "Permissions",
								value:
									permissions.organizer?.join(", ") ??
									"Unknown",
								inline: false,
							},
							{
								name: "OpenProject tasks",
								value: `
	Members can use task commands only in this Organizer server. \`/task create\` uses this channel category's project by default; title is required and description, people, priority, size, and dates are optional. Choose from the listed project, priority, and size values. Dates offer Today and the next 30 days as autocomplete suggestions (Discord has no native date picker).
	\`/task view|assign|reschedule|close|reopen|announce\`: Manage or re-post an existing task without opening OpenProject.
	Message → Apps → \`Create OpenProject task\`: Start a task from a message, choose a project/assignee, and include its backlink.
	Message → Apps → \`Draft OpenProject task with AI\`: Create an editable, private proposal in an AI-enabled channel; it never creates a task without review.
	\`/task configure-category\`, \`/task link-user\`, and \`/task reconcile\` are organizer-only setup/recovery commands.
`,
								inline: false,
							},
							{
								name: "Commands",
								value: `
\`/sync\`: Synchronize roles and nicknames from the organizer guild to the community guild.
- The bot fetches all members from the organizer guild.
- It then fetches all members from the community guild.
- For each member present in both guilds, the bot syncs their roles from the organizer guild to the community guild.
- The bot also updates their nickname in the community guild to match the nickname in the organizer guild.
`,
								inline: false,
							},
						],
						common: [
							{
								name: "Global Commands",
								value: `\`/help\`: Display this help message.`,
								inline: false,
							},
						],
					},
					{
						language: "fr",
						title: "Aide et informations",
						description: `
Ce bot aide à gérer et coordonner les activités sur les serveurs Discord de Hack the Hill et s'intègre avec l'application Track the Hack.
                        `,
						baseFields: [
							{
								name: "Temps d'activité",
								value: `${uptimeHours}h ${uptimeMinutes}m ${uptimeSeconds}s`,
								inline: true,
							},
							{
								name: "Serveurs",
								value: `${client.guilds.cache.size}`,
								inline: true,
							},
						],
						community: [
							{
								name: "Autorisations",
								value:
									permissions.community?.join(", ") ??
									"Inconnu",
								inline: false,
							},
							{
								name: "Commandes",
								value: `
\`/verify\`: Obtenez un lien de vérification pour vérifier votre compte sur le serveur communautaire.
- Les utilisateurs interagissent avec le bot sur Discord avec \`/verify\` ou le bouton dans [ce canal](https://discord.com/channels/1214618719507058739/1263275546633044032/126696769226342406).
- Le bot envoie un lien de vérification unique (\`tracker.hackthehill.com/discord?id=<ID Utilisateur Discord>\`).
- Les utilisateurs suivent le lien vers l'application Track the Hack, se connectent et complètent le processus de vérification.
- L'application Track the Hack vérifie l'identité de l'utilisateur et envoie une requête POST à l'API sécurisée du bot avec l'ID Discord de l'utilisateur et une clé secrète.
- Le bot vérifie la requête en utilisant la clé secrète pour s'assurer qu'elle provient de l'application Track the Hack.
- Après vérification réussie, le bot récupère les informations de l'utilisateur sur Discord et lui attribue le rôle "Hacker" sur le serveur.
`,
								inline: false,
							},
						],
						organizer: [
							{
								name: "Autorisations",
								value:
									permissions.organizer?.join(", ") ??
									"Inconnu",
								inline: false,
							},
							{
								name: "Tâches OpenProject",
								value: `
Les membres de ce serveur d'organisateurs peuvent utiliser les commandes de tâches. \`/task create\` utilise par défaut le projet associé à la catégorie du canal; le titre est requis et la description, les personnes, la priorité, la taille et les dates sont facultatives. Choisissez parmi les projets, priorités et tailles proposés. Les dates proposent aujourd'hui et les 30 prochains jours par autocomplétion (sans sélecteur de date natif).
	\`/task view|assign|reschedule|close|reopen|announce\`: Gère ou republie une tâche existante sans ouvrir OpenProject.
	Message → Applications → \`Create OpenProject task\`: Démarre une tâche à partir d'un message, permet de choisir le projet/l'assigné et ajoute son lien.
	Message → Applications → \`Draft OpenProject task with AI\`: Produit une proposition privée et modifiable dans un canal autorisé; aucune tâche n'est créée sans révision.
	\`/task configure-category\`, \`/task link-user\` et \`/task reconcile\` sont des commandes réservées aux organisateurs.
`,
								inline: false,
							},
							{
								name: "Commandes",
								value: `
\`/sync\`: Synchroniser les rôles et les surnoms du serveur des organisateurs avec le serveur communautaire.
- Le bot récupère tous les membres du serveur des organisateurs.
- Il récupère ensuite tous les membres du serveur communautaire.
- Pour chaque membre présent dans les deux serveurs, le bot synchronise leurs rôles du serveur des organisateurs avec le serveur communautaire.
- Le bot met également à jour leur surnom dans le serveur communautaire pour qu'il corresponde au surnom dans le serveur des organisateurs.
`,
								inline: false,
							},
						],
						common: [
							{
								name: "Commandes Globales",
								value: `\`/help\`: Affiche ce message d'aide.`,
								inline: false,
							},
						],
					},
				];

				await interaction.editReply({
					embeds: helpEmbeds.map(content => {
						const embed = new EmbedBuilder()
							.setColor(embedColor)
							.setTitle(content.title)
							.setDescription(content.description)
							.addFields(...content.baseFields);

						if (guildId === COMMUNITY_GUILD_ID) {
							embed.addFields(...content.community);
						} else if (guildId === ORGANIZER_GUILD_ID) {
							embed.addFields(...content.organizer);
						}
						embed.addFields(...content.common);
						return embed;
					}),
				});
			} catch (error) {
				console.error("Error providing help information:", error);
				try {
					const errorMessage =
						"An error occurred while providing help information. Please try again later. | Une erreur s'est produite lors de la fourniture des informations d'aide. Veuillez réessayer plus tard.";
					if (interaction.replied || interaction.deferred) {
						await interaction.editReply({
							content: errorMessage,
						});
					} else {
						await interaction.reply({
							content: errorMessage,
							ephemeral: true,
						});
					}
				} catch (editError) {
					console.error(
						"Failed to send error message to the user:",
						editError,
					);
				}
			}
		}
	});
};

export default registerHelpCommand;
