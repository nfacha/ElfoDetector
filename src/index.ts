import { EventSubWsListener } from '@twurple/eventsub-ws';
import { ChatManager } from './chat.js';
import { loadConfig } from './config.js';
import { Detector } from './detector.js';
import { log } from './logger.js';
import { createStateStore } from './state.js';

async function main(): Promise<void> {
  const config = await loadConfig();
  const state = createStateStore(config.dbFile);
  const chat = new ChatManager(config.authProvider);

  for (const channel of config.channels) {
    const stream = await config.apiClient.streams.getStreamByUserId(channel.id);
    const isLive = stream !== null;
    state.syncBoot(channel.id, channel.name, isLive);
    log.info(
      `Channel ${channel.displayName} (${channel.id}): currently ${isLive ? 'LIVE' : 'offline'}`,
    );
  }

  chat.start(config.channels);

  const listener = new EventSubWsListener({ apiClient: config.apiClient });
  listener.start();

  const detector = new Detector({
    listener,
    state,
    channels: config.channels,
    onMetadataChange: (channel, change) => {
      log.info(
        `ALERT: ${channel.displayName} is preparing to go live (offline metadata change)`,
      );
      log.info(`  title:    ${change.previousTitle ?? '(none)'} -> ${change.newTitle}`);
      log.info(`  category: ${change.previousCategory ?? '(none)'} -> ${change.newCategory}`);
      chat.send(channel.name, {
        streamer: channel.displayName,
        title: change.newTitle,
        category: change.newCategory,
      });
    },
  });
  detector.start();

  log.info('Watcher is running. Press Ctrl+C to stop.');

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info('Shutting down...');
    listener.stop();
    chat.stop();
    state.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});