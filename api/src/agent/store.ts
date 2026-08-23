import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

// Shared state for the rate limiters and the kill switch.
//
// This has to be shared, not in-process: desired_count is 2, so in-memory
// counters would silently double every limit and make the daily ceiling
// per-task rather than global.

export interface AgentStore {
  /** Atomically add to a counter and return the value after the add. */
  bump(key: string, by: number, ttlSeconds: number): Promise<number>;
  /** Kill-switch style flag. null means unset - the caller decides the default. */
  getFlag(key: string): Promise<boolean | null>;
}

export function createDynamoStore(tableName: string, endpoint?: string): AgentStore {
  const doc = DynamoDBDocumentClient.from(
    new DynamoDBClient(endpoint ? { endpoint } : {}),
  );

  return {
    async bump(key, by, ttlSeconds) {
      // ADD is atomic server-side, so two tasks incrementing the same counter
      // cannot lose an update the way read-modify-write would.
      //
      // expires_at is written with if_not_exists so the window's lifetime is
      // fixed at first write rather than sliding forward on every request -
      // otherwise a busy counter would never expire.
      const out = await doc.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: key },
          UpdateExpression: 'ADD #n :by SET expires_at = if_not_exists(expires_at, :exp)',
          ExpressionAttributeNames: { '#n': 'n' },
          ExpressionAttributeValues: {
            ':by': by,
            ':exp': Math.floor(Date.now() / 1000) + ttlSeconds,
          },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      return Number(out.Attributes?.n ?? by);
    },

    async getFlag(key) {
      const out = await doc.send(
        new GetCommand({ TableName: tableName, Key: { pk: key }, ConsistentRead: true }),
      );
      const v = out.Item?.value;
      return typeof v === 'boolean' ? v : null;
    },
  };
}

/**
 * In-process store for local development, where there is no DynamoDB and no
 * second task for the counters to be wrong across. Never used in production:
 * app.ts only reaches for this when AGENT_TABLE is unset.
 */
export function createMemoryStore(now: () => number = Date.now): AgentStore {
  const counters = new Map<string, { n: number; expiresAt: number }>();
  const flags = new Map<string, boolean>();

  return {
    async bump(key, by, ttlSeconds) {
      const t = now();
      const existing = counters.get(key);
      const live = existing && existing.expiresAt > t ? existing : undefined;
      const next = { n: (live?.n ?? 0) + by, expiresAt: live?.expiresAt ?? t + ttlSeconds * 1000 };
      counters.set(key, next);
      return next.n;
    },
    async getFlag(key) {
      return flags.get(key) ?? null;
    },
  };
}
