/**
 * Scheduled Worker
 *
 * Starts a BullMQ worker that processes jobs from the "scheduled-jobs-queue".
 * Handles cron-based and interval-based repeatable jobs.
 * 
 * So far in this project, I've not defined any such job yet
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
    'scheduled-jobs-queue',
  ]);
}

main().catch(console.error);
