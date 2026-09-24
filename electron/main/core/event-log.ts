import { EVENT_LOG_LIMIT, type LogEntry, type LogSource, type LogTone } from '@brobot-client/shared';
import type { Clock } from './clock';

/**
 * The window's event log: what the bot asked, what the host did, and what
 * happened to the connection. Kept in memory only and capped — it is a
 * "what just happened" view, not an audit trail.
 */
export class EventLog {
    private entries: LogEntry[] = [];
    private nextId = 1;

    constructor(
        private readonly clock: Clock,
        private readonly onAppend: (entry: LogEntry) => void,
        private readonly limit = EVENT_LOG_LIMIT,
    ) {}

    get all(): readonly LogEntry[] {
        return this.entries;
    }

    append(source: LogSource, tone: LogTone, message: string): LogEntry {
        const entry: LogEntry = { id: this.nextId++, at: this.clock.now(), source, tone, message };
        this.entries.push(entry);
        if (this.entries.length > this.limit) {
            this.entries = this.entries.slice(this.entries.length - this.limit);
        }
        this.onAppend(entry);
        return entry;
    }

    clear(): void {
        this.entries = [];
    }
}
