import type { IntegrationConfig } from "./config.js";
import { composeOpenProjectMarkdown } from "./task-proposals.js";

type HalLink = { href: string; title?: string };
type Collection<T> = { _embedded: { elements: T[] }; _links?: { next?: HalLink } };

export type Project = { id: number; name: string; active: boolean; _links: Record<string, HalLink> };
export type OpenProjectUser = { id: number; name: string; login?: string; status?: string; _type?: string };
export type ProjectMembership = { id: number; _links: Record<string, HalLink> };
export type WorkPackage = {
	[key: string]: unknown;
	id: number;
	subject: string;
	description?: { raw?: string } | string | null;
	project?: { id?: number } | null;
	lockVersion: number;
	startDate?: string | null;
	dueDate?: string | null;
	estimatedTime?: string | null;
	_links: Record<string, HalLink>;
};
export type Activity = { id: number; comment?: { raw?: string } | null; _links?: Record<string, HalLink> };
export type OpenProjectAttachmentInput = { id: string; name: string; contentType?: string; url: string };
type Attachment = { id: number; fileName: string };
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function openProjectAttachmentFileName(attachment: OpenProjectAttachmentInput) {
	const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+/, "") || "image";
	const extensionMatch = /(?:\.[a-zA-Z0-9]{1,10})$/.exec(safeName);
	const extension = extensionMatch?.[0] ?? "";
	const stem = safeName.slice(0, safeName.length - extension.length).slice(0, Math.max(1, 120 - attachment.id.length - extension.length - 1));
	return `${attachment.id}-${stem}${extension}`;
}

