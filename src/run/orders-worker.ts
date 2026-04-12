/**
 * Orders Worker
 *
 * Starts a BullMQ worker that processes jobs from the "orders" queue.
 * Handles order-related jobs such as StartOrderProcessing.
 */

import 'dotenv/config';
import connection from "../connection";
import { connectDB } from "../db/connection";
import { jobs } from "../config/jobs";
import { queues } from "../config/queues";
import { Oxen } from "../oxen-lib/Oxen";

async function main() {
  await connectDB();
  const oxen = new Oxen(connection, queues, jobs);
  await oxen.run([
    'orders',
  ]);
}

main().catch(console.error);
