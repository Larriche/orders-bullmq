/**
 * Queue Configuration
 *
 * Defines all BullMQ queues used by the application. Each queue is backed by
 * a dedicated worker process (see src/run/*-worker.ts). The "default" queue
 * acts as the fallback for jobs that don't specify a target queue.
 */

import { QueueConfig } from "../oxen-lib/Oxen";

export const queues: QueueConfig[] = [
      {
        name: 'default',
        workers: 1,
        default: true,
    },
    {
        name: 'orders',
        workers: 1,
        default: false,
    },
    {
        name: 'notifications',
        workers: 1,
        default: false,
    },
    {
        name: 'payments',
        workers: 1,
        default: false,
    },
    {
        name: "scheduled-jobs-queue",
        workers: 1,
        default: false,
    },
]