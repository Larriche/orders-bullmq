/**
 * Events Poller
 *
 * Polls the external event service for domain events (order placed, product
 * restocked, shipping updates) and dispatches corresponding BullMQ jobs.
 *
 * Each event type is mapped to a specific job class. Events are fetched in
 * batches, dispatched sequentially and then deleted from the event service. 
 * If any dispatch fails, the error is caught before deletion, so unprocessed
 * events are retried on the next polling cycle.
 *
 * Idempotency is guaranteed by the jobs themselves — each job defines an
 * id() method that derives a deterministic job ID from the event data,
 * so duplicate events result in deduplicated BullMQ jobs.
 */

import { jobs } from "../config/jobs";
import { queues } from "../config/queues";
import connection from "../connection";
import { StartOrderProcessing } from "../jobs/StartOrderProcessing";
import { RestockProduct } from "../jobs/RestockProduct";
import { UpdateShippingStatus } from "../jobs/UpdateShippingStatus";
import { OrderStatus } from "../../models/Order/types";
import { Oxen } from "../oxen-lib/Oxen";

const POLL_INTERVAL_MS = 1000;
const PAGE_SIZE = 50;
const EVENT_SERVICE_URL = process.env.EVENT_SERVICE_URL || "http://event-service:4040";

const oxen = new Oxen(connection, queues, jobs);
oxen.bootstrap();

/** Fetch a page of unprocessed events from the event service */
async function fetchEvents(page: number, limit: number): Promise<{ events: any[]; total: number }> {
    const res = await fetch(
        `${EVENT_SERVICE_URL}/events?page=${page}&limit=${limit}`,
    );
    if (!res.ok) throw new Error(`Failed to fetch events: ${res.status}`);
    return res.json() as Promise<{ events: any[]; total: number }>;
}

/** Soft-delete processed events from the event service so they are not re-fetched */
async function deleteProcessedEvents(ids: string[]) {
    const res = await fetch(`${EVENT_SERVICE_URL}/events/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error(`Failed to delete events: ${res.status}`);
}

/** Main polling loop: fetch events, dispatch jobs, then delete processed events */
async function pollEvents() {
    try {
        const { events, total } = await fetchEvents(1, PAGE_SIZE);

        if (!events.length) {
            return;
        }

        for (const event of events) {
            if (event.type === "order_placed") {
                await StartOrderProcessing.dispatch({
                    ...event.data,
                    event_id: event.id,
                });
            }

            if (event.type === "product_restocked") {
                await RestockProduct.dispatch({
                    ...event.data,
                    event_id: event.id,
                });
            }

            if (event.type === "order_shipped" || event.type === "order_delivered") {
                const statusMap: Record<string, OrderStatus.Shipped | OrderStatus.Delivered> = {
                    order_shipped: OrderStatus.Shipped,
                    order_delivered: OrderStatus.Delivered,
                };

                await UpdateShippingStatus.dispatch({
                    order_id: event.data.order_id,
                    new_status: statusMap[event.type],
                    shipment_id: event.data.shipment_id,
                    event_id: event.id,
                });
            }
        }

        await deleteProcessedEvents(events.map((e: any) => e.id));
        console.log(`Processed ${events.length} event(s) — ${total} remaining\n`);
    } catch (err) {
        console.error("Error polling events:", err);
    }
}

console.log(
    `Events poller started — polling every ${POLL_INTERVAL_MS / 1000}s (service: ${EVENT_SERVICE_URL})`,
);

// Poll immediately
pollEvents();

// Then keep polling on interval
setInterval(pollEvents, POLL_INTERVAL_MS);
