import { type AuthProvider } from '@twurple/auth';
import { ChatClient } from '@twurple/chat';
import { type ResolvedChannel } from './config.js';
import { log } from './logger.js';

const DEFAULT_CHAT_MESSAGE = 'Hey @{streamer}, getting ready to stream?';

export interface ChatVars {
  streamer: string;
  title: string;
  category: string;
}

function renderTemplate(template: string, vars: ChatVars): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key as keyof ChatVars] ?? `{${key}}`);
}

export class ChatManager {
  private client: ChatClient | null = null;
  private connected = false;
  private templates = new Map<string, string>();
  private pending: Array<{ channel: string; message: string }> = [];
  private stopping = false;

  constructor(private readonly authProvider: AuthProvider) { }

  start(channels: ResolvedChannel[]): void {
    const chatChannels = channels.filter((channel) => channel.notifyByChat);
    if (chatChannels.length === 0) {
      log.info('Chat notifications are disabled for all channels; skipping chat connection.');
      return;
    }

    this.templates = new Map(
      chatChannels.map((channel) => [
        channel.name.toLowerCase(),
        channel.chatMessage ?? DEFAULT_CHAT_MESSAGE,
      ]),
    );
    this.client = new ChatClient({
      authProvider: this.authProvider,
      channels: chatChannels.map((channel) => channel.name),
      webSocket: true,
    });

    this.client.onConnect(() => {
      this.connected = true;
      log.info('Connected to Twitch chat.');
      this.flushPending();
    });
    this.client.onDisconnect((manually, reason) => {
      this.connected = false;
      if (!manually && reason) {
        log.warn(`Twitch chat disconnected: ${reason.message}`);
      }
    });
    this.client.onAuthenticationFailure((text, retryCount) => {
      log.error(`Twitch chat authentication failed: ${text} (attempt ${retryCount + 1})`);
    });

    this.client.connect();
  }

  send(channelName: string, vars: ChatVars): void {
    const template = this.templates.get(channelName.toLowerCase());
    if (!template) {
      return;
    }
    const message = renderTemplate(template, vars);
    const channel = channelName.toLowerCase();

    if (!this.connected) {
      this.pending.push({ channel, message });
      return;
    }
    this.say(channel, message);
  }

  stop(): void {
    this.stopping = true;
    this.client?.quit();
  }

  private flushPending(): void {
    while (this.pending.length > 0) {
      const { channel, message } = this.pending.shift()!;
      this.say(channel, message);
    }
  }

  private say(channel: string, message: string): void {
    this.client
      ?.say(channel, message)
      .catch((error: unknown) => {
        if (this.stopping) {
          return;
        }
        log.warn(
          `Failed to send chat message to ${channel}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
}