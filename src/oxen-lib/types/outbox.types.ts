export interface OutboxEntry {
    eventId: string;
    jobName: string;
    jobData: Record<string, any>;
    queue: string | null;
    desiredProcessingTime: Date;
}

export interface IOutboxDispatcher {
    save(entry: OutboxEntry, transactionContext?: unknown): Promise<void>;
}