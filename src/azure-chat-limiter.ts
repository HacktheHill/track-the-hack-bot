type QueuedAttempt<T> = {
	key: string;
	signal?: AbortSignal;
	operation: () => Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
	onAbort?: () => void;
};

const MAX_PROVIDER_COOLDOWN_MS = 120_000;

export function boundedProviderCooldown(milliseconds: number) {
	return Math.min(Math.max(0, milliseconds), MAX_PROVIDER_COOLDOWN_MS);
}

function abortReason(signal?: AbortSignal) {
	return signal?.reason ?? new DOMException("Azure OpenAI request aborted.", "AbortError");
}

export function retryAfterMilliseconds(response: Response, now = Date.now()) {
	const milliseconds = response.headers.get("retry-after-ms") ?? response.headers.get("x-ms-retry-after-ms");
	if (milliseconds !== null) {
		const value = Number(milliseconds);
		if (Number.isFinite(value)) return Math.max(0, value);
	}
	const retryAfter = response.headers.get("retry-after");
	if (retryAfter === null) return undefined;
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(retryAfter);
	return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export class AzureChatLimiter {
	private readonly queue: QueuedAttempt<unknown>[] = [];
	private readonly cooldowns = new Map<string, number>();
	private active = 0;
	private lastStartedAt = 0;
	private timer?: NodeJS.Timeout;

	constructor(
		private readonly maxConcurrency = 1,
		private readonly minIntervalMs = 1000,
	) {}

	run<T>(key: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
		if (signal?.aborted) return Promise.reject(abortReason(signal));
		return new Promise<T>((resolve, reject) => {
			const attempt: QueuedAttempt<T> = { key, signal, operation, resolve, reject };
			attempt.onAbort = () => {
				const index = this.queue.indexOf(attempt as QueuedAttempt<unknown>);
				if (index < 0) return;
				this.queue.splice(index, 1);
				reject(abortReason(signal));
				this.pump();
			};
			signal?.addEventListener("abort", attempt.onAbort, { once: true });
			this.queue.push(attempt as QueuedAttempt<unknown>);
			this.pump();
		});
	}

	private pump() {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.active >= this.maxConcurrency || !this.queue.length) return;
		const now = Date.now();
		const globallyReadyAt = this.lastStartedAt + this.minIntervalMs;
		const firstByKey = new Map<string, number>();
		for (const [index, attempt] of this.queue.entries()) if (!firstByKey.has(attempt.key)) firstByKey.set(attempt.key, index);
		const nextIndex = [...firstByKey.values()].find(index => Math.max(globallyReadyAt, this.cooldowns.get(this.queue[index]!.key) ?? 0) <= now);
		if (nextIndex === undefined) {
			const readyAt = Math.min(...[...firstByKey.values()].map(index => Math.max(globallyReadyAt, this.cooldowns.get(this.queue[index]!.key) ?? 0)));
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.pump();
			}, readyAt - now);
			return;
		}
		const [next] = this.queue.splice(nextIndex, 1);
		next.signal?.removeEventListener("abort", next.onAbort!);
		if (next.signal?.aborted) {
			next.reject(abortReason(next.signal));
			this.pump();
			return;
		}
		this.active++;
		this.lastStartedAt = now;
		void Promise.resolve().then(next.operation).then(value => {
			if (value instanceof Response && value.status === 429) {
				const delay = retryAfterMilliseconds(value);
				if (delay !== undefined) this.cooldowns.set(next.key, Date.now() + boundedProviderCooldown(delay));
			}
			next.resolve(value);
		}, next.reject).finally(() => {
			this.active--;
			this.pump();
		});
		this.pump();
	}
}

let processLimiter: AzureChatLimiter | undefined;

export function processAzureChatLimiter(config: { AZURE_OPENAI_CHAT_MAX_CONCURRENCY: number; AZURE_OPENAI_CHAT_MIN_INTERVAL_MS: number }) {
	processLimiter ??= new AzureChatLimiter(config.AZURE_OPENAI_CHAT_MAX_CONCURRENCY ?? 1, config.AZURE_OPENAI_CHAT_MIN_INTERVAL_MS ?? 1000);
	return processLimiter;
}
