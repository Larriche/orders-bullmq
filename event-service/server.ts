import express, { Request, Response } from "express";
import mongoose from "mongoose";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import Database from "better-sqlite3";
import { Product } from "../models/Product/schema";
import { Order } from "../models/Order/schema";
import { OrderStatus } from "../models/Order/types";
import { Customer } from "../models/Customer/schema";

const app = express();
app.use(express.json());

// ─── Configuration ───────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 4040;
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");

if (!MONGO_URI) {
  console.error("MONGO_URI environment variable is required");
  process.exit(1);
}

// ─── SQLite Setup ────────────────────────────────────────────────────────────
fs.mkdirSync(DATA_DIR, { recursive: true });

const EVENTS_DB_PATH = path.join(DATA_DIR, "events.db");
const db = new Database(EVENTS_DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    data TEXT NOT NULL,
    sent_at TEXT,
    sent_count INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
  )
`);

// Migrate: add deleted_at column if missing
const hasDeletedAt = db
  .prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('events') WHERE name = 'deleted_at'")
  .get() as { cnt: number };
if (!hasDeletedAt.cnt) {
  db.exec("ALTER TABLE events ADD COLUMN deleted_at TEXT");
}

const insertStmt = db.prepare(
  "INSERT INTO events (id, type, timestamp, data) VALUES (?, ?, ?, ?)"
);
const softDeleteByIdStmt = db.prepare(
  "UPDATE events SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL"
);

// ─── Service State ──────────────────────────────────────────────────────────
const VALID_EVENT_TYPES = [
  "order_placed",
  "order_shipped",
  "order_delivered",
  "product_restocked",
] as const;

type EventType = (typeof VALID_EVENT_TYPES)[number];

interface GeneratedEvent {
  id: string;
  type: EventType;
  timestamp: string;
  data: Record<string, any>;
}

let mode: "auto" | "stopped" = "auto";

let config = {
  interval: 5000,
  maxPerCycle: 100,
  rates: {
    order_placed: 100,
    order_shipped: -1,
    order_delivered: -1,
    product_restocked: 0,
  } as Record<EventType, number>,
};

let generationTimer: ReturnType<typeof setInterval> | null = null;
let fakerInstance: typeof import("@faker-js/faker").faker | null = null;

// ─── Faker ───────────────────────────────────────────────────────────────────
async function getFaker() {
  if (!fakerInstance) {
    const { faker } = await import("@faker-js/faker");
    fakerInstance = faker;
  }
  return fakerInstance;
}

// ─── Event Storage ───────────────────────────────────────────────────────────
function appendEvent(event: GeneratedEvent) {
  insertStmt.run(event.id, event.type, event.timestamp, JSON.stringify(event.data));
}

function readEvents(page = 1, limit = 20) {
  const offset = (page - 1) * limit;

  const rows = db
    .prepare(
      "SELECT * FROM events WHERE deleted_at IS NULL ORDER BY rowid ASC LIMIT ? OFFSET ?"
    )
    .all(limit, offset) as Array<{
    id: string; type: string; timestamp: string; data: string;
    sent_at: string | null; sent_count: number;
  }>;

  // Intentionally include already-sent events to simulate duplicates
  const duplicates = db
    .prepare(
      "SELECT * FROM events WHERE sent_count > 0 AND deleted_at IS NULL ORDER BY RANDOM() LIMIT 3"
    )
    .all() as typeof rows;

  const allRows = [...rows, ...duplicates];

  // Mark all as sent
  const updateStmt = db.prepare(
    "UPDATE events SET sent_at = datetime('now'), sent_count = sent_count + 1 WHERE id = ?"
  );
  const batchUpdate = db.transaction((ids: string[]) => {
    for (const id of ids) updateStmt.run(id);
  });
  batchUpdate(allRows.map((r) => r.id));

  const total = (
    db.prepare("SELECT COUNT(*) as count FROM events WHERE deleted_at IS NULL").get() as { count: number }
  ).count;

  return {
    events: allRows.map((row) => ({
      id: row.id,
      type: row.type,
      timestamp: row.timestamp,
      data: JSON.parse(row.data),
    })),
    total,
  };
}

function softDeleteEvents(ids: string[]) {
  if (!ids.length) return;
  const del = db.transaction((ids: string[]) => {
    for (const id of ids) softDeleteByIdStmt.run(id);
  });
  del(ids);
}

// ─── Event Generators ────────────────────────────────────────────────────────
async function generateOrderPlaced(faker: typeof import("@faker-js/faker").faker): Promise<GeneratedEvent | null> {
  const product = await Product.aggregate([{ $sample: { size: 1 } }]);
  if (!product.length) {
    console.log("Skipping order_placed: no products in DB");
    return null;
  }

  const quantity = faker.number.int({ min: 1, max: 10 });
  const total_amount = parseFloat((quantity * product[0].price).toFixed(2));

  // 40% chance to reuse an existing customer
  let customerData;
  const existingCustomer = faker.datatype.boolean(0.4)
    ? await Customer.aggregate([{ $sample: { size: 1 } }])
    : [];

  if (existingCustomer.length) {
    customerData = {
      customer_email: existingCustomer[0].email,
      customer_name: existingCustomer[0].name,
      customer_phone: existingCustomer[0].phone,
      payment_email: existingCustomer[0].email,
    };
  } else {
    customerData = {
      customer_email: faker.internet.email(),
      customer_name: faker.person.fullName(),
      customer_phone: faker.phone.number(),
      payment_email: faker.internet.email(),
    };
  }

  return {
    id: crypto.randomUUID(),
    type: "order_placed",
    timestamp: new Date().toISOString(),
    data: {
      ...customerData,
      product: product[0].code,
      quantity,
      total_amount,
      shipping_address: faker.location.streetAddress({ useFullAddress: true }),
      placed_at: new Date().toISOString(),
    },
  };
}

async function generateOrderShipped(faker: typeof import("@faker-js/faker").faker): Promise<GeneratedEvent | null> {
  const order = await Order.aggregate([
    { $match: { status: OrderStatus.PendingShipping } },
    { $sample: { size: 1 } },
  ]);
  if (!order.length) {
    console.log("Skipping order_shipped: no orders pending shipping in DB");
    return null;
  }

  return {
    id: crypto.randomUUID(),
    type: "order_shipped",
    timestamp: new Date().toISOString(),
    data: {
      order_id: order[0]._id.toString(),
      shipment_id: faker.string.alphanumeric(12).toUpperCase(),
    },
  };
}

async function generateOrderDelivered(): Promise<GeneratedEvent | null> {
  const order = await Order.aggregate([
    { $match: { status: OrderStatus.Shipped } },
    { $sample: { size: 1 } },
  ]);
  if (!order.length) {
    console.log("Skipping order_delivered: no shipped orders in DB");
    return null;
  }

  return {
    id: crypto.randomUUID(),
    type: "order_delivered",
    timestamp: new Date().toISOString(),
    data: {
      order_id: order[0]._id.toString(),
    },
  };
}

async function generateProductRestocked(faker: typeof import("@faker-js/faker").faker): Promise<GeneratedEvent | null> {
  const product = await Product.aggregate([{ $sample: { size: 1 } }]);
  if (!product.length) {
    console.log("Skipping product_restocked: no products in DB");
    return null;
  }

  const quantity = faker.number.int({ min: 10, max: 100 });

  return {
    id: crypto.randomUUID(),
    type: "product_restocked",
    timestamp: new Date().toISOString(),
    data: {
      product_code: product[0].code,
      quantity,
    },
  };
}

type FakerType = typeof import("@faker-js/faker").faker;
const generators: Record<EventType, (faker: FakerType) => Promise<GeneratedEvent | null>> = {
  order_placed: generateOrderPlaced,
  order_shipped: generateOrderShipped,
  order_delivered: () => generateOrderDelivered(),
  product_restocked: generateProductRestocked,
};

async function generateSingleEvent(type: EventType, faker: FakerType): Promise<GeneratedEvent | null> {
  const gen = generators[type];
  if (!gen) return null;
  return gen(faker);
}

async function generateEvents(): Promise<GeneratedEvent[]> {
  const faker = await getFaker();

  const pendingShippingCount = await Order.countDocuments({ status: OrderStatus.PendingShipping });
  const shippedCount = await Order.countDocuments({ status: OrderStatus.Shipped });

  const effectiveRates: Record<EventType, number> = {
    order_placed: config.rates.order_placed,
    order_shipped:
      config.rates.order_shipped === -1
        ? pendingShippingCount
        : config.rates.order_shipped,
    order_delivered:
      config.rates.order_delivered === -1
        ? shippedCount
        : config.rates.order_delivered,
    product_restocked: config.rates.product_restocked,
  };

  const eligible = (Object.entries(effectiveRates) as [EventType, number][])
    .filter(([, max]) => max > 0)
    .map(([type]) => type);

  if (!eligible.length) {
    console.log("No events generated this cycle (all types disabled or no eligible data)");
    return [];
  }

  const totalMax = Object.values(effectiveRates).reduce(
    (sum, v) => sum + Math.max(v, 0),
    0
  );
  const count = faker.number.int({
    min: 0,
    max: Math.min(totalMax, config.maxPerCycle),
  });

  if (count === 0) {
    console.log("No events generated this cycle");
    return [];
  }

  const generated: GeneratedEvent[] = [];

  for (let i = 0; i < count; i++) {
    const type = faker.helpers.arrayElement(eligible);
    const event = await generateSingleEvent(type, faker);

    if (event) {
      appendEvent(event);
      generated.push(event);
      console.log(`Generated event: ${event.type}`, JSON.stringify(event.data));
    }
  }

  console.log(`Generated ${generated.length} event(s) this cycle`);
  return generated;
}

// ─── Seed Products ───────────────────────────────────────────────────────────
async function seedProducts() {
  const count = await Product.countDocuments();
  if (count > 0) return;

  const faker = await getFaker();

  const products = Array.from({ length: 10 }, () => ({
    name: faker.commerce.productName(),
    price: parseFloat(
      parseFloat(faker.commerce.price({ min: 5, max: 500 })).toFixed(2)
    ),
    code: faker.string.alphanumeric(8).toUpperCase(),
    description: faker.commerce.productDescription(),
    stock: faker.number.int({ min: 100, max: 500 }),
  }));

  await Product.insertMany(products);
  console.log(`Seeded ${products.length} products into the database`);
}

// ─── Auto-Generation Loop ────────────────────────────────────────────────────
function startAutoGeneration() {
  stopAutoGeneration();
  if (mode !== "auto") return;

  generationTimer = setInterval(async () => {
    try {
      await generateEvents();
    } catch (err) {
      console.error("Error generating events:", err);
    }
  }, config.interval);

  console.log(`Auto-generation started (interval: ${config.interval}ms)`);
}

function stopAutoGeneration() {
  if (generationTimer) {
    clearInterval(generationTimer);
    generationTimer = null;
    console.log("Auto-generation stopped");
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get("/status", (_req: Request, res: Response) => {
  res.json({
    mode,
    config,
    autoGenerating: generationTimer !== null,
  });
});

app.get("/mode", (_req: Request, res: Response) => {
  res.json({ mode });
});

app.post("/mode", (req: Request, res: Response) => {
  const { mode: newMode } = req.body;

  if (!["auto", "stopped"].includes(newMode)) {
    res.status(400).json({
      error: 'Invalid mode. Must be "auto" or "stopped".',
    });
    return;
  }

  mode = newMode;

  if (mode === "auto") {
    startAutoGeneration();
  } else {
    stopAutoGeneration();
  }

  res.json({ mode, message: `Mode set to "${mode}"` });
});

app.get("/config", (_req: Request, res: Response) => {
  res.json(config);
});

app.post("/config", (req: Request, res: Response) => {
  const { interval, maxPerCycle, rates } = req.body;

  if (interval !== undefined) {
    if (typeof interval !== "number" || interval < 1000) {
      res.status(400).json({ error: "interval must be a number >= 1000 (ms)" });
      return;
    }
    config.interval = interval;
  }

  if (maxPerCycle !== undefined) {
    if (typeof maxPerCycle !== "number" || maxPerCycle < 0) {
      res.status(400).json({ error: "maxPerCycle must be a non-negative number" });
      return;
    }
    config.maxPerCycle = maxPerCycle;
  }

  if (rates) {
    for (const [type, value] of Object.entries(rates)) {
      if (!VALID_EVENT_TYPES.includes(type as EventType)) {
        res.status(400).json({ error: `Invalid event type: "${type}"` });
        return;
      }
      if (typeof value !== "number" || (value as number) < -1) {
        res.status(400).json({ error: `Rate for "${type}" must be a number >= -1` });
        return;
      }
      config.rates[type as EventType] = value as number;
    }
  }

  if (mode === "auto") {
    startAutoGeneration();
  }

  res.json(config);
});

app.post("/order-rate", (req: Request, res: Response) => {
  const { amount } = req.body;

  if (typeof amount !== "number" || amount < 0) {
    res.status(400).json({ error: "amount must be a non-negative number" });
    return;
  }

  config.rates.order_placed = amount;

  if (mode === "auto") {
    startAutoGeneration();
  }

  res.json({ order_placed: config.rates.order_placed });
});

app.post("/events/trigger", async (req: Request, res: Response) => {
  const { type, count = 1 } = req.body;

  if (type && !VALID_EVENT_TYPES.includes(type)) {
    res.status(400).json({
      error: `Invalid event type: "${type}". Valid types: ${VALID_EVENT_TYPES.join(", ")}`,
    });
    return;
  }

  if (typeof count !== "number" || count < 1 || count > 1000) {
    res.status(400).json({ error: "count must be a number between 1 and 1000" });
    return;
  }

  try {
    const faker = await getFaker();
    const generated: GeneratedEvent[] = [];

    for (let i = 0; i < count; i++) {
      const eventType: EventType =
        type || faker.helpers.arrayElement([...VALID_EVENT_TYPES]);
      const event = await generateSingleEvent(eventType, faker);

      if (event) {
        appendEvent(event);
        generated.push(event);
      }
    }

    res.json({ generated: generated.length, events: generated });
  } catch (err) {
    console.error("Error triggering events:", err);
    res.status(500).json({ error: "Failed to generate events" });
  }
});

app.get("/events", (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;

  if (page < 1 || limit < 1 || limit > 1000) {
    res.status(400).json({ error: "Invalid page or limit" });
    return;
  }

  const result = readEvents(page, limit);
  res.json(result);
});

app.post("/events/delete", (req: Request, res: Response) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || !ids.length) {
    res.status(400).json({ error: "ids must be a non-empty array of strings" });
    return;
  }

  if (!ids.every((id: any) => typeof id === "string")) {
    res.status(400).json({ error: "All ids must be strings" });
    return;
  }

  softDeleteEvents(ids);
  res.json({ deleted: ids.length });
});

// ─── Start ───────────────────────────────────────────────────────────────────
async function start() {
  await mongoose.connect(MONGO_URI!);
  console.log("Connected to MongoDB");

  await seedProducts();

  try {
    await generateEvents();
  } catch (err) {
    console.error("Error on initial generation:", err);
  }

  startAutoGeneration();

  app.listen(PORT, () => {
    console.log(`Event Service running on port ${PORT}`);
    console.log(`Mode: ${mode}`);
    console.log(`Generation interval: ${config.interval}ms`);
  });
}

start().catch((err) => {
  console.error("Failed to start Event Service:", err);
  process.exit(1);
});
