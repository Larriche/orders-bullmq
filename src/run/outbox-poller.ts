import { jobs } from "../config/jobs";
import { queues } from "../config/queues";
import connection from "../connection";
import { connectDB } from "../db/connection";
import { Oxen } from "../oxen-lib/Oxen";
import { OutboxEvent } from "../../models/OutboxEvent/schema";
import { OutboxEventStatus } from "../../models/OutboxEvent/types";

const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS) || 1000;
const BATCH_SIZE = Number(process.env.OUTBOX_BATCH_SIZE) || 50;

const oxen = new Oxen(connection, queues, jobs);
oxen.bootstrap();

/**
 * Outbox Poller
 *
 * Polls the OutboxEvents collection for pending or failed events and dispatches
 * them as BullMQ jobs. This is the relay component of the transactional outbox
 * pattern — job handlers write outbox entries atomically within their DB
 * transactions, and this poller picks them up and forwards them to the
 * appropriate BullMQ queues.
 *
 * Events are processed in order of desiredProcessingTime (most urgent first).
 * If an event's desiredProcessingTime is in the future, the job is dispatched
 * with a calculated delay so BullMQ holds it until the right time.
 *
 * Each event is marked as "processed" on success or "failed" on error.
 * Failed events are retried on subsequent polling cycles. Idempotent job ids
 * prevent duplicated job enqueuing in case of retries.
 */

async function pollOutbox() {
    try {
        // Fetch pending and failed outbox events, prioritized by desired processing time
        const events = await OutboxEvent.find({
            status: { $in: [OutboxEventStatus.Pending, OutboxEventStatus.Failed] },
        })
            .sort({ desiredProcessingTime: 1 })
            .limit(BATCH_SIZE);

        if (!events.length) return;

        for (const event of events) {
            try {
                // Resolve the job class from the registry using the stored job name
                const job = Oxen.jobRegistry.getJob(event.jobName);

                // Calculate delay: if desiredProcessingTime is in the future,
                // dispatch with a delay so BullMQ defers execution until then.
                // Otherwise, dispatch immediately.
                const now = Date.now();
                const desiredTime = event.desiredProcessingTime.getTime();
                const delay = desiredTime > now ? desiredTime - now : 0;

                // Override the target queue if explicitly specified on the event,
                // otherwise the job's defaultQueue is used
                if (event.queue) {
                    job.onQueue(event.queue);
                }

                if (delay > 0) {
                    job.delay(delay);
                }

                // Dispatch the job to BullMQ via the normal dispatch path
                await job.dispatch(event.jobData);

                // Mark the outbox event as processed
                await OutboxEvent.updateOne(
                    { _id: event._id },
                    {
                        status: OutboxEventStatus.Processed,
                        processedAt: new Date(),
                    },
                );
            } catch (err) {
                // Mark as failed — will be retried on the next polling cycle
                console.error(
                    `Failed to process outbox event ${event._id} (${event.jobName}):`,
                    err,
                );

                await OutboxEvent.updateOne(
                    { _id: event._id },
                    { status: OutboxEventStatus.Failed },
                );
            }
        }

        console.log(`Outbox: dispatched ${events.length} event(s)`);
    } catch (err) {
        console.error("Error polling outbox:", err);
    }
}

async function start() {
    await connectDB();

    console.log(
        `Outbox poller started — polling every ${POLL_INTERVAL_MS / 1000}s`,
    );

    pollOutbox();
    setInterval(pollOutbox, POLL_INTERVAL_MS);
}

start();
