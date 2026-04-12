/**
 * Bull Board Dashboard
 *
 * Starts an Express server hosting the Bull Board UI for monitoring
 * all BullMQ queues. Also exposes REST API endpoints for retrying
 * failed jobs, inspecting job details, listing workers, and viewing
 * per-worker processing statistics.
 */

import 'dotenv/config';
import express from 'express';
import Redis from 'ioredis';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import connection from '../connection';
import { Oxen } from '../oxen-lib/Oxen';
import { queues } from '../config/queues';
import { jobs } from '../config/jobs';

// Boot Oxen so registries are populated (no workers/schedulers for dashboard)
const oxen = new Oxen(connection, queues, jobs);

async function main() {
  oxen.bootstrap();

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/');

  createBullBoard({
    queues: queues.map(({ name }) => new BullMQAdapter(Oxen.queueRegistry.getQueue(name))),
    serverAdapter,
  });

  const app = express();
  app.use(express.json());

// Retry a failed job
app.post('/api/retry/:queueName/:jobId', async (req, res) => {
  try {
    const { queueName, jobId } = req.params;
    const queue = Oxen.queueRegistry.getQueue(queueName);
    const job = await queue.getJob(jobId);

    if (!job) {
      res.status(404).json({ error: `Job "${jobId}" not found in queue "${queueName}"` });
      return;
    }

    const state = await job.getState();
    if (state !== 'failed') {
      res.status(400).json({ error: `Job "${jobId}" is not in failed state (current: ${state})` });
      return;
    }

    await job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });

    res.json({ message: `Job "${jobId}" retried` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get workers for a queue
app.get('/api/workers/:queueName', async (req, res) => {
  try {
    const { queueName } = req.params;
    const queue = Oxen.queueRegistry.getQueue(queueName);
    const workers = await queue.getWorkers();
    res.json({ queue: queueName, count: workers.length, workers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get job details including processedBy
app.get('/api/job/:queueName/:jobId', async (req, res) => {
  try {
    const { queueName, jobId } = req.params;
    const queue = Oxen.queueRegistry.getQueue(queueName);
    const job = await queue.getJob(jobId);
    if (!job) {
      res.status(404).json({ error: `Job "${jobId}" not found` });
      return;
    }
    res.json({
      id: job.id,
      name: job.name,
      data: job.data,
      opts: job.opts,
      attemptsMade: job.attemptsMade,
      processedBy: job.processedBy,
      timestamp: job.timestamp,
      finishedOn: job.finishedOn,
      processedOn: job.processedOn,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get per-worker processed job counts from Redis
app.get('/api/worker-stats', async (_req, res) => {
  try {
    const redis = new Redis(connection);
    const all = await redis.hgetall(oxen.WORKER_STATS_KEY);
    await redis.quit();

    const stats = Object.entries(all).map(([key, count]) => {
      const [queueName, ...rest] = key.split(':');
      return { queue: queueName, workerId: rest.join(':'), processed: Number(count) };
    });

    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get stats for workers of a specific queue
app.get('/api/worker-stats/:queueName', async (req, res) => {
  try {
    const { queueName } = req.params;
    const redis = new Redis(connection);
    const all = await redis.hgetall(oxen.WORKER_STATS_KEY);
    await redis.quit();

    const stats = Object.entries(all)
      .filter(([key]) => key.startsWith(`${queueName}:`))
      .map(([key, count]) => {
        const workerId = key.slice(queueName.length + 1);
        return { queue: queueName, workerId, processed: Number(count) };
      });

    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

  app.use('/', serverAdapter.getRouter());

  const port = Number(process.env.BOARD_PORT) || 3000;
  app.listen(port, () => {
    console.log(`Bull Board running at http://localhost:${port}`);
  });
}

main().catch(console.error);
