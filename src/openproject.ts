import type { IntegrationConfig } from "./config.js";

type HalLink = { href: string; title?: string };
type Collection<T> = { _embedded: { elements: T[] } };

export type Project = { id: number; name: string; active: boolean; _links: Record<string, HalLink> };
export type OpenProjectUser = { id: number; name: string; login?: string; status?: string };
export type WorkPackage = {
	id: number;
	subject: string;
	lockVersion: number;
	startDate?: string | null;
	dueDate?: string | null;
	_links: Record<string, HalLink>;
};
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
	storyPoints?: number;
	sourceLinks: string[];
	typeId?: number;
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

	constructor(private readonly config: IntegrationConfig) {
		this.base = config.OPENPROJECT_BASE_URL.replace(/\/$/, "");
		this.authorization = `Basic ${Buffer.from(`apikey:${config.OPENPROJECT_API_KEY}`).toString("base64")}`;
	}

	private async request<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await fetch(path.startsWith("http") ? path : `${this.base}${path}`, {
			...init,
			headers: {
				Authorization: this.authorization,
				Accept: "application/hal+json",
				...(init?.body ? { "Content-Type": "application/json" } : {}),
				...init?.headers,
			},
		});
		if (!response.ok) {
			const body = await response.text();
			throw new Error(`OpenProject ${response.status}: ${body.slice(0, 500)}`);
		}
		return (await response.json()) as T;
	}

	async projects() {
		const data = await this.request<Collection<Project>>("/api/v3/projects?pageSize=100");
		return data._embedded.elements.filter(project => project.active);
	}

	async priorities() {
		return (await this.request<Collection<{ id: number; name: string; isDefault: boolean }>>(
			"/api/v3/priorities?pageSize=100",
		))._embedded.elements;
	}

	async users() {
		return (await this.request<Collection<OpenProjectUser>>(
			"/api/v3/users?filters=%5B%7B%22status%22%3A%7B%22operator%22%3A%22%3D%22%2C%22values%22%3A%5B%22active%22%5D%7D%7D%5D&pageSize=200",
		))._embedded.elements;
	}

	async types() {
		return (await this.request<Collection<{ id: number; name: string }>>("/api/v3/types?pageSize=100"))._embedded.elements;
	}

	async statuses() {
		return (await this.request<Collection<{ id: number; name: string; isClosed: boolean; isDefault: boolean }>>(
			"/api/v3/statuses?pageSize=100",
		))._embedded.elements;
	}

	async sizeOptions(projectId: number) {
		const form = await this.request<{ _embedded: { schema: Record<string, { _embedded?: { allowedValues?: Array<{ id: number; value: string }> } }> } }>(
			`/api/v3/workspaces/${projectId}/work_packages/form`,
			{ method: "POST", body: "{}" },
		);
		return form._embedded.schema[this.config.OPENPROJECT_SIZE_CUSTOM_FIELD]?._embedded?.allowedValues ?? [];
	}

	async createWorkPackage(input: WorkPackageInput) {
		const context = input.sourceLinks.length
			? `\n\n---\nDiscord context:\n${input.sourceLinks.map(link => `- ${link}`).join("\n")}`
			: "";
		const payload: Record<string, unknown> = {
			subject: input.subject,
			description: { format: "markdown", raw: `${input.description}${context}` },
			_links: {
				project: { href: `/api/v3/projects/${input.projectId}` },
				type: { href: `/api/v3/types/${input.typeId ?? 1}` },
				status: { href: "/api/v3/statuses/1" },
				priority: { href: `/api/v3/priorities/${input.priorityId ?? 8}` },
				...(input.assigneeId ? { assignee: { href: `/api/v3/users/${input.assigneeId}` } } : {}),
				...(input.accountableId ? { responsible: { href: `/api/v3/users/${input.accountableId}` } } : {}),
			},
			...(input.startDate ? { startDate: input.startDate } : {}),
			...(input.dueDate ? { dueDate: input.dueDate } : {}),
			...(input.estimatedHours !== undefined ? { estimatedTime: `PT${input.estimatedHours}H` } : {}),
			...(input.storyPoints !== undefined ? { storyPoints: input.storyPoints } : {}),
			...(input.sizeHref ? { [this.config.OPENPROJECT_SIZE_CUSTOM_FIELD]: { href: input.sizeHref } } : {}),
		};
		const form = await this.request<{ _embedded: { validationErrors: Record<string, { message: string }> } }>(
			`/api/v3/workspaces/${input.projectId}/work_packages/form`,
			{ method: "POST", body: JSON.stringify(payload) },
		);
		const errors = Object.values(form._embedded.validationErrors ?? {}).map(error => error.message);
		if (errors.length) throw new Error(errors.join("; "));
		return this.request<WorkPackage>(
			`/api/v3/workspaces/${input.projectId}/work_packages`,
			{ method: "POST", body: JSON.stringify(payload) },
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
