import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type AuthProvider, RefreshingAuthProvider, StaticAuthProvider } from '@twurple/auth';
import { ApiClient } from '@twurple/api';

export interface ChannelConfig {
  name: string;
  notifyByChat?: boolean;
  chatMessage?: string;
}

export interface ResolvedChannel extends ChannelConfig {
  id: string;
  displayName: string;
}

export interface AppConfig {
  authProvider: AuthProvider;
  apiClient: ApiClient;
  channels: ResolvedChannel[];
  dbFile: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable "${name}". Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

interface TokenValidation {
  client_id: string;
  login: string;
  scopes: string[];
  user_id: string;
  expires_in: number;
}

async function validateAccessToken(
  clientId: string,
  accessToken: string,
): Promise<TokenValidation> {
  const response = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Access token invalid or expired (validate returned HTTP ${response.status}): ${body}`,
    );
  }
  const validation = (await response.json()) as TokenValidation;
  if (validation.client_id !== clientId) {
    throw new Error(
      `The access token was issued by client "${validation.client_id}" but your TWITCH_CLIENT_ID is "${clientId}". ` +
        'Generate a token for YOUR app instead - e.g. use twitchtokengenerator.com with your custom client ' +
        'ID, or the OAuth Authorization Code flow.',
    );
  }
  return validation;
}

async function createAuthProvider(): Promise<AuthProvider> {
  const clientId = requireEnv('TWITCH_CLIENT_ID');
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  const accessToken = process.env.TWITCH_ACCESS_TOKEN;
  const refreshToken = process.env.TWITCH_REFRESH_TOKEN;

  if (accessToken) {
    const validation = await validateAccessToken(clientId, accessToken);
    const provider = new StaticAuthProvider(clientId, accessToken, validation.scopes);
    console.log(
      `[auth] Token validated for user "${validation.login}" (${validation.user_id})`,
    );
    return provider;
  }

  if (clientSecret && refreshToken) {
    const provider = new RefreshingAuthProvider({ clientId, clientSecret });
    await provider.addUserForToken({
      refreshToken,
      expiresIn: 0,
      obtainmentTimestamp: Date.now(),
    });
    provider.onRefresh((userId, token) => {
      console.log(`[auth] Refreshed access token for user ${userId}`);
    });
    return provider;
  }

  throw new Error(
    'Provide either TWITCH_ACCESS_TOKEN, or TWITCH_CLIENT_SECRET together with TWITCH_REFRESH_TOKEN.',
  );
}

async function loadChannelConfigs(): Promise<ChannelConfig[]> {
  const configFile = path.resolve(process.env.CHANNELS_CONFIG ?? 'config.json');

  try {
    const raw = await readFile(configFile, 'utf8');
    const parsed = JSON.parse(raw) as { channels?: ChannelConfig[] };
    const channels = parsed.channels ?? [];
    if (channels.length === 0) {
      throw new Error(`No channels defined in ${configFile}`);
    }
    for (const channel of channels) {
      if (!channel.name || typeof channel.name !== 'string') {
        throw new Error(`Channel entry in ${configFile} is missing a "name"`);
      }
    }
    return channels;
  } catch (error) {
    const names = (process.env.CHANNELS ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    if (names.length > 0) {
      return names.map((name) => ({ name }));
    }
    throw new Error(
      `Failed to load channels: ${error instanceof Error ? error.message : String(error)}. ` +
        'Create config.json, or set the CHANNELS env var to a comma-separated list of channel names.',
    );
  }
}

export async function loadConfig(): Promise<AppConfig> {
  const authProvider = await createAuthProvider();
  const apiClient = new ApiClient({ authProvider });
  const channelConfigs = await loadChannelConfigs();

  const channels = await Promise.all(
    channelConfigs.map(async (channel) => {
      const user = await apiClient.users.getUserByName(channel.name);
      if (!user) {
        throw new Error(`Channel "${channel.name}" not found on Twitch.`);
      }
      return {
        ...channel,
        name: user.name,
        displayName: user.displayName,
        id: user.id,
      } satisfies ResolvedChannel;
    }),
  );

  return {
    authProvider,
    apiClient,
    channels,
    dbFile: path.resolve(process.env.DB_FILE ?? 'data/watcher.db'),
  };
}