import { Job, Queue, QueueEvents, UnrecoverableError, Worker } from "bullmq";
import { CronExpressionParser } from "cron-parser";
import Redis from "ioredis";

import { JobsRegistry } from "./JobsRegistry";
import { OxenJob } from "./OxenJob";
import { QueueRegistry } from "./QueuesRegistry";
import { IOxenJob, IOxenJobConstructor } from "./types/job.types";

export type QueueConfig = {
    name: string;
    default: boolean;
    workers?: number;
};

export type ConnectionConfig = {
    host: string;
    port: number;
};

export class Oxen {
    // --- Static registries (shared across all Oxen instances) ---

    /** Global registry of all job classes, used to resolve job names to constructors */
    public static readonly jobRegistry = new JobsRegistry();

    /** Global registry of all BullMQ queues, used to resolve queue names to Queue instances */
    public static readonly queueRegistry = new QueueRegistry();

    // --- Instance configuration (provided at construction) ---

    /** Redis connection details for BullMQ queues and workers */
    private connectionConfig: ConnectionConfig;

    /** Queue definitions (name, default flag, worker count) */
    private queueConfigs: QueueConfig[];

    /** Job class constructors to register at bootstrap */
    private jobConstructors: IOxenJobConstructor[];

    // --- Instance runtime state ---

    /** Redis client used for dedup checks, worker stats, and scheduled job management */
    private redis: Redis;

    /** Redis hash key for tracking per-worker processed job counts */
    public readonly WORKER_STATS_KEY = "oxen:worker_stats";

    public constructor(
        connectionConfig: ConnectionConfig,
        queueConfigs: QueueConfig[],
        jobConstructors: IOxenJobConstructor[],
    ) {
        this.queueConfigs = queueConfigs;
        this.jobConstructors = jobConstructors;
        this.connectionConfig = connectionConfig;
        this.redis = new Redis({
            host: connectionConfig.host,
            port: connectionConfig.port,
        });
    }

    /**
     * Start the Oxen worker process to create a set of worker(s) against all queues
     * or a specified subset of queues.
     *
     * Validates configuration, bootstraps registries, creates BullMQ workers
     * for the specified queues, sets up job removal listeners, and registers
     * any repeatable (cron/interval) jobs.
     *
     * @param queueNames - Optional subset of queue names to run workers for.
     *                     If omitted, workers are created for all configured queues.
     *                     Unknown queue names will throw an error.
     */
    public async run(queueNames?: string[]) {
        if (!this.queueConfigs.some((c) => c.default)) {
            throw new Error(
                "No default queue configured. Exactly one queue must have default: true.",
            );
        }

        const queueSet = queueNames ? new Set(queueNames) : undefined;

        if (queueSet) {
            const knownQueues = new Set(this.queueConfigs.map((c) => c.name));
            const unknown = queueNames!.filter(
                (name) => !knownQueues.has(name),
            );
            if (unknown.length) {
                throw new Error(`Unknown queues: [${unknown.join(", ")}]`);
            }
        }

        this.bootstrap();
        this.createWorkers(queueSet);
        this.listenForRemovals();
        await this.scheduleRepeatableJobs(queueSet);
    }

    /**
     * Initialize shared static state without starting workers.
     *
     * Sets up the Redis client and queue registry on OxenJob, then registers
     * all configured queues and jobs. Safe to call multiple times — registries
     * are idempotent and lock after first completion.
     *
     * Called automatically by run(), but can also be called standalone by
     * processes that need access to registries without running workers
     * (e.g., dashboards, pollers, or other auxiliary processes).
     */
    public bootstrap() {
        OxenJob.setRedis(this.redis);
        OxenJob.setQueueRegistry(Oxen.queueRegistry);
        this.setupQueues();
        this.setupJobs();
    }

    /**
     * Create BullMQ Queue instances for each queue config and register them
     * in the global queue registry. No-op if the registry is already completed
     * (i.e., queues were already set up by a previous call).
     */
    protected setupQueues() {
        if (Oxen.queueRegistry.completed) return;

        for (const config of this.queueConfigs) {
            const queue = new Queue(config.name, {
                connection: this.connectionConfig,
            });
            Oxen.queueRegistry.registerQueue(config, queue);
        }

        Oxen.queueRegistry.markCompleted();
    }

