import { Job } from "bullmq";
import crypto from "crypto";
import Redis from "ioredis";

import { QueueRegistry } from "./QueuesRegistry";
import { IOutboxDispatcher } from "./types/outbox.types";

export class OxenJob<TData = unknown> {
    private static redis: Redis | null = null;
    private static _queueRegistry: QueueRegistry | null = null;
    public static readonly DEDUP_PREFIX = "oxen:dedup:";
    public static readonly JOB_ID_PREFIX = "oxen:jobid:";
    public static readonly LAST_RUN_PREFIX = "oxen:last_run:";

    // --- Job identity & queue targeting ---

    /** The job's unique name, derived from the class name as default. Used as the BullMQ job name and registry lookup key. */
    public readonly name: string = this.constructor.name;

    /** Queue this job dispatches to by default. Falls back to the registry's default queue when null. */
    public readonly defaultQueue: string | null = null;

    // --- Scheduling ---

    /** Whether this job should be registered as a repeatable job via cron() or every(). */
    public readonly scheduleable: boolean = false;

    /** Whether this job should dispatch a catch-up run if the worker was offline and missed a scheduled tick. */
    public readonly catchUp: boolean = false;

    // --- Retry & error handling ---

    /** Maximum number of retry attempts before the job is moved to the failed set. */
    public readonly maxRetries: number = 5;

    /** Base delay (ms) for the exponential backoff formula: 2^attempt * backoffTime. */
    public readonly backoffTime = 10000;

    /** Error classes that should not be retried. Matched via instanceof in the worker processor. */
    public readonly unrecoverableErrors: (new (...args: any[]) => Error)[] = [];

    // --- Deduplication ---

    /** TTL (ms) for the Redis dedup key. Duplicate dispatches (based on the dedupId and not the job ID) within this window are silently dropped. */
    public readonly dedupPeriod = 60000 * 60 * 24;

    /** Enable Redis-based deduplication that works across all queues (not just the target queue). */
    public readonly crossQueueDedup: boolean = false;

    // --- Outbox ---

    /** Storage adapter for writing outbox entries if you want the job to support dispatches within an outbox setup. */
    public outboxDispatcher?: IOutboxDispatcher;

    /** Flag set by viaOutbox() to route the next dispatch() through the outbox instead of BullMQ directly. */
    protected dispatchViaOutbox: boolean = false;

    // --- Fluent dispatch state (reset after each dispatch) ---

    /** Delay (ms) before the job becomes processable. Set via delay(), cleared after dispatch. */
    protected scheduledDelay: number | null = null;

    /** One-off queue override for the next dispatch. Set via onQueue(), cleared after dispatch. */
    protected nextRunQueue: string | null = null;

    /** Absolute deadline after which the job is rejected as unrecoverable. Set via deadline(). */
    protected deadlineDate: Date | null = null;

    /** BullMQ priority for the next dispatch (high=1, normal=2, low=3). Set via prioritize(). */
    protected priority: "high" | "normal" | "low" | null = null;

    /** Transaction context (e.g. a Mongoose ClientSession) passed to the outbox dispatcher for atomic writes. */
    protected outboxDispatcherContext?: unknown;

    // --- Runtime state ---

    /** The underlying BullMQ Job instance, set by the worker before calling handle(). */
    protected _job: Job | null = null;

    /** Inject the shared Redis client used for deduplication, job ID tracking, and scheduled job management. */
    public static setRedis(redis: Redis): void {
        OxenJob.redis = redis;
    }

    /** Inject the shared QueueRegistry so jobs can resolve queue names to BullMQ Queue instances at dispatch time. */
    public static setQueueRegistry(registry: QueueRegistry): void {
        OxenJob._queueRegistry = registry;
    }

    /** Internal accessor that throws if the queue registry hasn't been injected yet. */
    private static get queueRegistry(): QueueRegistry {
        if (!OxenJob._queueRegistry) {
            throw new Error(
                "QueueRegistry not set on OxenJob. Call OxenJob.setQueueRegistry() first.",
            );
        }
        return OxenJob._queueRegistry;
    }

    /** Return a cron expression if this job runs on a cron schedule. Override in subclasses. */
    public cron(): string | null {
        return null;
    }

    /** Return an interval in ms if this job runs on a fixed interval. Override in subclasses. */
    public every(): number | null {
        return null;
    }

