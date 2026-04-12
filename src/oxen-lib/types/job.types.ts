import { Job } from "bullmq";

export interface IOxenJob {
    name: string;
    defaultQueue: string | null;
    maxRetries: number;
    scheduleable?: boolean;
    catchUp: boolean;
    dedupPeriod: number;
    crossQueueDedup: boolean;
    unrecoverableErrors: (new (...args: any[]) => Error)[];
    cron(): string | null;
    every(): number | null;
    id(data: unknown): string;
    dedupId(data: unknown): string | null;
    handle(job: any): Promise<unknown>;
    fail(error: Error, job: Job): void;
    complete(data?: unknown): void;
    backoff(attempts: number, error?: Error): number | null;
    delay(ms: number): this;
    onQueue(queueName: string): this;
    dispatch(data: unknown): Promise<void>;
    schedule(): Promise<void>;
    setBullJob(job: Job): void;
}

export type IOxenJobConstructor = new () => IOxenJob;