    /**
     * Register all job constructors in the global job registry. No-op if the
     * registry is already completed. Each constructor is instantiated once to
     * extract its name, which serves as the lookup key for worker processing
     * and job dispatch resolution.
     */
    protected setupJobs() {
        if (Oxen.jobRegistry.completed) return;

        for (const JobConstructor of this.jobConstructors) {
            Oxen.jobRegistry.registerJob(JobConstructor);
        }

        Oxen.jobRegistry.markCompleted();
    }

    /**
     * Create BullMQ Worker instances for the specified queues.
     *
     * Iterates over the queue configs and spawns the configured number of
     * workers for each queue. If a queue name set is provided, only matching
     * queues get workers — this allows each process to run a subset of queues.
     *
     * @param queueNames - Optional set of queue names to create workers for.
     *                     If omitted, workers are created for all configured queues.
     */
    protected createWorkers(queueNames?: Set<string>) {
        for (const config of this.queueConfigs) {
            if (queueNames && !queueNames.has(config.name)) continue;
            const workersCount = config.workers ?? 0;

            for (let i = 0; i < workersCount; i++) {
                this.createWorker(config.name);
            }
        }
    }

    /**
     * Register repeatable jobs (cron or interval-based) with BullMQ.
     *
     * Iterates over all registered jobs and, for those marked as scheduleable,
     * upserts a BullMQ job scheduler on the job's target queue. If the job
     * has catchUp enabled, checks whether a run was missed while the worker
     * was offline and dispatches it immediately.
     *
     * @param queueNames - Optional set of queue names to scope scheduling to.
     *                     Jobs targeting queues outside this set are skipped.
     */
    protected async scheduleRepeatableJobs(queueNames?: Set<string>) {
        const allJobs = Oxen.jobRegistry.getAllJobs();

        for (const job of allJobs) {
            if (!job.scheduleable) continue;

            const queue = job.defaultQueue
                ? Oxen.queueRegistry.getQueue(job.defaultQueue)
                : Oxen.queueRegistry.getDefaultQueue();

            if (queueNames && !queueNames.has(queue.name)) continue;

            await job.schedule();

            if (job.catchUp) {
                await this.catchUpMissedRun(job, queue);
            }
        }
    }

    /**
     * Detect and recover a missed scheduled run for a catchUp-enabled job.
     *
     * Reads the job's last-run timestamp from Redis and compares it against
     * the expected schedule (interval via `every()` or cron via `cron()`).
     * If more time has elapsed than the schedule allows, the job is dispatched
     * immediately with `_catchUp: true` metadata so handlers can distinguish
     * catch-up runs from regular ones.
     *
     * For cron jobs, the most recent past tick is computed and compared to
     * the last run. For interval jobs, a simple elapsed-time check is used.
     * If no last-run timestamp exists in Redis (first-ever run), the method
     * exits early — there is nothing to catch up on.
     *
     * @param job   - The scheduleable job instance to check.
     * @param queue - The BullMQ queue the job is registered on (used for context).
     */
    protected async catchUpMissedRun(job: IOxenJob, queue: Queue) {
        const lastRunStr = await this.redis.get(
            `${OxenJob.LAST_RUN_PREFIX}${job.name}`,
        );
        if (!lastRunStr) return;

        const lastRun = Number(lastRunStr);
        const now = Date.now();

        const catchUpData = {
            _catchUp: true,
            _scheduledFor: new Date(lastRun).toISOString(),
        };

        let intervalMs: number | null = null;
        let cron: string | null = null;

        const everyMs = job.every();
        if (everyMs) {
            intervalMs = everyMs;
        } else {
            cron = job.cron();
        }

        if (cron) {
            const interval = CronExpressionParser.parse(cron, { tz: "UTC" });
            const prev = interval.prev().getTime();

            if (lastRun < prev) {
                console.log(
                    `Catch-up: ${job.name} missed run at ${new Date(prev).toISOString()}, dispatching now`,
                );

                await job.dispatch({
                    ...catchUpData,
                    _scheduledFor: new Date(prev).toISOString(),
                });
            }
            return;
        }

        if (intervalMs) {
            const shouldHaveRun = now - lastRun > intervalMs;

            if (shouldHaveRun) {
                console.log(
                    `Catch-up: ${job.name} missed run (last: ${new Date(lastRun).toISOString()}), dispatching now`,
                );

                await job.dispatch(catchUpData);
            }
        }
    }

