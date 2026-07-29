/**
 * NEON STRIKE server entry point.
 *
 * Boots persistence, starts the HTTP + WebSocket transport, and installs a
 * graceful shutdown so in-flight match results are still written.
 */

import { BUILD_INFO } from '@neon/shared';
import { config } from './config.js';
import { createDatabase } from './db/index.js';
import { log } from './logger.js';
import { startServer } from './net/server.js';

async function main(): Promise<void> {
  log.info('boot', `${BUILD_INFO.name} v${BUILD_INFO.version} (${BUILD_INFO.codename})`, {
    env: config.env,
    node: process.version,
  });

  const db = await createDatabase();
  log.info('boot', `persistence ready (${db.driver})`);

  const server = await startServer(db);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown', `received ${signal}, closing`);
    try {
      await server.close();
      await db.close();
    } catch (err) {
      log.error('shutdown', 'error while closing', { error: String(err) });
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error('process', 'unhandled rejection', { reason: String(reason) });
  });
  process.on('uncaughtException', (err) => {
    // Log and keep serving: one bad room should not take the process down.
    log.error('process', 'uncaught exception', { error: String(err), stack: err.stack });
  });
}

main().catch((err) => {
  log.error('boot', 'failed to start', { error: String(err), stack: (err as Error).stack });
  process.exit(1);
});
