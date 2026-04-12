/**
 * Central registry that maps job names to their constructors.
 *
 * Populated at bootstrap with all job classes defined in the application config.
 * Used by workers to resolve incoming BullMQ job names to handler instances,
 * and by the outbox poller to instantiate jobs for dispatch.
 *
 * Once marked as completed, no further registrations are accepted — this
 * prevents accidental late additions after workers have started.
 */

import { IOxenJob, IOxenJobConstructor } from "./types/job.types";

export class JobsRegistry {
    private jobsRegistry: Map<string, IOxenJobConstructor> = new Map();
    private _completed: boolean = false;

    public get completed(): boolean {
        return this._completed;
    }

    public markCompleted(): void {
        this._completed = true;
    }

    public registerJob(JobConstructor: IOxenJobConstructor) {
        if (this._completed) return;
        const name = new JobConstructor().name;
        if (this.jobsRegistry.has(name)) return;

        this.jobsRegistry.set(name, JobConstructor);
    }

    public getJob(jobName: string): IOxenJob {
        const JobConstructor = this.jobsRegistry.get(jobName);
        if (!JobConstructor) {
            throw new Error(`Job "${jobName}" not found in registry`);
        }
        return new JobConstructor();
    }

    public getAllJobs(): IOxenJob[] {
        return Array.from(this.jobsRegistry.values()).map((C) => new C());
    }
}