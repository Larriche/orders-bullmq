/**
 * Notifications Worker
 *
 * Starts a BullMQ worker that processes jobs from the "notifications" queue.
 * Handles jobs such as SendCustomerWelcome, SendOrderReceivedEmail,
 * SendInsufficientFundsNotification, and SendPostDeliveryNotification.
 * 
 * Can be scaled via PM2 to run multiple instances in parallel, allowing concurrent processing
 * of notification jobs. 
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
    'notifications',
  ]);
}

main().catch(console.error);
