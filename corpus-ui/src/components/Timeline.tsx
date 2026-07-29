import type { ContextRole, CorpusMessage } from "../types";

interface TimelineProps {
	messages: CorpusMessage[];
	discordMessages?: Record<string, { url: string }>;
	invalidEvidence: boolean;
	onChange: (messages: CorpusMessage[]) => void;
}

const roles: Array<{ value: ContextRole | ""; label: string }> = [
	{ value: "", label: "Context" },
	{ value: "primary", label: "Primary / focal" },
	{ value: "preceding", label: "Preceding" },
	{ value: "subsequent", label: "Subsequent" },
	{ value: "thread_root", label: "Thread root" },
	{ value: "reply_target", label: "Reply target" },
	{ value: "referenced_history", label: "Referenced history" },
];

export function Timeline({ messages, discordMessages, invalidEvidence, onChange }: TimelineProps) {
	function setRole(index: number, role: string) {
		onChange(messages.map((message, messageIndex) => messageIndex === index
			? { ...message, contextRole: role ? role as ContextRole : undefined, priority: role === "primary" ? true : undefined }
			: message));
	}

	return <section className="timeline-panel" aria-labelledby="conversation-title">
		<div className="section-heading">
			<div><p className="eyebrow">Conversation evidence</p><h2 id="conversation-title">Timeline</h2></div>
			<span>{messages.length} messages</span>
		</div>
		<div className="timeline">
			{invalidEvidence ? <p className="inline-error" id="evidence-role-error" role="alert">Choose the required primary / focal evidence role.</p> : null}
			{messages.map((message, index) => <article className={`message ${message.contextRole === "primary" || message.priority ? "focal" : ""}`} key={message.id}>
				<div className="message-rail" aria-hidden="true"><span>{index + 1}</span></div>
				<div className="message-body">
					<header>
						<div><strong>{message.authorAlias}</strong>{discordMessages?.[message.id]
							? <a className="message-id message-link" href={discordMessages[message.id].url} target="_blank" rel="noreferrer" aria-label={`Open ${message.id} in Discord in a new tab`}>{message.id}<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7M13 3 7 9M11 9v4H3V5h4" /></svg></a>
							: <span className="message-id">{message.id}</span>}</div>
						<time dateTime={message.timestamp}>{formatTimestamp(message.timestamp)}</time>
					</header>
					<p>{message.text || <em>No message text</em>}</p>
					<div className="message-controls">
						<label htmlFor={`role-${message.id}`}>Evidence role</label>
						<select id={`role-${message.id}`} aria-invalid={invalidEvidence} aria-describedby={invalidEvidence ? "evidence-role-error" : undefined} value={message.contextRole ?? (message.priority ? "primary" : "")} onChange={event => setRole(index, event.target.value)}>
							{roles.map(role => <option key={role.value} value={role.value}>{role.label}</option>)}
						</select>
						{message.replyTo ? <span className="reply-tag">Replies to {message.replyTo}</span> : null}
					</div>
					{message.attachments?.length ? <ul className="attachments" aria-label="Attachments">{message.attachments.map(file => <li key={file.id}><a href={file.url} target="_blank" rel="noreferrer">{file.name}</a></li>)}</ul> : null}
				</div>
			</article>)}
		</div>
	</section>;
}

function formatTimestamp(value: string) {
	const date = new Date(value);
	return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}
