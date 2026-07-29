import { useEffect, useRef, useState } from "react";
import { corpusApi } from "./api";
import { CreateDialog } from "./components/CreateDialog";
import { ProposalEditor } from "./components/ProposalEditor";
import { Queue } from "./components/Queue";
import { Timeline } from "./components/Timeline";
import type { CaseSummary, CorpusCase, DashboardSummary, ReviewStatus } from "./types";

type Notice = { type: "error" | "success"; text: string } | null;

export default function App() {
	const [summary, setSummary] = useState<DashboardSummary>({});
	const [cases, setCases] = useState<CaseSummary[]>([]);
	const [status, setStatus] = useState<ReviewStatus | "all">("pending");
	const [query, setQuery] = useState("");
	const [selectedId, setSelectedId] = useState<string>();
	const [draft, setDraft] = useState<CorpusCase>();
	const [savedSnapshot, setSavedSnapshot] = useState("");
	const [etag, setEtag] = useState("");
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<Notice>(null);
	const [createOpen, setCreateOpen] = useState(false);
	const listRequest = useRef(0);
	const caseRequest = useRef(0);
	const caseHeading = useRef<HTMLHeadingElement>(null);
	const emptyHeading = useRef<HTMLHeadingElement>(null);
	const [invalidFields, setInvalidFields] = useState<string[]>([]);
	const dirty = Boolean(draft && JSON.stringify(draft) !== savedSnapshot);

	useEffect(() => {
		const timer = window.setTimeout(() => void loadList(), 200);
		return () => window.clearTimeout(timer);
	}, [status, query]);

	useEffect(() => { void refreshSummary(); }, []);
	useEffect(() => { if (draft) caseHeading.current?.focus(); }, [draft?.id]);
	useEffect(() => { if (!draft && !loading) emptyHeading.current?.focus(); }, [draft, loading]);
	useEffect(() => {
		const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);

	async function refreshSummary() {
		try { setSummary(await corpusApi.summary()); }
		catch (cause) { setNotice({ type: "error", text: errorText(cause, "Could not load dashboard counters.") }); }
	}

	async function loadList(preferredId?: string, replaceSelection = false) {
		const request = ++listRequest.current;
		try {
			setLoading(true);
			const result = await corpusApi.list(status, query);
			if (request !== listRequest.current) return;
			setCases(result.cases);
			const preferred = preferredId && result.cases.some(item => item.id === preferredId) ? preferredId : undefined;
			const nextId = preferred ?? (!replaceSelection && selectedId && result.cases.some(item => item.id === selectedId) ? selectedId : result.cases[0]?.id);
			if (nextId && (replaceSelection || nextId !== selectedId)) await selectCase(nextId, replaceSelection);
			else if (!nextId && (!dirty || replaceSelection)) { setSelectedId(undefined); setDraft(undefined); setSavedSnapshot(""); }
		} catch (cause) { setNotice({ type: "error", text: errorText(cause, "Could not load cases.") }); }
		finally { setLoading(false); }
	}

	async function selectCase(id: string, force = false) {
		if (!force && dirty && !window.confirm("Discard the unsaved changes to this case?")) return;
		const request = ++caseRequest.current;
		try {
			setBusy(true); setNotice(null);
			const result = await corpusApi.get(id);
			if (request !== caseRequest.current) return;
			setSelectedId(id); setDraft(result.case); setSavedSnapshot(JSON.stringify(result.case)); setEtag(result.etag);
			window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
		} catch (cause) { setNotice({ type: "error", text: errorText(cause, "Could not open this case.") }); }
		finally { setBusy(false); }
	}

	function validate(value: CorpusCase) {
		const errors: Array<{ text: string; field?: string }> = [];
		const focal = value.window.messages.filter(message => message.contextRole === "primary" || message.priority);
		const evidenceField = value.window.messages[0] ? `role-${value.window.messages[0].id}` : undefined;
		if (value.window.mode === "automatic" && focal.length !== 1) errors.push({ text: "Automatic cases require exactly one primary / focal message.", field: evidenceField });
		if (value.window.mode === "manual" && focal.length < 1) errors.push({ text: "Manual cases require at least one primary / focal message.", field: evidenceField });
		value.window.expected.proposals.forEach((proposal, index) => {
			if (!proposal.titleIncludes.length) errors.push({ text: `Proposal ${index + 1} needs at least one title term.`, field: `proposal-title-${index}` });
			if (!proposal.sourceMessageIds.length) errors.push({ text: `Proposal ${index + 1} needs at least one source message.`, field: `proposal-source-${index}` });
		});
		return errors;
	}

	async function saveCase(nextStatus?: ReviewStatus, moveNext = false) {
		if (!draft) return;
		const errors = validate(draft);
		if (errors.length) {
			setInvalidFields(errors.flatMap(error => error.field ? [error.field] : []));
			setNotice({ type: "error", text: errors.map(error => error.text).join(" ") });
			window.requestAnimationFrame(() => document.getElementById(errors.find(error => error.field)?.field ?? "")?.focus());
			return;
		}
		const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		const value: CorpusCase = { ...draft, adjudication: { ...draft.adjudication, status: nextStatus ?? "pending", ...(nextStatus && nextStatus !== "pending" ? { reviewedAt: new Date().toISOString() } : {}) }, updatedAt: new Date().toISOString() };
		const next = moveNext ? cases[cases.findIndex(item => item.id === value.id) + 1] ?? cases.find(item => item.id !== value.id) : undefined;
		try {
			setBusy(true); setNotice(null);
			const result = await corpusApi.update(value.id, value, etag);
			setInvalidFields([]);
			setDraft(result.case); setSavedSnapshot(JSON.stringify(result.case)); setEtag(result.etag);
			setNotice({ type: "success", text: nextStatus ? `Case marked ${nextStatus}.` : "Case saved." });
			await Promise.all([refreshSummary(), loadList(next?.id, moveNext)]);
		} catch (cause) { setNotice({ type: "error", text: errorText(cause, "Could not save. The case may have changed; reload before retrying.") }); }
		finally {
			setBusy(false);
			if (!moveNext) window.requestAnimationFrame(() => returnFocus?.isConnected && returnFocus.focus());
		}
	}

	async function createCase(value: CorpusCase) {
		const result = await corpusApi.create(value);
		setDraft(result.case); setSavedSnapshot(JSON.stringify(result.case)); setEtag(result.etag); setSelectedId(result.case.id);
		setNotice({ type: "success", text: "Scenario created and ready for review." });
		await Promise.all([refreshSummary(), loadList(result.case.id, true)]);
	}

	async function exportApproved() {
		if (dirty) { setNotice({ type: "error", text: "Save or discard the visible changes before exporting." }); return; }
		try {
			setBusy(true); setNotice(null);
			const result = await corpusApi.exportApproved();
			setNotice({ type: "success", text: result.message ?? `${result.count ?? "Approved"} cases exported${result.filename ? ` to ${result.filename}` : ""}.` });
			await refreshSummary();
		} catch (cause) { setNotice({ type: "error", text: errorText(cause, "Export failed.") }); }
		finally { setBusy(false); }
	}

	const counts = {
		total: summary.counters?.total ?? summary.total ?? 0,
		pending: summary.counters?.pending ?? summary.pending ?? 0,
		approved: summary.counters?.approved ?? summary.approved ?? 0,
		rejected: summary.counters?.rejected ?? summary.rejected ?? 0,
	};
	const exportDate = summary.export?.lastExportedAt ?? summary.lastExportedAt;

	return <div className="app-shell">
		<a className="skip-link" href="#review-workspace">Skip to review workspace</a>
		<header className="topbar">
			<div className="brand"><img src="/hth-mark.svg" alt="Hack the Hill" /><span></span><div><strong>Corpus desk</strong><small>Internal review workspace</small></div></div>
			<div className="top-actions"><button type="button" className="secondary" disabled={busy} onClick={() => { if (!dirty || window.confirm("Discard the unsaved changes and create a scenario?")) setCreateOpen(true); }}>+ Create scenario</button><button type="button" className="primary" onClick={exportApproved} disabled={busy}>Export approved</button></div>
		</header>
		<main>
			<section className="dashboard" aria-labelledby="page-title">
				<div><p className="eyebrow">Evaluation corpus</p><h1 id="page-title">Review desk</h1><p>Shape reliable examples from real, pseudonymized event conversations.</p></div>
				<div className="metrics" aria-label="Corpus counters">{(["total", "pending", "approved", "rejected"] as const).map(key => <div className={`metric ${key}`} key={key}><strong>{counts[key]}</strong><span>{key}</span></div>)}</div>
				<div className="export-note"><span>Last approved export</span><strong>{exportDate ? formatDate(exportDate) : "Not exported yet"}</strong></div>
			</section>
			{notice ? <div className={`notice ${notice.type}`} role={notice.type === "error" ? "alert" : "status"}><span>{notice.text}</span><button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message">×</button></div> : null}
			<div className="desk-layout" id="review-workspace" inert={busy ? true : undefined}>
				<Queue cases={cases} activeId={selectedId} status={status} query={query} loading={loading} onStatus={setStatus} onQuery={setQuery} onSelect={selectCase} />
				{draft ? <>
					<div className="case-main" aria-busy={busy}>
						<div className="case-title"><div><span className={`status-chip ${draft.adjudication.status}`}>{draft.adjudication.status}</span><h2 ref={caseHeading} tabIndex={-1}>{draft.id}</h2><p>{draft.origin.type} origin · {draft.window.mode} mode · updated {formatDate(draft.updatedAt)}{dirty ? " · unsaved changes" : ""}</p></div><div className="case-mark">#{draft.schemaVersion}</div></div>
						<Timeline messages={draft.window.messages} invalidEvidence={invalidFields.some(field => field.startsWith("role-"))} onChange={messages => {
							const next = { ...draft, window: { ...draft.window, messages } };
							if (invalidFields.length) setInvalidFields(validate(next).flatMap(error => error.field ? [error.field] : []));
							setDraft(next);
						}} />
					</div>
					<aside className="editor" aria-label="Case adjudication">
						<ProposalEditor messages={draft.window.messages} proposals={draft.window.expected.proposals} invalidFields={invalidFields} onChange={proposals => {
							const next = { ...draft, window: { ...draft.window, expected: { proposals } } };
							if (invalidFields.length) setInvalidFields(validate(next).flatMap(error => error.field ? [error.field] : []));
							setDraft(next);
						}} />
						<label className="notes-label">Reviewer notes<textarea rows={5} value={draft.adjudication.notes} onChange={event => setDraft({ ...draft, adjudication: { ...draft.adjudication, notes: event.target.value } })} placeholder="Record ambiguities, corrections, or rejection rationale…" /></label>
						<div className="review-actions"><button type="button" className="secondary" disabled={busy} onClick={() => saveCase()}>Save draft</button><button type="button" className="reject" disabled={busy} onClick={() => saveCase("rejected", true)}>Reject & next</button><button type="button" className="approve" disabled={busy} onClick={() => saveCase("approved", true)}>Approve & next</button></div>
					</aside>
				</> : <section className="empty-desk"><img src="/hth-mark.svg" alt="" /><h2 ref={emptyHeading} tabIndex={-1}>{loading ? "Opening the desk…" : "No case selected"}</h2><p>{loading ? "Fetching conversation evidence and adjudication details." : "Choose a case from the queue or create a new scenario."}</p></section>}
			</div>
		</main>
		<CreateDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreate={createCase} />
	</div>;
}

function errorText(cause: unknown, fallback: string) { return cause instanceof Error && cause.message ? cause.message : fallback; }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date); }