    /**
     * Spawn a single BullMQ Worker for a given queue.
     *
     * The worker's processor resolves the job handler from the global job
     * registry by name, enforces an optional `_deadline` TTL, then delegates
     * to the handler's `handle()` method. Errors flagged in the handler's
     * `unrecoverableErrors` list are wrapped in BullMQ's `UnrecoverableError`
     * so they are not retried.
     *
     * Configures a custom `backoffStrategy` that delegates to the handler's
     * `backoff()` method, allowing per-job retry timing.
     *
     * Lifecycle listeners:
     * - **completed** — logs the result, increments per-worker stats in Redis,
     *   records the last-run timestamp for catchUp-enabled scheduleable jobs,
     *   and invokes the handler's optional `complete()` hook.
     * - **failed** — invokes the handler's `fail()` hook and appends an error
     *   trace to the BullMQ job log.
     *
     * @param queueName - The name of the queue this worker will consume from.
     * @returns The created BullMQ Worker instance.
     */
    protected createWorker(queueName: string) {
        const worker = new Worker(
            queueName,
            async (job: Job) => {
                const handler = Oxen.jobRegistry.getJob(job.name);
                if (!handler) {
                    throw new Error(
                        `No handler registered for job "${job.name}"`,
                    );
                }
                if (job.data?._deadline && Date.now() > job.data._deadline) {
                    throw new UnrecoverableError(
                        `Job "${job.name}" was not processed before its deadline of ${new Date(job.data._deadline).toISOString()}`,
                    );
                }
                try {
                    handler.setBullJob(job);
                    return await handler.handle(job.data);
                } catch (error: any) {
                    await job.log(`${error.name}\n${error.stack}`);
                    const isUnrecoverable = handler.unrecoverableErrors.some(
                        (errClass) => error instanceof errClass,
                    );
                    if (isUnrecoverable) {
                        throw new UnrecoverableError(error.message);
                    }
                    throw error;
                }
            },
            {
                connection: this.connectionConfig,
                settings: {
                    backoffStrategy: (attemptsMade, _type, err, job) => {
                        if (!job) return -1;
                        const handler = Oxen.jobRegistry.getJob(job.name);

                        if (!handler) return -1;

                        return handler.backoff(attemptsMade, err) ?? -1;
                    },
                },
            },
        );

        worker.on("completed", async (job) => {
            console.log(`Job ${job.id} (${job.name}) completed`);
            await this.redis.hincrby(
                this.WORKER_STATS_KEY,
                `${queueName}:${worker.id}`,
                1,
            );

            // Track last run for scheduleable catchUp jobs
            const handler = Oxen.jobRegistry.getJob(job.name);
            if (handler?.scheduleable && handler?.catchUp) {
                await this.redis.set(
                    `${OxenJob.LAST_RUN_PREFIX}${job.name}`,
                    Date.now().toString(),
                );
            }

            if (handler?.complete) {
                await handler.complete(job.returnvalue);
            }
        });

        worker.on("failed", async (job, err) => {
            if (!job) {
                console.error(`Unknown job failed:`, err.message);
                return;
            }

            const handler = Oxen.jobRegistry.getJob(job.name);

            if (!handler) {
                throw new UnrecoverableError(
                    `No handler registered for job "${job.name}"`,
                );
            }

            handler.fail(err, job);

            // Log error trace on the job
            await job.log(
                `[Attempt ${job.attemptsMade}] ${err.message}\n${err.stack}`,
            );
        });

        return worker;
    }

    /**
     * Subscribe to BullMQ "removed" events on every configured queue to
     * clean up the Redis deduplication key for the removed job.
     *
     * When a job is removed (manually, by auto-removal policy, or via the
     * dashboard), its `JOB_ID_PREFIX:<jobId>` key is deleted from Redis so
     * a future dispatch with the same logical id is no longer blocked.
     */
    protected listenForRemovals() {
        for (const config of this.queueConfigs) {
            const queueEvents = new QueueEvents(config.name, {
                connection: this.connectionConfig,
            });
            queueEvents.on("removed", async ({ jobId }) => {
                await this.redis.del(`${OxenJob.JOB_ID_PREFIX}${jobId}`);
            });
        }
    }
}