function detectedImageType(bytes: Uint8Array) {
	const startsWith = (...values: number[]) => values.every((value, index) => bytes[index] === value);
	if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
	if (startsWith(0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
	if (startsWith(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
	if (startsWith(0x42, 0x4d)) return "image/bmp";
	if (startsWith(0x49, 0x49, 0x2a, 0x00) || startsWith(0x4d, 0x4d, 0x00, 0x2a)) return "image/tiff";
	if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 12)).match(/^ftyp(?:avif|avis)$/)) return "image/avif";
	return undefined;
}

export class OpenProjectRequestError extends Error {
	constructor(message: string, readonly ambiguous = false) {
		super(message);
	}
}
export type WorkPackageInput = {
	projectId: number;
	subject: string;
	description: string;
	assigneeId?: number;
	accountableId?: number;
	priorityId?: number;
	sizeHref?: string;
	startDate?: string;
	dueDate?: string;
	estimatedHours?: number;
	attachments?: OpenProjectAttachmentInput[];
	typeId?: number;
	correlationId?: string;
};

export function normalizeTaskTitle(value: string) {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function titlesLikelyDuplicate(left: string, right: string) {
	const a = normalizeTaskTitle(left);
	const b = normalizeTaskTitle(right);
	if (!a || !b) return false;
	const identifiers = (value: string) => new Set(value.split(" ").filter(word => word.length <= 2 || /\d/.test(word)));
	const leftIdentifiers = identifiers(a);
	const rightIdentifiers = identifiers(b);
	if (leftIdentifiers.size !== rightIdentifiers.size || [...leftIdentifiers].some(word => !rightIdentifiers.has(word))) return false;
	if (a === b || (Math.min(a.length, b.length) >= 12 && (a.includes(b) || b.includes(a)))) return true;
	const stopWords = new Set(["and", "for", "the", "to", "with"]);
	const leftWords = new Set(a.split(" ").filter(word => word.length > 2 && !stopWords.has(word)));
	const rightWords = new Set(b.split(" ").filter(word => word.length > 2 && !stopWords.has(word)));
	const intersection = [...leftWords].filter(word => rightWords.has(word)).length;
	return intersection >= 2 && intersection / Math.min(leftWords.size, rightWords.size) >= 0.8;
}

export function workPackageMarkdownLink(id: number, subject: string, url: string) {
	const label = `#${id} ${subject}`.replace(/([\\\[\]])/g, "\\$1");
	return `[${label}](${url})`;
}

export function workPackageChangesApplied(workPackage: WorkPackage, changes: Record<string, unknown>) {
	return Object.entries(changes).every(([field, expected]) => {
		if (field === "_links") {
			return Object.entries(expected as Record<string, { href: string | null }>).every(([name, link]) =>
				(workPackage._links[name]?.href ?? null) === link.href);
		}
		if (field === "description") {
			const current = typeof workPackage.description === "string" ? workPackage.description : workPackage.description?.raw ?? "";
			return current === (expected as { raw?: string })?.raw;
		}
		if (expected && typeof expected === "object" && "href" in expected) {
			return ((workPackage[field] as { href?: string } | null)?.href ?? null) === (expected as { href?: string | null }).href;
		}
		return workPackage[field] === expected;
	});
}

export class OpenProjectClient {
	private readonly base: string;
	private readonly authorization: string;
	private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();

	constructor(private readonly config: IntegrationConfig) {
		this.base = config.OPENPROJECT_BASE_URL.replace(/\/$/, "");
		this.authorization = `Basic ${Buffer.from(`apikey:${config.OPENPROJECT_API_KEY}`).toString("base64")}`;
	}

	private async request<T>(path: string, init?: RequestInit): Promise<T> {
		const method = init?.method ?? "GET";
		const attempts = method === "GET" ? 3 : 1;
		for (let attempt = 0; attempt < attempts; attempt++) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), method === "GET" ? 10000 : 30000);
			try {
				const response = await fetch(path.startsWith("http") ? path : `${this.base}${path}`, {
					...init,
					signal: controller.signal,
					headers: {
						Authorization: this.authorization,
						Accept: "application/hal+json",
						...(init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
						...init?.headers,
					},
				});
				if (!response.ok) {
					const body = await response.text();
					if (method === "GET" && response.status >= 500 && attempt + 1 < attempts) continue;
					throw new OpenProjectRequestError(`OpenProject ${response.status}: ${body.slice(0, 500)}`);
				}
				return (await response.json()) as T;
			} catch (error) {
				if (error instanceof OpenProjectRequestError) throw error;
				if (method === "GET" && attempt + 1 < attempts) continue;
				throw new OpenProjectRequestError(
					`OpenProject ${method} failed: ${(error as Error).message}`,
					method !== "GET",
				);
			} finally {
				clearTimeout(timeout);
			}
		}
		throw new OpenProjectRequestError("OpenProject request failed.");
	}

	private attachmentFileName(attachment: OpenProjectAttachmentInput) {
		return openProjectAttachmentFileName(attachment);
	}

	private attachmentMarkdown(attachments: readonly OpenProjectAttachmentInput[]) {
		return attachments.map(attachment => ({ name: attachment.name, fileName: this.attachmentFileName(attachment) }));
	}

	private async uploadAttachments(containerPath: string, attachments: readonly OpenProjectAttachmentInput[]) {
		if (!attachments.length) return;
		const existing = await this.collection<Attachment>(`${containerPath}/attachments?pageSize=100`);
		const existingNames = new Set(existing.map(attachment => attachment.fileName));
		for (const attachment of attachments) {
			const fileName = this.attachmentFileName(attachment);
			if (existingNames.has(fileName)) continue;
			const sourceUrl = new URL(attachment.url);
			if (!new Set(["cdn.discordapp.com", "media.discordapp.net"]).has(sourceUrl.hostname)) {
				throw new OpenProjectRequestError(`Refusing to download an attachment from ${sourceUrl.hostname}.`);
			}
			const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) });
			if (!response.ok) throw new OpenProjectRequestError(`Discord attachment download failed with ${response.status}.`);
			const declaredSize = Number(response.headers.get("content-length"));
			if (Number.isFinite(declaredSize) && declaredSize > MAX_ATTACHMENT_BYTES) {
				throw new OpenProjectRequestError(`Discord image ${attachment.name} exceeds the 20 MiB upload limit.`);
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new OpenProjectRequestError(`Discord image ${attachment.name} exceeds the 20 MiB upload limit.`);
			const contentType = detectedImageType(bytes);
			if (!contentType) throw new OpenProjectRequestError(`Discord attachment ${attachment.name} is not a supported image.`);
			const form = new FormData();
			form.append("metadata", new Blob([JSON.stringify({ fileName })], { type: "application/json" }));
			form.append("file", new Blob([bytes], { type: contentType }), fileName);
			await this.request<Attachment>(`${containerPath}/attachments`, { method: "POST", body: form });
			existingNames.add(fileName);
		}
	}

	private async cached<T>(key: string, loader: () => Promise<T>) {
		const cached = this.cache.get(key);
		if (cached && cached.expiresAt > Date.now()) return cached.value as T;
		const value = await loader();
		this.cache.set(key, { value, expiresAt: Date.now() + this.config.OPENPROJECT_CACHE_TTL_MS });
		return value;
	}

	private async collection<T>(path: string) {
		const elements: T[] = [];
		let next: string | undefined = path;
		while (next) {
			const page: Collection<T> = await this.request<Collection<T>>(next);
			elements.push(...page._embedded.elements);
			next = page._links?.next?.href;
		}
		return elements;
	}

	invalidateCache() {
		this.cache.clear();
	}

	async projects() {
		return this.cached("projects", async () => {
			const projects = await this.collection<Project>("/api/v3/projects?pageSize=500");
			return projects.filter(project => project.active);
		});
	}

	async priorities() {
		return this.cached("priorities", async () => this.collection<{ id: number; name: string; isDefault: boolean }>(
			"/api/v3/priorities?pageSize=100",
		));
	}

	async users() {
		return this.cached("users", async () => {
			const projectIds = new Set([
				...Object.values(this.config.teamRoles ?? {}).map(mapping => mapping.projectId),
				...Object.values(this.config.categoryProjects ?? {}),
			]);
			const users = (await Promise.all([...projectIds].map(projectId => this.availableAssignees(projectId)))).flat();
			return [...new Map(users.filter(user => user._type === "User" || !user._type).map(user => [user.id, user])).values()];
		});
	}

	async linkableUsers() {
		return this.cached("linkable-users", async () => {
			const users = await this.collection<OpenProjectUser>("/api/v3/users?pageSize=500");
			return users
				.filter(user => (user._type === "User" || !user._type) && (!user.status || user.status === "active" || user.status === "invited"))
				.sort((left, right) => left.name.localeCompare(right.name));
		});
	}

	async availableAssignees(projectId: number) {
		return this.cached(`assignees:${projectId}`, async () => this.collection<OpenProjectUser>(
			`/api/v3/workspaces/${projectId}/available_assignees?pageSize=500`,
		));
	}

	async groupUserIds(groupId: number) {
		return this.cached(`group-users:${groupId}`, async () => {
			const filters = encodeURIComponent(JSON.stringify([{ group: { operator: "=", values: [String(groupId)] } }]));
			const memberships = await this.collection<ProjectMembership>(
				`/api/v3/memberships?filters=${filters}&pageSize=500`,
			);
			return [...new Set(memberships.flatMap(member => {
				const match = /^\/api\/v3\/users\/(\d+)$/.exec(member._links.principal?.href ?? "");
				return match ? [Number(match[1])] : [];
			}))];
		});
	}

	async projectMemberships(projectId: number) {
		const filters = encodeURIComponent(JSON.stringify([{ project: { operator: "=", values: [String(projectId)] } }]));
		return this.cached(`memberships:${projectId}`, async () => this.collection<ProjectMembership>(
			`/api/v3/memberships?filters=${filters}&pageSize=500`,
		));
	}

	async isProjectMember(projectId: number, userId: number) {
		const memberships = await this.projectMemberships(projectId);
		return memberships.some(membership => {
			const href = membership._links?.principal?.href ?? membership._links?.user?.href;
			return href === `/api/v3/users/${userId}` || membership.id === userId;
		});
	}

	async types() {
		return this.cached("types", async () => this.collection<{ id: number; name: string }>("/api/v3/types?pageSize=100"));
	}

	async statuses() {
		return this.cached("statuses", async () => this.collection<{ id: number; name: string; isClosed: boolean; isDefault: boolean }>(
			"/api/v3/statuses?pageSize=100",
		));
	}

	async sizeOptions(projectId: number) {
		return this.cached(`sizes:${projectId}`, async () => {
		const form = await this.request<{ _embedded: { schema: Record<string, { _embedded?: { allowedValues?: Array<{ id: number; value: string }> } }> } }>(
			`/api/v3/workspaces/${projectId}/work_packages/form`,
			{ method: "POST", body: "{}" },
		);
		return form._embedded.schema[this.config.OPENPROJECT_SIZE_CUSTOM_FIELD]?._embedded?.allowedValues ?? [];
		});
	}

	async createWorkPackage(input: WorkPackageInput) {
		const attachments = input.attachments ?? [];
		const description = composeOpenProjectMarkdown(
			input.description,
			input.correlationId ? `track-the-hack-correlation:${input.correlationId}` : undefined,
			this.attachmentMarkdown(attachments),
		);
		const payload: Record<string, unknown> = {
			subject: input.subject,
			description: { format: "markdown", raw: description },
			_links: {
				project: { href: `/api/v3/projects/${input.projectId}` },
				...(input.typeId ? { type: { href: `/api/v3/types/${input.typeId}` } } : {}),
				...(input.priorityId ? { priority: { href: `/api/v3/priorities/${input.priorityId}` } } : {}),
				...(input.assigneeId ? { assignee: { href: `/api/v3/users/${input.assigneeId}` } } : {}),
				...(input.accountableId ? { responsible: { href: `/api/v3/users/${input.accountableId}` } } : {}),
			},
			...(input.startDate ? { startDate: input.startDate } : {}),
			...(input.dueDate ? { dueDate: input.dueDate } : {}),
			...(input.estimatedHours !== undefined ? { estimatedTime: `PT${input.estimatedHours}H` } : {}),
			...(input.sizeHref ? { [this.config.OPENPROJECT_SIZE_CUSTOM_FIELD]: { href: input.sizeHref } } : {}),
		};
		const form = await this.request<{
			_embedded: { validationErrors: Record<string, { message: string }>; payload?: Record<string, unknown> };
			_links?: { commit?: HalLink };
		}>(
			`/api/v3/workspaces/${input.projectId}/work_packages/form`,
			{ method: "POST", body: JSON.stringify(payload) },
		);
		const errors = Object.values(form._embedded.validationErrors ?? {}).map(error => error.message);
		if (errors.length) throw new Error(errors.join("; "));
		const commitPayload = {
			...(form._embedded.payload ?? payload),
			...(input.sizeHref ? { [this.config.OPENPROJECT_SIZE_CUSTOM_FIELD]: { href: input.sizeHref } } : {}),
		};
		const workPackage = await this.request<WorkPackage>(
			form._links?.commit?.href ?? `/api/v3/projects/${input.projectId}/work_packages`,
			{ method: "POST", body: JSON.stringify(commitPayload) },
		);
		try {
			await this.uploadAttachments(`/api/v3/work_packages/${workPackage.id}`, attachments);
		} catch (error) {
			throw new OpenProjectRequestError(
				`OpenProject task ${workPackage.id} was created, but its images could not be uploaded: ${(error as Error).message}`,
				true,
			);
		}
		return workPackage;
	}

	async workPackage(id: number) {
		return this.request<WorkPackage>(`/api/v3/work_packages/${id}`);
	}

	async workPackages(projectId: number) {
		const filters = encodeURIComponent(JSON.stringify([
			{ project: { operator: "=", values: [String(projectId)] } },
			{ status: { operator: "o", values: [] } },
		]));
		return this.collection<WorkPackage>(
			`/api/v3/work_packages?filters=${filters}&pageSize=500&sortBy=${encodeURIComponent('[["updatedAt","desc"]]')}`,
		);
	}

	async updateWorkPackage(id: number, changes: Record<string, unknown>, expectedLockVersion?: number) {
		const current = await this.workPackage(id);
		if (expectedLockVersion !== undefined && current.lockVersion !== expectedLockVersion) {
			throw new OpenProjectRequestError(`OpenProject task ${id} changed since this proposal was created. Review it again before applying the update.`);
		}
		return this.request<WorkPackage>(`/api/v3/work_packages/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ ...changes, lockVersion: current.lockVersion }),
		});
	}

	async workPackageActivities(id: number) {
		return this.collection<Activity>(`/api/v3/work_packages/${id}/activities?pageSize=100`);
	}

	async attachWorkPackageImages(id: number, attachments: OpenProjectAttachmentInput[]) {
		await this.uploadAttachments(`/api/v3/work_packages/${id}`, attachments);
	}

	async commentWorkPackage(id: number, markdown: string, correlationId: string, attachments: OpenProjectAttachmentInput[] = []) {
		const marker = `track-the-hack-proposal:${correlationId}:comment`;
		const body = composeOpenProjectMarkdown(markdown, marker, this.attachmentMarkdown(attachments));
		const existing = (await this.workPackageActivities(id)).find(activity => activity.comment?.raw?.includes(`<!-- ${marker} -->`));
		if (existing) {
			await this.uploadAttachments(`/api/v3/activities/${existing.id}`, attachments);
			return existing;
		}
		try {
			const activity = await this.request<Activity>(`/api/v3/work_packages/${id}/activities`, {
				method: "POST",
				body: JSON.stringify({ comment: { raw: body } }),
			});
			await this.uploadAttachments(`/api/v3/activities/${activity.id}`, attachments);
			return activity;
		} catch (error) {
			if (!(error instanceof OpenProjectRequestError) || !error.ambiguous) throw error;
			const recovered = (await this.workPackageActivities(id)).find(activity => activity.comment?.raw?.includes(`<!-- ${marker} -->`));
			if (recovered) {
				await this.uploadAttachments(`/api/v3/activities/${recovered.id}`, attachments);
				return recovered;
			}
			throw error;
		}
	}

	async possibleDuplicate(projectId: number, title: string) {
		const filters = encodeURIComponent(JSON.stringify([
			{ project: { operator: "=", values: [String(projectId)] } },
			{ status: { operator: "o", values: [] } },
		]));
		const packages = await this.collection<WorkPackage>(
			`/api/v3/work_packages?filters=${filters}&pageSize=500&sortBy=${encodeURIComponent('[["updatedAt","desc"]]')}`,
		);
		return packages.find(item => titlesLikelyDuplicate(item.subject, title));
	}

	workPackageUrl(id: number) {
		return `${this.base}/work_packages/${id}`;
	}
}
