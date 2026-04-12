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

### Main App (Docker: `app`)

The core application. Runs multiple PM2-managed processes:

| Process              | Description                                                                 |
|----------------------|-----------------------------------------------------------------------------|
| `orders-worker`      | Processes the `orders` queue (order creation, stock checks)                |
| `payments-worker`    | Processes the `payments` queue (payment charges via payment service SDK)    |
| `notifications-worker` | Processes the `notifications` queue (emails, post-delivery messages)     |
| `default-worker`     | Catches jobs not assigned to a specific queue                              |
| `scheduled-worker`   | Runs repeatable/cron jobs (e.g. restocking, shipping status updates)       |
| `events-poller`      | Polls the Event Service for new domain events and dispatches matching jobs |
| `outbox-poller`      | Polls the MongoDB outbox collection and dispatches pending BullMQ jobs     |
| `board`              | [Bull Board](https://github.com/felixmosh/bull-board) dashboard on port 3000 |

### Event Service (Docker: `event-service`, port 4040)

An Express server that simulates an external event source. It connects to MongoDB, watches for new orders and customers, and stores events in a local SQLite database. The main app's `events-poller` fetches these events via HTTP.

### Fake Payment Service (Docker: `payment-service`, port 4000)

A simple Express server that simulates a payment gateway. Supports configurable modes (`normal`, `maintenance`, `error`, `slow`, `insufficient-funds`, `unauthorized`) to test retry strategies and error handling.

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
   This spins up Redis, a MongoDB replica set (2 nodes), the event service, the payment service, and the main app container.

5. **Start the workers**
   ```bash
   npm run pm2:start
   ```

6. **Open Bull Board** at [http://localhost:3000](http://localhost:3000) to monitor queues and jobs.

### Useful Commands

| Command              | Description                                    |
|----------------------|------------------------------------------------|
| `npm run docker:up`  | Start all Docker services                      |
| `npm run docker:down`| Stop all Docker services                       |
| `npm run docker:nuke`| Tear down volumes and rebuild from scratch     |
| `npm run docker:rebuild` | Rebuild the app container only             |
| `npm run pm2:start`  | Start all PM2 processes inside the app container |
| `npm run pm2:stop`   | Stop all PM2 processes                         |
| `npm run pm2:logs`   | Tail PM2 logs                                  |
| `npm run pm2:list`   | List running PM2 processes                     |
| `npm run pm2:restart`| Restart all PM2 processes                      |
| `npm run logs`       | Tail Docker logs for the app container         |
| `npm run build`      | Compile TypeScript (runs inside the container) |

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
│   ├── run/               # PM2 entry points (workers, pollers, board)
│   ├── db/                # MongoDB connection
│   └── payment-service-sdk/  # HTTP client for the payment service
├── models/                # Mongoose models (Customer, Order, Product, etc.)
├── event-service/         # External event source (Express + SQLite)
├── fake-payment-service/  # Simulated payment gateway
├── orders-bullmq-docker/  # Docker configs
├── pm2.json               # PM2 process definitions
└── package.json
```

## License

ISC
