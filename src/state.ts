import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface ChannelState {
  broadcasterUserId: string;
  broadcasterUserName: string;
  lastTitle: string | null;
  lastCategory: string | null;
  lastCategoryId: string | null;
  isLive: boolean;
  lastUpdateAt: string | null;
}

export interface StateStore {
  getState(userId: string): ChannelState | undefined;
  setMetadata(
    userId: string,
    userName: string,
    title: string,
    categoryId: string,
    categoryName: string,
    at: Date,
  ): void;
  setLive(userId: string, live: boolean): void;
  syncBoot(userId: string, userName: string, live: boolean): void;
  close(): void;
}

interface ChannelStateRow {
  broadcaster_user_id: string;
  broadcaster_user_name: string;
  last_title: string | null;
  last_category: string | null;
  last_category_id: string | null;
  is_live: number;
  last_update_at: string | null;
}

function rowToState(row: ChannelStateRow | undefined): ChannelState | undefined {
  if (!row) {
    return undefined;
  }
  return {
    broadcasterUserId: row.broadcaster_user_id,
    broadcasterUserName: row.broadcaster_user_name,
    lastTitle: row.last_title,
    lastCategory: row.last_category,
    lastCategoryId: row.last_category_id,
    isLive: row.is_live === 1,
    lastUpdateAt: row.last_update_at,
  };
}

export function createStateStore(dbFile: string): StateStore {
  mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_state (
      broadcaster_user_id  TEXT PRIMARY KEY,
      broadcaster_user_name TEXT NOT NULL,
      last_title           TEXT,
      last_category        TEXT,
      last_category_id     TEXT,
      is_live              INTEGER NOT NULL DEFAULT 0,
      last_update_at       TEXT
    );
  `);

  const getRow = db.prepare(
    'SELECT * FROM channel_state WHERE broadcaster_user_id = ?',
  );
  const upsertMetadata = db.prepare(`
    INSERT INTO channel_state
      (broadcaster_user_id, broadcaster_user_name, last_title, last_category, last_category_id, is_live, last_update_at)
    VALUES
      (?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT (broadcaster_user_id) DO UPDATE SET
      broadcaster_user_name = excluded.broadcaster_user_name,
      last_title           = excluded.last_title,
      last_category        = excluded.last_category,
      last_category_id     = excluded.last_category_id,
      last_update_at       = excluded.last_update_at
  `);
  const upsertLive = db.prepare(`
    INSERT INTO channel_state
      (broadcaster_user_id, broadcaster_user_name, is_live)
    VALUES
      (?, ?, ?)
    ON CONFLICT (broadcaster_user_id) DO UPDATE SET
      broadcaster_user_name = excluded.broadcaster_user_name,
      is_live              = excluded.is_live
  `);

  return {
    getState(userId: string): ChannelState | undefined {
      return rowToState(getRow.get(userId) as ChannelStateRow | undefined);
    },

    setMetadata(
      userId: string,
      userName: string,
      title: string,
      categoryId: string,
      categoryName: string,
      at: Date,
    ): void {
      upsertMetadata.run(
        userId,
        userName,
        title,
        categoryName,
        categoryId,
        at.toISOString(),
      );
    },

    setLive(userId: string, live: boolean): void {
      const existing = rowToState(getRow.get(userId) as ChannelStateRow | undefined);
      upsertLive.run(userId, existing?.broadcasterUserName ?? '', live ? 1 : 0);
    },

    syncBoot(userId: string, userName: string, live: boolean): void {
      upsertLive.run(userId, userName, live ? 1 : 0);
    },

    close(): void {
      db.close();
    },
  };
}