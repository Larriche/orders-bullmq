# Orders BullMQ

A WIP playground project that simulates an e-commerce order processing pipeline using [BullMQ](https://docs.bullmq.io/) and MongoDB. The primary focus is **building higher-level abstractions on top of BullMQ** to deliver an enhanced job orchestration experience — fluent dispatch APIs, declarative job definitions, and built-in support for patterns like transactional outbox, cross-queue deduplication, scheduled jobs with catch-up, and crash-safe side effects. These abstractions live in **oxen-lib**, the custom framework that wraps BullMQ and is used by the application as if it were a third-party package.

## Architecture Overview

```
┌──────────────┐     ┌──────────────┐     ┌───────────────────────────────────────┐
│ Event Service│     │   Payment    │     │              Main App                 │
│  (port 4040) │     │   Service    │     │                                       │
│  SQLite +    │     │  (port 4000) │     │  ┌─────────┐  ┌──────────────────┐   │
│  MongoDB     │     │  Express     │     │  │ Workers  │  │    Pollers       │   │
│              │     │              │     │  │ orders   │  │  events-poller   │   │
│  Generates   │◄────┤  Simulates   │     │  │ payments │  │  outbox-poller   │   │
│  order &     │     │  payment     │     │  │ notifs   │  └──────────────────┘   │
│  customer    │     │  responses   │     │  │ default  │                         │
│  events      │     │              │     │  │ scheduled│  ┌──────────────────┐   │
└──────────────┘     └──────────────┘     │  └─────────┘  │  Bull Board      │   │
                                          │               │  (port 3000)     │   │
                                          │               └──────────────────┘   │
                                          └──────────┬────────────┬──────────────┘
                                                     │            │
                                               ┌─────▼──┐   ┌────▼────┐
                                               │ Redis  │   │ MongoDB │
                                               │ (6379) │   │ Replica │
                                               │        │   │  Set    │
                                               └────────┘   └─────────┘
```

## Services

Each process runs in its own Docker container, built from a shared image. Worker services can be scaled independently via `deploy.replicas` in docker-compose or `--scale` at runtime.

| Container              | Description                                                                 | Replicas |
|------------------------|-----------------------------------------------------------------------------|----------|
| `orders-worker`        | Processes the `orders` queue (order creation, stock checks)                | 2        |
| `payments-worker`      | Processes the `payments` queue (payment charges via payment service SDK)    | 1        |
| `notifications-worker` | Processes the `notifications` queue (emails, post-delivery messages)       | 3        |
| `default-worker`       | Catches jobs not assigned to a specific queue                              | 1        |
| `scheduled-worker`     | Runs repeatable/cron jobs (e.g. restocking, shipping status updates)       | 1        |
| `events-poller`        | Polls the Event Service for new domain events and dispatches matching jobs | 1        |
| `outbox-poller`        | Polls the MongoDB outbox collection and dispatches pending BullMQ jobs     | 1        |
| `board`                | [Bull Board](https://github.com/felixmosh/bull-board) dashboard on port 3000 | 1     |

### Event Service (Docker: `event-service`, port 4040)

An Express server that simulates an external event source. It connects to MongoDB, watches for new orders and customers, and stores events in a local SQLite database. The main app's `events-poller` fetches these events via HTTP. See [event-service/README.md](event-service/README.md) for endpoint docs and sample payloads.

### Fake Payment Service (Docker: `payment-service`, port 4000)

A simple Express server that simulates a payment gateway. Supports configurable modes (`normal`, `maintenance`, `error`, `slow`, `insufficient-funds`, `unauthorized`) to test retry strategies and error handling. See [fake-payment-service/README.md](fake-payment-service/README.md) for endpoint docs and response samples.

## Jobs

| Job                              | Queue           | Description                                                   |
|----------------------------------|-----------------|---------------------------------------------------------------|
| `StartOrderProcessing`          | `orders`        | Validates stock, creates the order, dispatches payment + email|
| `ProcessPayment`                | `payments`      | Calls the payment service, handles success/failure paths      |
| `SendOrderReceivedEmail`        | `notifications` | Sends order confirmation (dispatched via outbox)              |
| `SendCustomerWelcome`           | `notifications` | Sends welcome email on first order (crash-safe via `welcomedAt`) |
| `SendInsufficientFundsNotification` | `notifications` | Notifies customer of failed payment                      |
| `SendPostDeliveryNotification`  | `notifications` | Sends post-delivery follow-up                                 |
| `UpdateShippingStatus`          | `scheduled`     | Repeatable job that advances shipping statuses                |
| `RestockProduct`                | `scheduled`     | Repeatable job that restocks low-inventory products           |

## oxen-lib

> **Work in progress** — this is an evolving abstraction layer, not a published package.

oxen-lib is a custom framework built on top of BullMQ that provides:

- **Declarative job classes** — define `handle()`, `id()`, `cron()`, `backoff()`, `unrecoverableErrors`, etc. as class properties/methods
- **Fluent dispatch API** — chain modifiers before dispatching:
  ```typescript
  await SendEmail.delay(5000).onQueue('notifications').dispatch(data);
  await ProcessPayment.viaOutbox(session).dispatch(paymentData);
  await ImportantJob.deadline(new Date('2026-01-01')).prioritize('high').dispatch(data);
  ```
- **Transactional outbox support** — `viaOutbox(session)` writes an outbox entry inside your MongoDB transaction instead of dispatching to BullMQ directly, guaranteeing atomicity
- **Cross-queue deduplication** — Redis-based dedup that works across all queues, not just per-queue
- **Scheduled jobs with catch-up** — cron/interval jobs that detect missed runs and dispatch them on startup
- **Queue & job registries** — centralized registry with bootstrap lifecycle (setup once, share everywhere)
- **Custom backoff strategies** — per-job backoff logic delegated from the BullMQ worker
- **Job deadlines** — reject jobs that weren't processed before a given timestamp

The framework lives in `src/oxen-lib/` and is used as if it were a third-party package — the application code in `src/jobs/` extends `BaseJob` (which extends `OxenJob`) and overrides only what it needs.

### Transactional Outbox Pattern

When a job handler needs to write to the database **and** dispatch follow-up jobs, there's a classic dual-write problem: if the DB transaction commits but the BullMQ dispatch fails (or vice versa), data and jobs go out of sync. oxen-lib solves this with a built-in transactional outbox.

**How it works:**

oxen-lib defines an `IOutboxDispatcher` interface that abstracts the persistence layer. The client application provides a concrete implementation for its database of choice. In this project, that's a `MongoOutboxDispatcher` that writes to the `OutboxEvents` collection.

1. Instead of dispatching directly to BullMQ, the job writes an outbox entry **inside the same database transaction** as its domain changes using `viaOutbox(transactionContext)`:
   ```typescript
   await SendOrderReceivedEmail.viaOutbox(session).dispatch(emailData);
   await ProcessPayment.viaOutbox(session).dispatch(paymentData);
   ```
   The `session` (or whatever transaction handle your DB uses) is forwarded to the dispatcher so the outbox write is atomic with the domain write.

2. A separate **outbox poller** (`src/run/outbox-poller.ts`) continuously polls for pending entries and dispatches them as BullMQ jobs. If an entry has a `desiredProcessingTime` in the future, the job is dispatched with a calculated delay.

3. Failed dispatches are marked as `"failed"` and retried on the next polling cycle. Deterministic job IDs (from each job's `id()` method) prevent duplicate enqueuing.

**Architecture:**

```
Job Handler (within transaction)
  ├── Write domain data
  └── Write outbox entry (same transaction, via IOutboxDispatcher)
                │
                ▼
        Outbox store (e.g. OutboxEvents collection)
                │
                ▼
        Outbox Poller (polls every 1s)
                │
                ▼
      BullMQ Queue (dispatched job)
```

## Getting Started

### Prerequisites

- [Docker](https://www.docker.com/) and Docker Compose
- [Node.js](https://nodejs.org/) (v18+)

### Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/<your-username>/orders-bullmq.git
   cd orders-bullmq
   ```

2. **Create a `.env` file** in the project root:
   ```env
   MONGO_URI=mongodb://root:example@mongodb1:27017/orders-bullmq?replicaSet=rs0&authSource=admin
   REDIS_HOST=redis
   REDIS_PORT=6379
   ```

3. **Generate the MongoDB replica set keyfile**
   ```bash
   openssl rand -base64 756 > orders-bullmq-docker/mongo-keyfile
   chmod 400 orders-bullmq-docker/mongo-keyfile
   ```
   > **macOS note:** Do _not_ `chown 999:999` the keyfile — Docker Desktop handles permission mapping automatically. Only use `chown 999:999` on Linux hosts.

4. **Start all services**
   ```bash
   npm run docker:up
   ```
   This spins up Redis, a MongoDB replica set (2 nodes), the event service, the payment service, all workers, both pollers, and the Bull Board dashboard.

5. **Open Bull Board** at [http://localhost:3000](http://localhost:3000) to monitor queues and jobs.

### Generating Events

The event service starts in **stopped** mode — no events are generated automatically. You can get started by manually triggering a few orders:

```bash
# Trigger a single order_placed event
curl -X POST http://localhost:4040/events/trigger -H 'Content-Type: application/json' -d '{"type": "order_placed", "count": 1}'
```

To enable continuous automatic generation, switch the event service to **auto** mode:

```bash
curl -X POST http://localhost:4040/mode -H 'Content-Type: application/json' -d '{"mode": "auto"}'
```

The event service also monitors product stock levels and automatically generates `product_restocked` events when stock drops below a threshold.

See [event-service/README.md](event-service/README.md) for the full API reference.

### Useful Commands

| Command              | Description                                    |
|----------------------|------------------------------------------------|
| `npm run docker:up`  | Start all Docker services                      |
| `npm run docker:down`| Stop all Docker services                       |
| `npm run docker:nuke`| Tear down volumes and rebuild from scratch     |
| `npm run docker:rebuild` | Rebuild the app image only                 |
| `npm run docker:scale` | Scale a service (e.g. `-- orders-worker=5`)  |
| `npm run logs`       | Tail Docker logs for all containers            |
| `npm run build`      | Compile TypeScript locally                     |
| `npm run black-friday` | Crank up order generation to 500/cycle       |

### Simulating Payment Failures

The fake payment service supports mode switching:

```bash
# Set to insufficient-funds mode
curl -X POST http://localhost:4000/mode -H 'Content-Type: application/json' -d '{"mode": "insufficient-funds"}'

# Set back to normal
curl -X POST http://localhost:4000/mode -H 'Content-Type: application/json' -d '{"mode": "normal"}'
```

Available modes: `normal`, `maintenance`, `error`, `slow`, `insufficient-funds`, `unauthorized`.

## Project Structure

```
├── src/
│   ├── oxen-lib/          # BullMQ framework (WIP)
│   │   ├── Oxen.ts        # Main orchestrator (bootstrap, workers, schedulers)
│   │   ├── OxenJob.ts     # Base job class with fluent dispatch API
│   │   ├── JobsRegistry.ts
│   │   ├── QueuesRegistry.ts
│   │   └── types/         # Interfaces (job, outbox)
│   ├── jobs/              # Application job classes
│   ├── outbox/            # MongoDB outbox dispatcher
│   ├── config/            # Queue and job registration
│   ├── run/               # Container entry points (workers, pollers, board)
│   ├── db/                # MongoDB connection
│   └── payment-service-sdk/  # HTTP client for the payment service
├── models/                # Mongoose models (Customer, Order, Product, etc.)
├── event-service/         # External event source (Express + SQLite)
├── fake-payment-service/  # Simulated payment gateway
├── orders-bullmq-docker/  # Docker configs
└── package.json
```

## Todo

- [ ] **Job retention periods** — allow oxen-lib job definitions to specify how long completed/failed jobs are kept in Redis before being auto-removed
- [ ] **Reversible jobs (`reverse()`)** — allow job classes to define an undo action so a job can be rolled back after completion (e.g. refund a payment, restore stock)
- [ ] **Rate limiting** — allow oxen-lib job definitions to declare per-job rate limits (e.g. "max 10 per minute")
- [ ] **Batch dispatch** — `dispatchMany(items[])` to efficiently enqueue multiple jobs in a single Redis round-trip
- [ ] **Automatic job chaining** — declaratively define multi-step pipelines where completing one job automatically dispatches the next
- [ ] **Configurable dead letter queues** — BullMQ's failed state acts as a basic DLQ since failed jobs sit idle and aren't reprocessed, but it's not a real queue — you can't attach a worker to it. Allow jobs to declare a `deadLetterQueue` so that after max retries the job is re-enqueued to a dedicated queue where a separate worker can handle it (alert, log, compensate, etc.)
- [ ] **Job progress tracking** — expose BullMQ's built-in progress reporting via a typed `progress()` API so long-running jobs can report incremental progress visible in Bull Board
- [ ] **Job data validation** — allow jobs to define a `validate()` method for their input data. For `dispatch()`, validation runs at processing time. Later, when a manual enqueuing API is added validation will run before the job is enqueued
- [ ] **Saga orchestration** — define a sequence of jobs as a saga so that if step N fails, steps N-1 through 1 are automatically reversed in order using each job's `reverse()` action
- [ ] **Lifecycle hooks** — support `beforeHandle()`, `afterHandle()`, and `onFailed()` hooks for cross-cutting concerns like logging, metrics, and audit trails without polluting job logic
- [ ] **Job stats tracking** — collect per-job metrics (processing time, success/failure counts, retry rates, queue wait time) and expose them via an API or dashboard
- [ ] **Job dependencies** — declare that a job should not run until one or more other jobs have completed, and support parent jobs that dispatch child jobs mid-execution and wait for them to finish before proceeding, leveraging BullMQ's flow producer under the hood

## License

ISC
