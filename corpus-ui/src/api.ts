import type { CaseSummary, CorpusCase, DashboardSummary, ReviewStatus } from "./types";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	const response = await fetch(path, {
		...init,
		headers: {
			"Content-Type": "application/json",
			...init.headers,
		},
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(detail || `${response.status} ${response.statusText}`);
	}
	if (response.status === 204) return undefined as T;
	return response.json() as Promise<T>;
}

export const corpusApi = {
	summary: () => request<DashboardSummary>("/api/summary"),
	list: (status: ReviewStatus | "all", query: string) => {
		const params = new URLSearchParams();
		if (status !== "all") params.set("status", status);
		if (query.trim()) params.set("query", query.trim());
		return request<{ cases: CaseSummary[] }>(`/api/cases?${params}`);
	},
	get: (id: string) => request<{ case: CorpusCase; etag: string }>(`/api/cases/${encodeURIComponent(id)}`),
	update: (id: string, value: CorpusCase, etag: string) => request<{ case: CorpusCase; etag: string }>(`/api/cases/${encodeURIComponent(id)}`, {
		method: "PUT",
		body: JSON.stringify({ case: value, etag }),
	}),
	create: (value: CorpusCase) => request<{ case: CorpusCase; etag: string }>("/api/cases", {
		method: "POST",
		body: JSON.stringify({ case: value }),
	}),
	exportApproved: () => request<{ filename?: string; count?: number; message?: string }>("/api/export", { method: "POST" }),
};
