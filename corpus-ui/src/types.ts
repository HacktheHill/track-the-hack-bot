export type ReviewStatus = "pending" | "included" | "excluded";
export type ExclusionReason = "missing_context" | "missing_attachment" | "broken_reference" | "ambiguous_ground_truth" | "sensitive_content" | "duplicate" | "malformed_capture" | "out_of_scope" | "other";
export type ProposalAction = "create" | "update" | "complete" | "reopen";
export type ContextRole = "primary" | "preceding" | "subsequent" | "thread_root" | "reply_target" | "referenced_history";

export interface CorpusMessage {
	id: string;
	authorAlias: string;
	text: string;
	timestamp: string;
	replyTo?: string;
	contextRole?: ContextRole;
	priority?: boolean;
	attachments?: Array<{ id: string; name: string; contentType?: string; url: string }>;
}

export interface ExpectedProposal {
	action: ProposalAction;
	titleIncludes: string[];
	sourceMessageIds: string[];
	projectName?: string | null;
	assigneeAlias?: string | null;
	dueDate?: string | null;
}

export interface CorpusCase {
	schemaVersion: "v2";
	id: string;
	origin: { type: "reviewed_proposal" | "sampled_no_task" | "manual_scenario"; reviewKind?: "incorrect_proposal"; reviewFingerprint?: string; [key: string]: unknown };
	window: {
		id: string;
		mode: "manual" | "automatic";
		messages: CorpusMessage[];
		metadata?: Record<string, unknown>;
		routing?: { availableTargetSourceMessageIds?: string[][]; [key: string]: unknown };
		expected: { proposals: ExpectedProposal[] };
	};
	reviewContext?: {
		discordMessages: Record<string, { guildId: string; channelId: string; messageId: string; url: string }>;
		reconstruction?: {
			recoveredAt: string;
			recoveredBy?: string;
			baseFingerprint?: string;
			addedMessageIds: string[];
		};
	};
	adjudication: {
		status: ReviewStatus;
		exclusionReasons: ExclusionReason[];
		notes: string;
		reviewedAt?: string;
		reviewedBy?: string;
	};
	createdAt: string;
	updatedAt: string;
}

export interface RecoveryPreview {
	case: CorpusCase;
	etag: string;
	addedMessageIds: string[];
	warnings: string[];
}

export interface CaseSummary {
	id: string;
	status?: ReviewStatus;
	originType?: string;
	reviewKind?: "incorrect_proposal";
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
	included?: number;
	excluded?: number;
	export?: { lastExportedAt?: string; includedCount?: number; filename?: string };
	lastExportedAt?: string;
	[key: string]: unknown;
}
