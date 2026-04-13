# Event Service

A fake event source that generates domain events (order placed, shipped, delivered, product restocked) and stores them in SQLite. The main application polls this service for new events and dispatches corresponding BullMQ jobs.

Products and customers are seeded into MongoDB on first startup. Events are generated either automatically on a timer or manually via the trigger endpoint.

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `MONGO_URI` | — (required) | MongoDB connection string |
| `PORT` | `4040` | HTTP port |
| `DATA_DIR` | `./data` | Directory for the SQLite database file |

## Generation Modes

| Mode | Description |
|---|---|
| `stopped` | No automatic generation. Events are only created via `/events/trigger`. This is the default. |
| `auto` | Events are generated on a recurring timer based on the current config. |

## Endpoints

### `GET /status`

Returns the current mode, config, and whether auto-generation is active.

**Response:**

```json
{
  "mode": "stopped",
  "config": {
    "interval": 5000,
    "maxPerCycle": 100,
    "rates": {
      "order_placed": 100,
      "order_shipped": -1,
      "order_delivered": -1,
      "product_restocked": 0
    }
  },
  "autoGenerating": false
}
```

Rate values: a positive number is a hard cap per cycle, `-1` means "match the number of eligible orders in the DB", and `0` disables the type.

---

### `GET /mode`

Returns the current generation mode.

**Response:**

```json
{
  "mode": "stopped"
}
```

---

### `POST /mode`

Switch the generation mode.

**Request:**

```json
{
  "mode": "auto"
}
```

**Response:**

```json
{
  "mode": "auto",
  "message": "Mode set to \"auto\""
}
```

---

### `GET /config`

Returns the current generation config.

**Response:**

```json
{
  "interval": 5000,
  "maxPerCycle": 100,
  "rates": {
    "order_placed": 100,
    "order_shipped": -1,
    "order_delivered": -1,
    "product_restocked": 0
  }
}
```

---

### `POST /config`

Update generation config. All fields are optional.

**Request:**

```json
{
  "interval": 10000,
  "maxPerCycle": 50,
  "rates": {
    "order_placed": 20,
    "product_restocked": 5
  }
}
```

**Response:** The full updated config object (same shape as `GET /config`).

---

### `POST /order-rate`

Shorthand to update just the `order_placed` rate.

**Request:**

```json
{
  "amount": 30
}
```

**Response:**

```json
{
  "order_placed": 30
}
```

---

### `POST /events/trigger`

Manually generate events, regardless of the current mode.

**Request:**

```json
{
  "type": "order_placed",
  "count": 3
}
```

Both fields are optional. If `type` is omitted a random type is chosen. `count` defaults to `1` (max `1000`).

Valid types: `order_placed`, `order_shipped`, `order_delivered`, `product_restocked`.

**Response:**

```json
{
  "generated": 3,
  "events": [
    {
      "id": "a1b2c3d4-...",
      "type": "order_placed",
      "timestamp": "2026-04-13T12:00:00.000Z",
      "data": {
        "customer_email": "jane@example.com",
        "customer_name": "Jane Doe",
        "customer_phone": "555-0123",
        "payment_email": "jane@example.com",
        "product": "AB12CD34",
        "quantity": 3,
        "total_amount": 149.97,
        "shipping_address": "123 Main St, Springfield, IL 62704",
        "placed_at": "2026-04-13T12:00:00.000Z"
      }
    }
  ]
}
```

---

### `GET /events`

Fetch unprocessed events. Used by the events poller.

**Query params:**

| Param | Default | Description |
|---|---|---|
| `page` | `1` | Page number |
| `limit` | `20` | Events per page (max `1000`) |

**Response:**

```json
{
  "events": [
    {
      "id": "a1b2c3d4-...",
      "type": "order_placed",
      "timestamp": "2026-04-13T12:00:00.000Z",
      "data": {
        "customer_email": "jane@example.com",
        "customer_name": "Jane Doe",
        "customer_phone": "555-0123",
        "payment_email": "jane@example.com",
        "product": "AB12CD34",
        "quantity": 3,
        "total_amount": 149.97,
        "shipping_address": "123 Main St, Springfield, IL 62704",
        "placed_at": "2026-04-13T12:00:00.000Z"
      }
    },
    {
      "id": "e5f6a7b8-...",
      "type": "order_shipped",
      "timestamp": "2026-04-13T12:01:00.000Z",
      "data": {
        "order_id": "6612f1a2b3c4d5e6f7a8b9c0",
        "shipment_id": "XK9Q3R7TM2PL"
      }
    },
    {
      "id": "c9d0e1f2-...",
      "type": "order_delivered",
      "timestamp": "2026-04-13T12:02:00.000Z",
      "data": {
        "order_id": "6612f1a2b3c4d5e6f7a8b9c0"
      }
    },
    {
      "id": "d3e4f5a6-...",
      "type": "product_restocked",
      "timestamp": "2026-04-13T12:03:00.000Z",
      "data": {
        "product_code": "AB12CD34",
        "quantity": 50
      }
    }
  ],
  "total": 42
}
```

> **Note:** This endpoint intentionally re-includes up to 3 already-sent events to simulate duplicates. The consuming application is expected to handle deduplication.

---

### `POST /events/delete`

Soft-delete processed events so they are no longer returned by `GET /events`.

**Request:**

```json
{
  "ids": ["a1b2c3d4-...", "e5f6a7b8-..."]
}
```

**Response:**

```json
{
  "deleted": 2
}
```

## Event Data Shapes

Summary of the `data` field for each event type:

### `order_placed`

```json
{
  "customer_email": "jane@example.com",
  "customer_name": "Jane Doe",
  "customer_phone": "555-0123",
  "payment_email": "jane@example.com",
  "product": "AB12CD34",
  "quantity": 3,
  "total_amount": 149.97,
  "shipping_address": "123 Main St, Springfield, IL 62704",
  "placed_at": "2026-04-13T12:00:00.000Z"
}
```

### `order_shipped`

```json
{
  "order_id": "6612f1a2b3c4d5e6f7a8b9c0",
  "shipment_id": "XK9Q3R7TM2PL"
}
```

### `order_delivered`

```json
{
  "order_id": "6612f1a2b3c4d5e6f7a8b9c0"
}
```

### `product_restocked`

```json
{
  "product_code": "AB12CD34",
  "quantity": 50
}
```