    /**
     * Generate a unique BullMQ job ID for this dispatch. Override to produce deterministic
     * IDs (e.g. based on an entity ID) for idempotent dispatches or outbox eventId derivation.
     */
    public id(data: TData): string {
        return `job-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    }

    /**
     * Return a deduplication key for this job's data, or null to skip dedup.
     * When crossQueueDedup is enabled, a Redis key with this value prevents
     * duplicate dispatches within the dedupPeriod window.
     */
    public dedupId(data: TData): string | null {
        return null;
    }

    /** Process the job. Every concrete job subclass must override this with its business logic. */
    public async handle(data: unknown): Promise<unknown> {
        throw new Error("Method not implemented.");
    }

    /** Called by the worker when the job fails. Override to add custom failure handling (e.g. logging, alerts). */
    public fail(error: Error, job: Job): void {
        console.error(`Error in job ${job.name}:`, error);
    }

    /** Called by the worker after the job completes successfully. Override to add post-completion logic. */
    public complete(data?: unknown): void {
        console.log(`Job ${this.name} completed successfully and returned data:`, data);
    }

    /** Compute the backoff delay (ms) for the given attempt. Default: exponential (2^attempt * backoffTime). */
    public backoff(attempts: number, error?: Error): number {
        // Exponential backoff: 2^attempts * backoffTime
        return Math.pow(2, attempts) * this.backoffTime;
    }

    /** Fluent setter: delay the next dispatch by the given milliseconds. */
    public delay(ms: number): this {
        this.scheduledDelay = ms;
        return this;
    }

    /** Static fluent entry point: `MyJob.delay(5000).dispatch(data)`. */
    public static delay<T>(this: new () => OxenJob<T>, ms: number) {
        const instance = new this();
        return instance.delay(ms);
    }

    /** Fluent setter: route the next dispatch to a specific queue instead of the default. */
    public onQueue(queueName: string): this {
        this.nextRunQueue = queueName;
        return this;
    }

    /** Static fluent entry point: `MyJob.onQueue('payments').dispatch(data)`. */
    public static onQueue<T>(this: new () => OxenJob<T>, queueName: string) {
        const instance = new this();
        return instance.onQueue(queueName);
    }

    /**
     * Dispatch this job for processing.
     *
     * If viaOutbox() was called, writes an OutboxEntry through the outbox dispatcher
     * (within the caller's transaction) instead of adding directly to BullMQ. Otherwise,
     * resolves the target queue, performs optional cross-queue deduplication via Redis,
     * applies fluent options (delay, priority, deadline), and adds the job to BullMQ.
     *
     * All fluent state (delay, queue override, priority, deadline, outbox context) is
     * reset after dispatch so the instance can be safely reused.
     */
    public async dispatch(data: TData): Promise<void> {
        if (this.dispatchViaOutbox) {
            await this.dispatchToOutbox(data);
            return;
        }

        await this.dispatchToQueue(data);
    }

    /** Write an OutboxEntry via the outbox dispatcher and reset fluent state. */
    private async dispatchToOutbox(data: TData): Promise<void> {
        if (!this.outboxDispatcher) {
            throw new Error(
                "OutboxDispatcher not set. Set the outboxDispatcher property before calling viaOutbox().",
            );
        }

        const queueName = this.nextRunQueue || this.defaultQueue;

        const desiredProcessingTime =
            this.scheduledDelay != null
                ? new Date(Date.now() + this.scheduledDelay)
                : new Date();

        await this.outboxDispatcher.save(
            {
                eventId: this.id(data),
                jobName: this.name,
                jobData: { ...(data as object) },
                queue: queueName,
                desiredProcessingTime,
            },
            this.outboxDispatcherContext,
        );

        this.resetFluentState();
        this.dispatchViaOutbox = false;
        this.outboxDispatcherContext = undefined;
    }

    /** Resolve the target queue, run dedup checks, build options, and add the job to BullMQ. */
    private async dispatchToQueue(data: TData): Promise<void> {
        const queueName = this.nextRunQueue || this.defaultQueue;

        const queue = queueName
            ? OxenJob.queueRegistry.getQueue(queueName)
            : OxenJob.queueRegistry.getDefaultQueue();

        const dedupId = this.dedupId(data);
        if (dedupId && await this.isDuplicate(dedupId)) {
            return;
        }

        const jobId = this.id(data);

        if (await this.isJobIdDuplicate(jobId)) {
            return;
        }

        const opts = this.buildJobOptions(jobId);
        const jobData = this.buildJobData(data);

        await queue.add(this.name, jobData, opts);

        this.resetFluentState();
    }

    /**
     * Check if a job with the given dedupId has already been dispatched within the dedup window.
     * Uses a Redis SET NX with the dedupPeriod as TTL.
     */
    private async isDuplicate(dedupId: string): Promise<boolean> {
        if (!this.crossQueueDedup) return false;

        if (!OxenJob.redis) {
            throw new Error(
                "Redis client not set on OxenJob. Call OxenJob.setRedis() first.",
            );
        }

        const key = `${OxenJob.DEDUP_PREFIX}${dedupId}`;
        const set = await OxenJob.redis.set(
            key,
            "1",
            "PX",
            this.dedupPeriod,
            "NX",
        );

        if (!set) {
            console.log(
                `Job ${this.name} skipped — deduplicated (dedupId: ${dedupId})`,
            );
            return true;
        }

        return false;
    }

    /**
     * Check if a job with the given jobId has already been dispatched (cross-queue).
     * Uses a Redis SET NX without TTL — cleaned up by listenForRemovals when the job is removed.
     */
    private async isJobIdDuplicate(jobId: string): Promise<boolean> {
        if (!this.crossQueueDedup || !OxenJob.redis) return false;

        const jobIdKey = `${OxenJob.JOB_ID_PREFIX}${jobId}`;
        const set = await OxenJob.redis.set(jobIdKey, "1", "NX");

        if (!set) {
            console.log(
                `Job ${this.name} skipped — duplicate job ID (jobId: ${jobId})`,
            );
            return true;
        }

        return false;
    }

    /** Build BullMQ job options from fluent state (delay, priority, retries). */
    private buildJobOptions(jobId: string): Record<string, any> {
        const opts: Record<string, any> = {
            jobId,
            attempts: this.maxRetries,
            backoff: { type: "custom" },
        };

        if (this.scheduledDelay != null) {
            opts.delay = this.scheduledDelay;
        }

        if (this.priority != null) {
            opts.priority = OxenJob.priorityToNumber(this.priority);
        }

        return opts;
    }

    /** Build the job data payload, injecting the _deadline timestamp if set. */
    private buildJobData(data: TData): Record<string, any> {
        const jobData: Record<string, any> = { ...(data as object) };

        if (this.deadlineDate != null) {
            jobData._deadline = this.deadlineDate.getTime();
        }

        return jobData;
    }

    /** Clear all fluent dispatch state so the instance can be reused. */
    private resetFluentState(): void {
        this.scheduledDelay = null;
        this.nextRunQueue = null;
        this.deadlineDate = null;
        this.priority = null;
    }

    /** Static shorthand: `MyJob.dispatch(data)` — creates an instance and dispatches in one call. */
    public static async dispatch<T>(
        this: new () => OxenJob<T>,
        data: T,
    ): Promise<void> {
        const instance = new this();
        await instance.dispatch(data);
    }

    /**
     * Register this job as a repeatable job scheduler in BullMQ.
     *
     * Uses either `every()` (interval ms) or `cron()` (cron expression) to
     * upsert a BullMQ job scheduler on the target queue. No-op if the job
     * is not marked as scheduleable.
     */
    public async schedule(): Promise<void> {
        if (!this.scheduleable) return;

        let queueName = this.nextRunQueue || this.defaultQueue;

        const queue = queueName
            ? OxenJob.queueRegistry.getQueue(queueName)
            : OxenJob.queueRegistry.getDefaultQueue();

        const everyMs = this.every();
        const pattern = this.cron() || undefined;

        const repeatOpts = everyMs
            ? { every: everyMs }
            : { pattern, tz: "UTC" as const };

        await queue.upsertJobScheduler(this.name, repeatOpts, {
            name: this.name,
            data: {},
            opts: {
                attempts: this.maxRetries,
                backoff: { type: "custom" },
            },
        });
        console.log(
            `Scheduled job: ${this.name} on queue ${queue.name} with ${everyMs ? `every ${everyMs}ms` : `schedule ${pattern}`}`,
        );
    }

    /** Fluent setter: reject the job as unrecoverable if it hasn't been processed by the given date. */
    public deadline(date: Date): this {
        this.deadlineDate = date;
        return this;
    }

    /** Static fluent entry point: `MyJob.deadline(date).dispatch(data)`. */
    public static deadline<T>(this: new () => OxenJob<T>, date: Date) {
        const instance = new this();
        return instance.deadline(date);
    }

    /** Fluent setter: assign a BullMQ priority level to the next dispatch. */
    public prioritize(priority: "high" | "normal" | "low"): this {
        this.priority = priority;
        return this;
    }

    /** Called by the worker to inject the underlying BullMQ Job before handle() runs. */
    public setBullJob(job: Job): void {
        this._job = job;
    }

    /** Static fluent entry point: `MyJob.viaOutbox(session).dispatch(data)`. */
    public static viaOutbox(transactionContext?: unknown) {
        const instance = new this();
        return instance.viaOutbox(transactionContext);
    }

    /**
     * Fluent setter: route the next dispatch through the transactional outbox.
     *
     * When set, dispatch() writes an OutboxEntry via the outboxDispatcher
     * instead of adding directly to BullMQ, ensuring atomicity with the
     * caller's database transaction.
     *
     * @param transactionContext - Optional transaction handle (e.g. Mongoose ClientSession)
     *                             passed through to the outbox dispatcher's save().
     */
    public viaOutbox(transactionContext?: unknown) {
        this.dispatchViaOutbox = true;
        this.outboxDispatcherContext = transactionContext;
        return this;
    }

    /** Static fluent entry point: `MyJob.prioritize('high').dispatch(data)`. */
    public static prioritize<T>(
        this: new () => OxenJob<T>,
        priority: "high" | "normal" | "low",
    ) {
        const instance = new this();
        return instance.prioritize(priority);
    }

    /** Map a named priority level to its BullMQ numeric value (lower = higher priority). */
    private static priorityToNumber(
        priority: "high" | "normal" | "low",
    ): number {
        switch (priority) {
            case "high":
                return 1;
            case "normal":
                return 2;
            case "low":
                return 3;
        }
    }
}
