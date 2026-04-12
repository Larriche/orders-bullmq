import { ClientSession } from "mongoose";
import { IOutboxDispatcher, OutboxEntry } from "../oxen-lib/types/outbox.types";
import { OutboxEvent } from "../../models/OutboxEvent/schema";
import { OutboxEventStatus } from "../../models/OutboxEvent/types";

/**
 * MongoDB implementation of the IOutboxDispatcher interface from oxen-lib.
 *
 * This is the application-specific adapter that persists outbox entries to the
 * OutboxEvents MongoDB collection. When a job is dispatched via the outbox
 * pattern (e.g., `SendOrderReceivedEmail.viaOutbox(session).dispatch(data)`),
 * oxen-lib builds a storage-agnostic OutboxEntry and delegates to this class
 * to save it.
 *
 * The transactionContext parameter is expected to be a Mongoose ClientSession,
 * allowing the outbox entry to be written atomically within the caller's
 * transaction. This guarantees that the outbox entry only exists if the
 * associated domain changes (order creation, status update, etc.) also commit.
 *
 * A separate outbox poller process reads pending entries and dispatches them
 * as BullMQ jobs.
 */
export class MongoOutboxDispatcher implements IOutboxDispatcher {
    /**
     * Persist an outbox entry to MongoDB within an optional transaction.
     *
     * @param entry - The outbox entry prepared by oxen-lib (job name, data, queue, desired processing time)
     * @param transactionContext - In this case, a Mongoose ClientSession to allow atomic writes within the caller's transaction
     * @returns void
     */
    public async save(entry: OutboxEntry, transactionContext: ClientSession): Promise<void> {
        const session = transactionContext;

        await OutboxEvent.create(
            [
                {
                    eventId: entry.eventId,
                    jobName: entry.jobName,
                    jobData: entry.jobData,
                    queue: entry.queue,
                    status: OutboxEventStatus.Pending,
                    desiredProcessingTime: entry.desiredProcessingTime,
                    processedAt: null,
                },
            ],
            { session },
        );
    }
}
