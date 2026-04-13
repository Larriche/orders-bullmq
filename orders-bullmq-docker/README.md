# Orders BullMQ Docker

Local development environment running MongoDB (replica set), Redis, and the application services via Docker Compose. Each worker, poller, and dashboard runs in its own container.

## Services

| Service | Port | Description |
|---|---|---|
| `mongodb1` | `27017` | MongoDB primary |
| `mongodb2` | `27018` | MongoDB secondary |
| `redis` | `6379` | Redis |
| `payment-service` | `4000` | Fake payment gateway |
| `event-service` | `4040` | Event source (SQLite + MongoDB) |
| `board` | `3000` | Bull Board dashboard |
| `default-worker` | — | Default queue worker |
| `orders-worker` | — | Orders queue worker (2 replicas) |
| `notifications-worker` | — | Notifications queue worker (3 replicas) |
| `payments-worker` | — | Payments queue worker |
| `scheduled-worker` | — | Scheduled/cron jobs worker |
| `events-poller` | — | Polls event service for domain events |
| `outbox-poller` | — | Polls MongoDB outbox collection |

MongoDB runs as a two-node replica set (`rs0`) required for Mongoose transactions. The `mongo-init-replica` container runs once on first start to initialise the replica set and then exits.

## Prerequisites

Generate the MongoDB keyfile before starting for the first time:

```bash
openssl rand -base64 756 > orders-bullmq-docker/mongo-keyfile
chmod 400 orders-bullmq-docker/mongo-keyfile
```

> **Note:** Do NOT `chown 999:999` the keyfile on macOS — Docker Desktop handles permission mapping. Changing ownership to 999 will make the file unreadable on your host and cause Docker build failures. Only use `chown 999:999` on Linux hosts.

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

## Running

All commands below are run from the **project root**.

**Start all services:**
```bash
npm run docker:up
```

**Start and rebuild the app image (after dependency or config changes):**
```bash
npm run docker:rebuild
```

**Stop all services (preserve data volumes):**
```bash
npm run docker:down
```

**Stop all services and wipe all data:**
```bash
npm run docker:nuke
```

## Logs

**Follow logs for all containers:**
```bash
npm run logs
```

**Follow a specific service:**
```bash
docker compose -f orders-bullmq-docker/docker-compose.yml logs orders-worker -f
```

## MongoDB

**Compass connection string:**
```
mongodb://root:example@localhost:27017/?authSource=admin&directConnection=true
```

## Event Service

The event service (`http://localhost:4040`) generates order events into a SQLite database and exposes them to the app's events-poller via HTTP.

### API

**Get service status:**
```bash
curl http://localhost:4040/status
```

**Get/set mode** — `"auto"` (default) generates events on a timer; `"stopped"` halts all automatic generation:
```bash
curl http://localhost:4040/mode
curl -X POST http://localhost:4040/mode -H 'Content-Type: application/json' -d '{"mode":"stopped"}'
curl -X POST http://localhost:4040/mode -H 'Content-Type: application/json' -d '{"mode":"auto"}'
```

**Get/set generation config** — control interval, max events per cycle, and per-type rates (`-1` = auto, `0` = disabled, `>0` = fixed max):
```bash
curl http://localhost:4040/config
curl -X POST http://localhost:4040/config -H 'Content-Type: application/json' \
  -d '{"interval":10000,"maxPerCycle":50,"rates":{"order_placed":20,"product_restocked":5}}'
```

**Manually trigger events** — optionally specify `type` and `count`:
```bash
curl -X POST http://localhost:4040/events/trigger -H 'Content-Type: application/json' \
  -d '{"type":"order_placed","count":5}'
curl -X POST http://localhost:4040/events/trigger -H 'Content-Type: application/json' \
  -d '{"count":10}'
```

**Read events** (used by the poller):
```bash
curl 'http://localhost:4040/events?page=1&limit=20'
```

**Delete processed events:**
```bash
curl -X POST http://localhost:4040/events/delete -H 'Content-Type: application/json' \
  -d '{"ids":["event-id-1","event-id-2"]}'
```

## Troubleshooting

### MongoDB containers crash with "permissions on /etc/mongo-keyfile are too open"
The keyfile must have `400` permissions. Regenerate it:
```bash
openssl rand -base64 756 > orders-bullmq-docker/mongo-keyfile
chmod 400 orders-bullmq-docker/mongo-keyfile
```

### Docker build fails with "failed to xattr mongo-keyfile: permission denied"
The `.dockerignore` at the project root must exclude the keyfile from the build context. Ensure it contains:
```
orders-bullmq-docker/mongo-keyfile
```

### App container exits or won't start
Check if the `.env` file exists in the project root and contains `MONGO_URI`, `REDIS_HOST`, and `REDIS_PORT`.
