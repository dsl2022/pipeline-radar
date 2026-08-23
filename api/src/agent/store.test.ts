import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createDynamoStore } from './store';

// Against DynamoDB Local, not a mock. The behaviour worth proving here is
// server-side atomicity of ADD, which a hand-written fake would simply assert
// into existence:
//
//   docker run -d -p 8000:8000 amazon/dynamodb-local
//
// CI supplies it as a service container.
const ENDPOINT = process.env.DDB_ENDPOINT ?? 'http://localhost:8000';
const TABLE = 'agent-store-test';

// DynamoDB Local ignores credentials but the SDK refuses to sign without them.
process.env.AWS_ACCESS_KEY_ID ??= 'local';
process.env.AWS_SECRET_ACCESS_KEY ??= 'local';
process.env.AWS_REGION ??= 'us-east-1';

const client = new DynamoDBClient({ endpoint: ENDPOINT });
const doc = DynamoDBDocumentClient.from(client);
const store = createDynamoStore(TABLE, ENDPOINT);

beforeAll(async () => {
  await client
    .send(
      new CreateTableCommand({
        TableName: TABLE,
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      }),
    )
    .catch((e: { name?: string }) => {
      if (e?.name !== 'ResourceInUseException') throw e;
    });
}, 30_000);

afterAll(async () => {
  await client.send(new DeleteTableCommand({ TableName: TABLE })).catch(() => undefined);
});

const key = (n: string) => `test#${n}#${Math.random().toString(36).slice(2)}`;

describe('dynamo store', () => {
  it('starts a counter at the increment', async () => {
    expect(await store.bump(key('start'), 1, 60)).toBe(1);
  });

  it('accumulates across calls', async () => {
    const k = key('accum');
    expect(await store.bump(k, 1, 60)).toBe(1);
    expect(await store.bump(k, 1, 60)).toBe(2);
    expect(await store.bump(k, 3, 60)).toBe(5);
  });

  // The reason this is DynamoDB and not a Map: two tasks bump the same
  // counter concurrently, and read-modify-write would lose updates.
  it('loses no updates under concurrency', async () => {
    const k = key('concurrent');
    const results = await Promise.all(Array.from({ length: 25 }, () => store.bump(k, 1, 60)));
    expect(Math.max(...results)).toBe(25);
    expect(new Set(results).size).toBe(25); // every caller saw a distinct value
  });

  it('keeps counters separate per key', async () => {
    const a = key('a');
    const b = key('b');
    await store.bump(a, 4, 60);
    expect(await store.bump(b, 1, 60)).toBe(1);
  });

  // Otherwise a busy counter's window would slide forward on every request
  // and never expire.
  it('fixes the expiry at first write rather than extending it', async () => {
    const k = key('ttl');
    await store.bump(k, 1, 60);
    const first = await readExpiry(k);
    await new Promise((r) => setTimeout(r, 1100));
    await store.bump(k, 1, 3600);
    expect(await readExpiry(k)).toBe(first);
  });

  it('reports an unset flag as null so the caller picks the default', async () => {
    expect(await store.getFlag(key('missing'))).toBeNull();
  });

  it.each([true, false])('round-trips flag value %s', async (value) => {
    const k = key('flag');
    await doc.send(new PutCommand({ TableName: TABLE, Item: { pk: k, value } }));
    expect(await store.getFlag(k)).toBe(value);
  });

  it('treats a non-boolean flag as unset rather than truthy', async () => {
    const k = key('bogus');
    await doc.send(new PutCommand({ TableName: TABLE, Item: { pk: k, value: 'yes' } }));
    expect(await store.getFlag(k)).toBeNull();
  });
});

async function readExpiry(pk: string): Promise<number> {
  const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
  const out = await doc.send(new GetCommand({ TableName: TABLE, Key: { pk }, ConsistentRead: true }));
  return Number(out.Item?.expires_at);
}
