/**
 * Central registry that maps queue names to their BullMQ Queue instances
 * and configuration.
 *
 * Populated at bootstrap from the application's queue config. Used by
 * OxenJob.dispatch() to resolve target queues by name, and by Oxen to
 * create workers for each registered queue.
 *
 * Exactly one queue must be marked as the default — it serves as the
 * fallback for jobs that don't specify a target queue or whose outbox
 * entry has a null queue.
 *
 * Once marked as completed, no further registrations are accepted.
 */

import { Queue } from "bullmq";
import { QueueConfig } from "./Oxen";

export type QueueRegistryEntry = {
    config: QueueConfig;
    queue: Queue;
}

export class QueueRegistry {
    private registry: Map<string, QueueRegistryEntry> = new Map();
    private _completed: boolean = false;

    public get completed(): boolean {
        return this._completed;
    }

    public markCompleted(): void {
        this._completed = true;
    }

    public registerQueue(config: QueueConfig, queue: Queue) {
        if (this._completed) return;
        if (this.registry.has(config.name)) return;

        this.registry.set(config.name, { config, queue });
    }

    public getQueue(queueName: string): Queue {
        const entry = this.registry.get(queueName);
        if (!entry) {
            throw new Error(`Queue "${queueName}" not found in registry`);
        }
        return entry.queue;
    }

    public getConfig(queueName: string): QueueConfig {
        const entry = this.registry.get(queueName);
        if (!entry) {
            throw new Error(`Queue "${queueName}" not found in registry`);
        }
        return entry.config;
    }

    public getDefaultQueue(): Queue {
        for (const entry of this.registry.values()) {
            if (entry.config.default) {
                return entry.queue;
            }
        }
        throw new Error("No default queue configured in registry");
    }
}