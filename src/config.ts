import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type AccessToken,
  type AccessTokenMaybeWithUserId,
  type AccessTokenWithUserId,
  type AuthProvider,
  RefreshingAuthProvider,
  StaticAuthProvider,
} from '@twurple/auth';
import { ApiClient } from '@twurple/api';
import type { UserIdResolvable } from '@twurple/common';

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

class InvalidAccessTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAccessTokenError';
  }
}

/** Throws InvalidAccessTokenError for expired/invalid tokens, other errors otherwise. */
async function validateAccessToken(
  clientId: string,
  accessToken: string,
): Promise<TokenValidation> {
  const response = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401) {
      throw new InvalidAccessTokenError(
        `Access token invalid or expired (validate returned HTTP 401): ${body}`,
      );
    }
    throw new Error(
      `Token validation failed (validate returned HTTP ${response.status}): ${body}`,
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

interface StoredToken {
  userId: string;
  token: AccessToken;
}

/** Initial token shape accepted by RefreshingAuthProvider#addUserForToken. */
interface SeedToken {
  accessToken?: string;
  refreshToken: string | null;
  expiresIn: number | null;
  obtainmentTimestamp: number;
  scope?: string[];
}

function createTokenStore(storeFile: string) {
  return {
    read(): StoredToken | null {
      try {
        const parsed = JSON.parse(readFileSync(storeFile, 'utf8')) as StoredToken;
        if (parsed?.userId && parsed?.token?.refreshToken) {
          return parsed;
        }
        return null;
      } catch {
        return null;
      }
    },
    write(userId: string, token: AccessToken): void {
      mkdirSync(path.dirname(storeFile), { recursive: true });
      writeFileSync(storeFile, JSON.stringify({ userId, token }, null, 2), 'utf8');
    },
  };
}

/**
 * Builds the initial token for the RefreshingAuthProvider from env values.
 *
 * If the provided access token is still valid it is used as-is; otherwise the
 * provider is seeded with `expiresIn: 0` so it immediately refreshes.
 */
async function buildSeedToken(
  clientId: string,
  accessToken: string | undefined,
  refreshToken: string,
): Promise<SeedToken> {
  if (accessToken) {
    try {
      const validation = await validateAccessToken(clientId, accessToken);
      if (validation.expires_in > 300) {
        return {
          accessToken,
          refreshToken,
          expiresIn: validation.expires_in,
          obtainmentTimestamp: Date.now(),
          scope: validation.scopes,
        };
      }
    } catch (error) {
      if (!(error instanceof InvalidAccessTokenError)) {
        throw error;
      }
      console.log('[auth] Access token expired; will refresh using TWITCH_REFRESH_TOKEN');
    }
  }
  return { accessToken, refreshToken, expiresIn: 0, obtainmentTimestamp: Date.now() };
}

/**
 * Wraps a per-user AuthProvider so that every token request is routed to a
 * single "owner" user.
 *
 * Without this, EventSub subscriptions for a watched channel that is not the
 * token owner fail, because the WebSocket listener requests a token in the
 * context of the watched broadcaster's user ID while the provider only holds
 * a token for the owner. This wrapper lets one user token watch any channel.
 *
 * Refreshes still go through the wrapped RefreshingAuthProvider.
 */
class SingleUserAuthProvider implements AuthProvider {
  readonly clientId: string;
  readonly authorizationType?: string;

  constructor(
    private readonly inner: RefreshingAuthProvider,
    private readonly ownerUserId: string,
  ) {
    this.clientId = inner.clientId;
  }

  getCurrentScopesForUser(): string[] {
    return this.inner.getCurrentScopesForUser(this.ownerUserId);
  }

  async getAccessTokenForUser(
    _user: UserIdResolvable,
    ...scopeSets: Array<string[] | undefined>
  ): Promise<AccessTokenWithUserId | null> {
    return this.inner.getAccessTokenForUser(this.ownerUserId, ...scopeSets);
  }

  getAccessTokenForIntent = (
    intent: string,
    ...scopeSets: Array<string[] | undefined>
  ) => this.inner.getAccessTokenForIntent(intent, ...scopeSets);

  getAnyAccessToken = (): Promise<AccessTokenMaybeWithUserId> =>
    this.inner.getAnyAccessToken(this.ownerUserId);

  getAppAccessToken = (forceNew?: boolean) => this.inner.getAppAccessToken(forceNew);

  refreshAccessTokenForUser = (): Promise<AccessTokenWithUserId> =>
    this.inner.refreshAccessTokenForUser(this.ownerUserId);

  refreshAccessTokenForIntent = (intent: string): Promise<AccessTokenWithUserId> =>
    this.inner.refreshAccessTokenForIntent(intent);
}

async function createAuthProvider(): Promise<AuthProvider> {
  const clientId = requireEnv('TWITCH_CLIENT_ID');
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  const accessToken = process.env.TWITCH_ACCESS_TOKEN;
  const refreshToken = process.env.TWITCH_REFRESH_TOKEN;

  const renewalConfigured = Boolean(clientSecret && refreshToken);
  if (!renewalConfigured && !accessToken) {
    throw new Error(
      'No credentials found. Set TWITCH_ACCESS_TOKEN, or TWITCH_ACCESS_TOKEN + TWITCH_REFRESH_TOKEN + TWITCH_CLIENT_SECRET for automatic renewal.',
    );
  }

  if (!renewalConfigured) {
    const validation = await validateAccessToken(clientId, accessToken!);
    console.log(`[auth] Using static token for "${validation.login}" (${validation.user_id})`);
    console.log(
      '[auth] WARNING: no TWITCH_REFRESH_TOKEN + TWITCH_CLIENT_SECRET set - the token will NOT renew itself and will stop working when it expires.',
    );
    return new StaticAuthProvider(clientId, accessToken!, validation.scopes);
  }

  const tokenStoreFile = path.resolve(
    process.env.TOKEN_STORE_FILE ?? 'data/tokens.json',
  );
  const tokenStore = createTokenStore(tokenStoreFile);
  const provider = new RefreshingAuthProvider({ clientId, clientSecret: clientSecret! });
  provider.onRefresh((userId, token) => {
    tokenStore.write(userId, token);
    console.log(`[auth] Refreshed token for user ${userId} (persisted to ${tokenStoreFile})`);
  });

  const stored = tokenStore.read();
  let userId: string;
  if (stored) {
    userId = await provider.addUserForToken(stored.token, ['chat']);
    console.log(`[auth] Loaded saved token for user ${userId} (auto-renew enabled)`);
  } else {
    const seedToken = await buildSeedToken(clientId, accessToken, refreshToken!);
    userId = await provider.addUserForToken(seedToken, ['chat']);
    console.log(`[auth] Token auto-renew enabled for user ${userId}`);
  }
  return new SingleUserAuthProvider(provider, userId);
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