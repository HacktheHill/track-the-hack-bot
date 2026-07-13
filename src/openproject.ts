import type { IntegrationConfig } from "./config.js";

type HalLink = { href: string; title?: string };
type Collection<T> = { _embedded: { elements: T[] } };

export type Project = { id: number; name: string; active: boolean; _links: Record<string, HalLink> };
export type OpenProjectUser = { id: number; name: string; login?: string; status?: string };
export type ProjectMembership = { id: number; _links: Record<string, HalLink> };
export type WorkPackage = {
	id: number;
	subject: string;
	lockVersion: number;
	startDate?: string | null;
	dueDate?: string | null;
	_links: Record<string, HalLink>;
};

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
	sourceLinks: string[];
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
	if (a === b || (Math.min(a.length, b.length) >= 12 && (a.includes(b) || b.includes(a)))) return true;
	const leftWords = new Set(a.split(" ").filter(word => word.length > 2));
	const rightWords = new Set(b.split(" ").filter(word => word.length > 2));
	const intersection = [...leftWords].filter(word => rightWords.has(word)).length;
	const union = new Set([...leftWords, ...rightWords]).size;
	return union > 0 && intersection >= 2 && intersection / union >= 0.6;
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
						...(init?.body ? { "Content-Type": "application/json" } : {}),
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

	private async cached<T>(key: string, loader: () => Promise<T>) {
		const cached = this.cache.get(key);
		if (cached && cached.expiresAt > Date.now()) return cached.value as T;
		const value = await loader();
		this.cache.set(key, { value, expiresAt: Date.now() + this.config.OPENPROJECT_CACHE_TTL_MS });
		return value;
	}

	invalidateCache() {
		this.cache.clear();
	}

	async projects() {
		return this.cached("projects", async () => {
			const data = await this.request<Collection<Project>>("/api/v3/projects?pageSize=100");
			return data._embedded.elements.filter(project => project.active);
		});
	}

	async priorities() {
		return this.cached("priorities", async () => (await this.request<Collection<{ id: number; name: string; isDefault: boolean }>>(
			"/api/v3/priorities?pageSize=100",
		))._embedded.elements);
	}

	async users() {
		return this.cached("users", async () => (await this.request<Collection<OpenProjectUser>>(
			"/api/v3/users?filters=%5B%7B%22status%22%3A%7B%22operator%22%3A%22%3D%22%2C%22values%22%3A%5B%22active%22%5D%7D%7D%5D&pageSize=200",
		))._embedded.elements);
	}

	async projectMemberships(projectId: number) {
		return this.cached(`memberships:${projectId}`, async () => (await this.request<Collection<ProjectMembership>>(
			`/api/v3/projects/${projectId}/memberships?pageSize=200`,
		))._embedded.elements);
	}

	async isProjectMember(projectId: number, userId: number) {
		const href = `/api/v3/users/${userId}`;
		return (await this.projectMemberships(projectId)).some(member => member._links.principal?.href === href);
	}

	async types() {
		return this.cached("types", async () => (await this.request<Collection<{ id: number; name: string }>>("/api/v3/types?pageSize=100"))._embedded.elements);
	}

	async statuses() {
		return this.cached("statuses", async () => (await this.request<Collection<{ id: number; name: string; isClosed: boolean; isDefault: boolean }>>(
			"/api/v3/statuses?pageSize=100",
		))._embedded.elements);
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
		const context = input.sourceLinks.length
			? `---\nDiscord context:\n${input.sourceLinks.map(link => `- ${link}`).join("\n")}`
			: "";
		const correlation = input.correlationId ? `<!-- track-the-hack-correlation:${input.correlationId} -->` : "";
		const description = [input.description.trim(), context, correlation].filter(Boolean).join("\n\n");
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
		return this.request<WorkPackage>(
			form._links?.commit?.href ?? `/api/v3/projects/${input.projectId}/work_packages`,
			{ method: "POST", body: JSON.stringify(commitPayload) },
		);
	}

	async workPackage(id: number) {
		return this.request<WorkPackage>(`/api/v3/work_packages/${id}`);
	}

	async updateWorkPackage(id: number, changes: Record<string, unknown>) {
		const current = await this.workPackage(id);
		return this.request<WorkPackage>(`/api/v3/work_packages/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ lockVersion: current.lockVersion, ...changes }),
		});
	}

	async possibleDuplicate(projectId: number, title: string) {
		const filters = encodeURIComponent(JSON.stringify([
			{ project: { operator: "=", values: [String(projectId)] } },
			{ status: { operator: "o", values: [] } },
		]));
		const packages = (await this.request<Collection<WorkPackage>>(
			`/api/v3/work_packages?filters=${filters}&pageSize=100&sortBy=${encodeURIComponent('[["updatedAt","desc"]]')}`,
		))._embedded.elements;
		return packages.find(item => titlesLikelyDuplicate(item.subject, title));
	}

	workPackageUrl(id: number) {
		return `${this.base}/work_packages/${id}`;
	}
}
