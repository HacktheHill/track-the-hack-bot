import { useEffect, useRef, useState } from "react";
import type { CorpusCase } from "../types";

interface CreateDialogProps {
	open: boolean;
	onClose: () => void;
	onCreate: (value: CorpusCase) => Promise<void>;
}

export function CreateDialog({ open, onClose, onCreate }: CreateDialogProps) {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const [id, setId] = useState("");
	const [mode, setMode] = useState<"manual" | "automatic">("automatic");
	const [author, setAuthor] = useState("Person A");
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const idValid = /^[a-zA-Z0-9._-]{1,160}$/.test(id);
	useEffect(() => {
		const dialog = dialogRef.current;
		if (open && dialog && !dialog.open) dialog.showModal();
		if (!open && dialog?.open) dialog.close();
	}, [open]);

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		if (!idValid || !author.trim() || !message.trim()) {
			setError("Use a 1–160 character case ID containing only letters, numbers, periods, underscores, or hyphens. Author alias and opening message are required.");
			return;
		}
		const now = new Date().toISOString();
		const value: CorpusCase = {
			schemaVersion: "v1",
			id: id.trim(),
			origin: { type: "manual_scenario" },
			window: { id: id.trim(), mode, messages: [{ id: "m1", authorAlias: author.trim(), text: message.trim(), timestamp: now, contextRole: "primary", priority: true }], expected: { proposals: [] } },
			adjudication: { status: "pending", notes: "" },
			createdAt: now,
			updatedAt: now,
		};
		try {
			setBusy(true); setError("");
			await onCreate(value);
			setId(""); setMessage(""); onClose();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not create the scenario.");
		} finally { setBusy(false); }
	}

	return <dialog ref={dialogRef} aria-labelledby="create-title" className="dialog-backdrop" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} onMouseDown={event => { if (!busy && event.target === event.currentTarget) onClose(); }}>
		<div className="dialog-panel">
			<div className="dialog-heading"><div><p className="eyebrow">New evidence window</p><h2 id="create-title">Create scenario</h2></div><button className="close-button" type="button" disabled={busy} onClick={onClose} aria-label="Close dialog">×</button></div>
			<form onSubmit={submit}>
				<label>Case ID<input autoFocus required maxLength={160} pattern="[a-zA-Z0-9._-]+" aria-invalid={Boolean(error && !idValid)} aria-describedby={error ? "create-error" : undefined} value={id} onChange={event => setId(event.target.value)} placeholder="review-1042" /></label>
				<label>Evaluation mode<select value={mode} onChange={event => setMode(event.target.value as "manual" | "automatic")}><option value="automatic">Automatic</option><option value="manual">Manual</option></select></label>
				<label>Author alias<input required aria-invalid={Boolean(error && !author.trim())} aria-describedby={error ? "create-error" : undefined} value={author} onChange={event => setAuthor(event.target.value)} /></label>
				<label>Opening message<textarea required aria-invalid={Boolean(error && !message.trim())} aria-describedby={error ? "create-error" : undefined} rows={5} value={message} onChange={event => setMessage(event.target.value)} placeholder="Paste the first pseudonymized message…" /></label>
				{error ? <p id="create-error" className="inline-error" role="alert">{error}</p> : null}
				<div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? "Creating…" : "Create pending case"}</button></div>
			</form>
		</div>
	</dialog>;
}
