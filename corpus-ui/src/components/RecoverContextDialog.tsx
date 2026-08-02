import { useEffect, useRef, useState } from "react";
import type { RecoveryPreview } from "../types";

interface RecoverContextDialogProps {
	open: boolean;
	busy: boolean;
	onClose: () => void;
	onPreview: (messageUrls: string[]) => Promise<RecoveryPreview>;
	onApply: (preview: RecoveryPreview) => void;
}

const discordMessageLinkPattern = /https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+/g;

function parsedMessageLinks(value: string) {
	const matches = value.match(discordMessageLinkPattern) ?? [];
	return {
		links: [...new Set(matches)],
		duplicateCount: matches.length - new Set(matches).size,
		hasInvalidText: Boolean(value.replace(discordMessageLinkPattern, "").trim()),
	};
}

export function RecoverContextDialog({ open, busy, onClose, onPreview, onApply }: RecoverContextDialogProps) {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const [urls, setUrls] = useState("");
	const [preview, setPreview] = useState<RecoveryPreview>();
	const [error, setError] = useState("");

	useEffect(() => {
		const dialog = dialogRef.current;
		if (open && dialog && !dialog.open) {
			setUrls("");
			setPreview(undefined);
			setError("");
			dialog.showModal();
		}
		if (!open && dialog?.open) dialog.close();
	}, [open]);

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		const parsed = parsedMessageLinks(urls);
		if (parsed.hasInvalidText) { setError("Remove any text that is not a canonical Discord message link."); return; }
		if (!parsed.links.length) { setError("Paste at least one Discord message link."); return; }
		if (parsed.links.length > 40) { setError(`Select at most 40 unique messages; ${parsed.links.length} were detected.`); return; }
		try {
			setError("");
			setPreview(await onPreview(parsed.links));
		} catch (cause) {
			setPreview(undefined);
			setError(cause instanceof Error ? cause.message : "Could not recover Discord context.");
		}
	}

	const parsed = parsedMessageLinks(urls);
	const added = preview?.case.window.messages.filter(message => preview.addedMessageIds.includes(message.id)) ?? [];
	return <dialog ref={dialogRef} aria-labelledby="recover-title" className="dialog-backdrop" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} onMouseDown={event => { if (!busy && event.target === event.currentTarget) onClose(); }}>
		<div className="dialog-panel recovery-dialog">
			<div className="dialog-heading"><div><p className="eyebrow">Conversation evidence</p><h2 id="recover-title">Recover context</h2></div><button className="close-button" type="button" disabled={busy} onClick={onClose} aria-label="Close dialog">×</button></div>
			<p className="dialog-intro">Paste links to the exact missing Discord messages. Recovery retrieves only those messages and never includes the case automatically.</p>
			<form onSubmit={submit}>
				<label>Discord message links<textarea autoFocus rows={6} disabled={busy} value={urls} onChange={event => { setUrls(event.target.value); setPreview(undefined); setError(""); }} placeholder={"https://discord.com/channels/…/…/…\nOne message link per line"} aria-invalid={Boolean(error)} aria-describedby={error ? "recover-error" : "recover-help"} /></label>
				<span className="field-help" id="recover-help">Up to 40 canonical organizer-server links. Joined links are separated automatically, and duplicates are ignored.{parsed.links.length ? ` ${parsed.links.length} unique message${parsed.links.length === 1 ? "" : "s"} detected${parsed.duplicateCount ? `; ${parsed.duplicateCount} duplicate${parsed.duplicateCount === 1 ? "" : "s"} ignored` : ""}.` : ""}</span>
				{error ? <p id="recover-error" className="inline-error" role="alert">{error}</p> : null}
				{preview ? <section className="recovery-preview" aria-labelledby="recovery-preview-title">
					<h3 id="recovery-preview-title">Recovered evidence</h3>
					<ul>{added.map(message => <li key={message.id}><strong>{message.id} · {message.authorAlias}</strong><span>{message.text || "No message text"}</span></li>)}</ul>
					{preview.warnings.length ? <div className="recovery-warnings"><strong>Review before applying</strong>{preview.warnings.map(warning => <p key={warning}>{warning}</p>)}</div> : null}
					<p className="recovery-save-note">Applying updates the local draft only. Review evidence roles and proposal sources, then select Save draft.</p>
				</section> : null}
				<div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button>{preview ? <button type="button" className="primary" disabled={busy} onClick={() => onApply(preview)}>Apply to draft</button> : <button className="primary" disabled={busy}>{busy ? "Recovering…" : "Preview recovery"}</button>}</div>
			</form>
		</div>
	</dialog>;
}
