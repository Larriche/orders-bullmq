/**
 * Default Worker
 *
 * Starts a BullMQ worker that processes jobs from the "default" queue.
 * Handles any jobs that don't specify a dedicated queue.
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
    'default',
  ]);
}

main().catch(console.error);
