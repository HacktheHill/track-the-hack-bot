import type { CorpusMessage, ExpectedProposal, ProposalAction } from "../types";

interface ProposalEditorProps {
	proposals: ExpectedProposal[];
	messages: CorpusMessage[];
	invalidFields: string[];
	onChange: (proposals: ExpectedProposal[]) => void;
}

const emptyProposal = (): ExpectedProposal => ({ action: "create", titleIncludes: [], sourceMessageIds: [], assigneeAlias: null, dueDate: null });

export function ProposalEditor({ proposals, messages, invalidFields, onChange }: ProposalEditorProps) {
	function patch(index: number, value: Partial<ExpectedProposal>) {
		onChange(proposals.map((proposal, proposalIndex) => proposalIndex === index ? { ...proposal, ...value } : proposal));
	}

	return <section aria-labelledby="expected-title">
		<div className="section-heading editor-heading">
			<div><p className="eyebrow">Ground truth</p><h2 id="expected-title">Expected proposals</h2></div>
			<label className="toggle"><input type="checkbox" checked={proposals.length === 0} onChange={event => onChange(event.target.checked ? [] : [emptyProposal()])} /><span>No proposal</span></label>
		</div>
		{proposals.length === 0 ? <div className="no-proposal"><strong>This conversation should produce no work.</strong><span>Turn off “No proposal” to add expected output.</span></div> : null}
		<div className="proposal-stack">
			{proposals.map((proposal, index) => <fieldset className="proposal" key={index}>
				<legend>Proposal {index + 1}</legend>
				<div className="form-row">
					<label>Action<select value={proposal.action} onChange={event => patch(index, { action: event.target.value as ProposalAction })}><option value="create">Create</option><option value="update">Update</option><option value="complete">Complete</option><option value="reopen">Reopen</option></select></label>
					<label>Assignee alias<input value={proposal.assigneeAlias ?? ""} onChange={event => patch(index, { assigneeAlias: event.target.value || null })} placeholder="Optional alias" /></label>
				</div>
				<label>Title must include<input id={`proposal-title-${index}`} value={proposal.titleIncludes.join(", ")} onChange={event => patch(index, { titleIncludes: event.target.value.split(",").map(value => value.trim()) })} onBlur={() => patch(index, { titleIncludes: proposal.titleIncludes.filter(Boolean) })} placeholder="sponsor, outreach, deck" aria-invalid={invalidFields.includes(`proposal-title-${index}`)} aria-describedby={`title-help-${index}`} /></label>
				<span className="field-help" id={`title-help-${index}`}>{invalidFields.includes(`proposal-title-${index}`) ? "Enter at least one matching term." : "Comma-separated matching terms."}</span>
				<label>Due date<input type="date" value={proposal.dueDate ?? ""} onChange={event => patch(index, { dueDate: event.target.value || null })} /></label>
				<div className="source-picker" id={`proposal-source-${index}`} tabIndex={-1} aria-invalid={invalidFields.includes(`proposal-source-${index}`)} aria-describedby={invalidFields.includes(`proposal-source-${index}`) ? `source-error-${index}` : undefined}>
					<span className="field-label">Source messages</span>
					<div className="source-options">{messages.map(message => {
						const checked = proposal.sourceMessageIds.includes(message.id);
						return <label key={message.id} className={checked ? "checked" : ""}><input type="checkbox" checked={checked} onChange={() => patch(index, { sourceMessageIds: checked ? proposal.sourceMessageIds.filter(id => id !== message.id) : [...proposal.sourceMessageIds, message.id] })} /><span><strong>{message.id}</strong> {message.authorAlias}</span></label>;
					})}</div>
					{invalidFields.includes(`proposal-source-${index}`) ? <span className="field-help" id={`source-error-${index}`}>Select at least one source message.</span> : null}
				</div>
				<button className="text-button danger-text" type="button" onClick={() => onChange(proposals.filter((_, proposalIndex) => proposalIndex !== index))}>Remove proposal</button>
			</fieldset>)}
		</div>
		{proposals.length > 0 && proposals.length < 5 ? <button className="secondary full" type="button" onClick={() => onChange([...proposals, emptyProposal()])}>+ Add another proposal</button> : null}
	</section>;
}
