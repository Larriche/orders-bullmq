export enum OutboxEventStatus {
    Pending = "pending",
    Processed = "processed",
    Failed = "failed",
}

export interface IOutboxEvent {
    eventId: string;
    jobName: string;
    jobData: Record<string, any>;
    queue: string | null;
    status: OutboxEventStatus;
    desiredProcessingTime: Date;
    processedAt: Date | null;
}

export interface IOutboxEventModel extends IOutboxEvent {
    _id: string;
    createdAt: Date;
    updatedAt: Date;
}
