# Fake Payment Service

A simple Express server that simulates a payment gateway. Supports configurable failure modes to test retry strategies, error handling, and timeout behaviour in the main application.

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | HTTP port |

## Modes

The service starts in `normal` mode. Switch modes at runtime via `POST /mode`.

| Mode | Status | Behaviour |
|---|---|---|
| `normal` | `200` | All payments succeed immediately |
| `maintenance` | `503` | Returns `SERVICE_UNAVAILABLE` for every request |
| `error` | `500` | Returns `INTERNAL_SERVER_ERROR` for every request |
| `slow` | `200`/`504` | 60% chance of a 30–60s delay then timeout, 40% chance of a 3–8s delay then success |
| `insufficient-funds` | `400` | Returns `INSUFFICIENT_FUNDS` for every request |
| `unauthorized` | `401` | Returns `UNAUTHORIZED` for every request |

## Endpoints

### `GET /mode`

Returns the current mode.

**Response:**

```json
{
  "mode": "normal"
}
```

---

### `POST /mode`

Switch the service mode.

**Request:**

```json
{
  "mode": "insufficient-funds"
}
```

**Response:**

```json
{
  "message": "Mode set to \"insufficient-funds\""
}
```

---

### `POST /payments/charge`

Process a payment.

**Request:**

```json
{
  "orderId": "6612f1a2b3c4d5e6f7a8b9c0",
  "amount": 149.97,
  "email": "jane@example.com"
}
```

**Response (normal / slow-success):**

```json
{
  "status": "success",
  "transactionId": "txn_1713024000000",
  "orderId": "6612f1a2b3c4d5e6f7a8b9c0",
  "amount": 149.97,
  "email": "jane@example.com"
}
```

**Response (maintenance — 503):**

```json
{
  "error": "SERVICE_UNAVAILABLE",
  "message": "Payment service is under maintenance. Please try again later."
}
```

**Response (error — 500):**

```json
{
  "error": "INTERNAL_SERVER_ERROR",
  "message": "An unexpected error occurred while processing the payment."
}
```

**Response (slow timeout — 504):**

```json
{
  "error": "GATEWAY_TIMEOUT",
  "message": "Payment processing timed out."
}
```

**Response (insufficient-funds — 400):**

```json
{
  "error": "INSUFFICIENT_FUNDS",
  "message": "The payment method has insufficient funds to complete this transaction.",
  "orderId": "6612f1a2b3c4d5e6f7a8b9c0",
  "amount": 149.97
}
```

**Response (unauthorized — 401):**

```json
{
  "error": "UNAUTHORIZED",
  "message": "Authentication failed. Invalid or missing API credentials."
}
```
