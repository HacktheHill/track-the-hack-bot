import type { CaseSummary, ReviewStatus } from "../types";

interface QueueProps {
	cases: CaseSummary[];
	activeId?: string;
	status: ReviewStatus | "all";
	query: string;
	loading: boolean;
	onStatus: (status: ReviewStatus | "all") => void;
	onQuery: (query: string) => void;
	onSelect: (id: string) => void;
}

const statuses: Array<ReviewStatus | "all"> = ["all", "pending", "included", "excluded"];

function summaryStatus(item: CaseSummary): ReviewStatus {
	return item.status ?? item.adjudication?.status ?? "pending";
}

export function Queue({ cases, activeId, status, query, loading, onStatus, onQuery, onSelect }: QueueProps) {
	return <aside className="queue" aria-label="Review queue">
		<div className="queue-heading">
			<div><p className="eyebrow">Review queue</p><h2>Cases</h2></div>
			<span className="count-badge" aria-label={`${cases.length} cases`}>{cases.length}</span>
		</div>
		<label className="field-label" htmlFor="case-search">Search cases</label>
		<input id="case-search" type="search" value={query} onChange={event => onQuery(event.target.value)} placeholder="ID, origin, or message" />
		<div className="status-tabs" aria-label="Filter cases by status">
			{statuses.map(value => <button key={value} type="button" className={status === value ? "active" : ""} aria-pressed={status === value} onClick={() => onStatus(value)}>{value}</button>)}
		</div>
		<div className="queue-list" aria-busy={loading}>
			{loading && !cases.length ? <p className="quiet">Loading the review queue…</p> : null}
			{!loading && !cases.length ? <div className="empty-small"><strong>No matching cases</strong><span>Try another status or search term.</span></div> : null}
			{cases.map(item => {
				const itemStatus = summaryStatus(item);
				const mode = item.mode ?? item.window?.mode;
				const origin = item.originType ?? item.origin?.type ?? "unknown origin";
				const messageCount = item.messageCount ?? item.window?.messages?.length;
				return <button type="button" className={`queue-item ${activeId === item.id ? "selected" : ""}`} key={item.id} onClick={() => onSelect(item.id)} aria-current={activeId === item.id ? "true" : undefined}>
					<span className="queue-item-top"><strong>{item.id}</strong><span className={`status-dot ${itemStatus}`}>{itemStatus}</span></span>
					<span className="queue-meta"><span>{origin}</span><span>{mode ?? "unassigned"}</span>{messageCount !== undefined ? <span>{messageCount} msg</span> : null}</span>
				</button>;
			})}
		</div>
	</aside>;
}
