import {
  type EventSubChannelUpdateEvent,
  type EventSubStreamOfflineEvent,
  type EventSubStreamOnlineEvent,
} from '@twurple/eventsub-base';
import { type EventSubWsListener } from '@twurple/eventsub-ws';
import { type ResolvedChannel } from './config.js';
import { log } from './logger.js';
import { type StateStore } from './state.js';

export interface MetadataChange {
  previousTitle: string | null;
  previousCategory: string | null;
  newTitle: string;
  newCategory: string;
}

interface DetectorOptions {
  listener: EventSubWsListener;
  state: StateStore;
  channels: ResolvedChannel[];
  onMetadataChange: (channel: ResolvedChannel, change: MetadataChange) => void;
}

export class Detector {
  private readonly listener: EventSubWsListener;
  private readonly state: StateStore;
  private readonly channels: ResolvedChannel[];
  private readonly onMetadataChange: (channel: ResolvedChannel, change: MetadataChange) => void;

  constructor(options: DetectorOptions) {
    this.listener = options.listener;
    this.state = options.state;
    this.channels = options.channels;
    this.onMetadataChange = options.onMetadataChange;
  }

  start(): void {
    for (const channel of this.channels) {
      this.listener.onChannelUpdate(channel.id, (event) => this.handleChannelUpdate(channel, event));
      this.listener.onStreamOnline(channel.id, (event) => this.handleStreamOnline(channel, event));
      this.listener.onStreamOffline(channel.id, (event) => this.handleStreamOffline(channel, event));
      log.info(`Subscribed to stream.online, stream.offline and channel.update for ${channel.name}`);
    }
  }

  private handleChannelUpdate(channel: ResolvedChannel, event: EventSubChannelUpdateEvent): void {
    const state = this.state.getState(channel.id);
    const at = new Date();

    if (state?.isLive) {
      this.state.setMetadata(
        channel.id,
        channel.name,
        event.streamTitle,
        event.categoryId,
        event.categoryName,
        at,
      );
      return;
    }

    const change: MetadataChange = {
      previousTitle: state?.lastTitle ?? null,
      previousCategory: state?.lastCategory ?? null,
      newTitle: event.streamTitle,
      newCategory: event.categoryName,
    };

    this.state.setMetadata(
      channel.id,
      channel.name,
      event.streamTitle,
      event.categoryId,
      event.categoryName,
      at,
    );
    this.onMetadataChange(channel, change);
  }

  private handleStreamOnline(_channel: ResolvedChannel, event: EventSubStreamOnlineEvent): void {
    this.state.setLive(event.broadcasterId, true);
    log.debug(`[internal] ${event.broadcasterDisplayName} went live (no notification per config)`);
  }

  private handleStreamOffline(_channel: ResolvedChannel, event: EventSubStreamOfflineEvent): void {
    this.state.setLive(event.broadcasterId, false);
    log.debug(`[internal] ${event.broadcasterDisplayName} went offline (no notification per config)`);
  }
}