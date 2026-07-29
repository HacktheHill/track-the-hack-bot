import { useEffect, useRef, useState } from "react";
import type { ExclusionReason } from "../types";

interface ExcludeDialogProps {
	open: boolean;
	busy: boolean;
	initialReasons: ExclusionReason[];
	initialNotes: string;
	onClose: () => void;
	onExclude: (reasons: ExclusionReason[], notes: string) => Promise<boolean>;
}

const reasonOptions: Array<{ value: ExclusionReason; label: string }> = [
	{ value: "missing_context", label: "Missing messages or context" },
	{ value: "missing_attachment", label: "Missing attachment content" },
	{ value: "broken_reference", label: "Broken reply or reference chain" },
	{ value: "ambiguous_ground_truth", label: "Ambiguous ground truth" },
	{ value: "sensitive_content", label: "Sensitive or private material" },
	{ value: "duplicate", label: "Duplicate case" },
	{ value: "malformed_capture", label: "Malformed capture" },
	{ value: "out_of_scope", label: "Out of scope" },
	{ value: "other", label: "Other" },
];

export function ExcludeDialog({ open, busy, initialReasons, initialNotes, onClose, onExclude }: ExcludeDialogProps) {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const [reasons, setReasons] = useState<ExclusionReason[]>(initialReasons);
	const [notes, setNotes] = useState(initialNotes);
	const [error, setError] = useState("");

	useEffect(() => {
		const dialog = dialogRef.current;
		if (open && dialog && !dialog.open) {
			setReasons(initialReasons);
			setNotes(initialNotes);
			setError("");
			dialog.showModal();
		}
		if (!open && dialog?.open) dialog.close();
	}, [open, initialReasons, initialNotes]);

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		if (!reasons.length) { setError("Select at least one exclusion reason."); return; }
		if (reasons.includes("other") && !notes.trim()) { setError("Describe the other exclusion reason in reviewer notes."); return; }
		setError("");
		if (!await onExclude(reasons, notes.trim())) setError("Could not exclude this case. Review the validation message in the desk and try again.");
	}

	return <dialog ref={dialogRef} aria-labelledby="exclude-title" className="dialog-backdrop" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} onMouseDown={event => { if (!busy && event.target === event.currentTarget) onClose(); }}>
		<div className="dialog-panel">
			<div className="dialog-heading"><div><p className="eyebrow">Corpus disposition</p><h2 id="exclude-title">Exclude this case</h2></div><button className="close-button" type="button" disabled={busy} onClick={onClose} aria-label="Close dialog">×</button></div>
			<p className="dialog-intro">Excluded cases are retained for audit and capture-quality analysis, but never enter evaluation exports.</p>
			<form onSubmit={submit}>
				<fieldset className="reason-picker" aria-describedby={error ? "exclude-error" : "exclude-help"}>
					<legend>Why is this case unusable?</legend>
					<p id="exclude-help">Select every reason that applies.</p>
					<div className="reason-options">{reasonOptions.map(option => {
						const checked = reasons.includes(option.value);
						return <label className={checked ? "checked" : ""} key={option.value}><input type="checkbox" checked={checked} onChange={() => setReasons(checked ? reasons.filter(reason => reason !== option.value) : [...reasons, option.value])} /><span>{option.label}</span></label>;
					})}</div>
				</fieldset>
				<label>Reviewer notes<textarea rows={5} value={notes} onChange={event => setNotes(event.target.value)} placeholder="Optional details that help diagnose or recapture this case…" /></label>
				{error ? <p id="exclude-error" className="inline-error" role="alert">{error}</p> : null}
				<div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="exclude" disabled={busy}>{busy ? "Excluding…" : "Exclude & next"}</button></div>
			</form>
		</div>
	</dialog>;
}
