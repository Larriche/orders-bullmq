/**
 * Application-level base job class defined by the client of oxen-lib.
 *
 * Extends OxenJob to plug in the MongoOutboxDispatcher, so all jobs
 * in this application can use `.viaOutbox(session).dispatch(data)`
 * without individually configuring an outbox dispatcher.
 *
 * Other oxen-lib consumers would define their own BaseJob with a
 * different dispatcher (e.g., PostgresOutboxDispatcher).
 */

import { OxenJob } from "../oxen-lib/OxenJob";
import { MongoOutboxDispatcher } from "../outbox/OutboxDispatcher";

export class BaseJob<TData = unknown> extends OxenJob<TData> {
    public outboxDispatcher = new MongoOutboxDispatcher();
}
