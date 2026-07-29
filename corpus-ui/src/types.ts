export type ReviewStatus = "pending" | "approved" | "rejected";
export type ProposalAction = "create" | "update" | "complete" | "reopen";
export type ContextRole = "primary" | "preceding" | "subsequent" | "thread_root" | "reply_target" | "referenced_history";

export interface CorpusMessage {
	id: string;
	authorAlias: string;
	text: string;
	timestamp: string;
	channelId?: string;
	replyTo?: string;
	contextRole?: ContextRole;
	priority?: boolean;
	attachments?: Array<{ id: string; name: string; contentType?: string; url: string }>;
}

export interface ExpectedProposal {
	action: ProposalAction;
	titleIncludes: string[];
	sourceMessageIds: string[];
	assigneeAlias?: string | null;
	dueDate?: string | null;
}

export interface CorpusCase {
	schemaVersion: "v1";
	id: string;
	origin: { type: "reviewed_proposal" | "sampled_no_task" | "manual_scenario"; [key: string]: unknown };
	window: {
		id: string;
		mode: "manual" | "automatic";
		messages: CorpusMessage[];
		metadata?: Record<string, unknown>;
		routing?: { availableTargetSourceMessageIds?: string[][]; [key: string]: unknown };
		expected: { proposals: ExpectedProposal[] };
	};
	adjudication: {
		status: ReviewStatus;
		notes: string;
		reviewedAt?: string;
		reviewedBy?: string;
	};
	createdAt: string;
	updatedAt: string;
}

export interface CaseSummary {
	id: string;
	status?: ReviewStatus;
	originType?: string;
	mode?: "manual" | "automatic";
	messageCount?: number;
	proposalCount?: number;
	updatedAt?: string;
	adjudication?: { status: ReviewStatus };
	origin?: { type: string };
	window?: { mode: "manual" | "automatic"; messages?: unknown[]; expected?: { proposals?: unknown[] } };
}

export interface DashboardSummary {
	counters?: Partial<Record<ReviewStatus | "total", number>>;
	total?: number;
	pending?: number;
	approved?: number;
	rejected?: number;
	export?: { lastExportedAt?: string; approvedCount?: number; filename?: string };
	lastExportedAt?: string;
	[key: string]: unknown;
}
