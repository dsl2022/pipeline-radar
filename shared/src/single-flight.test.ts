import { createInFlight } from './single-flight';

describe('createInFlight', () => {
  it('runs one request for concurrent callers on the same key', async () => {
    const flight = createInFlight<string>();
    const start = jest.fn(async () => 'value');

    const results = await Promise.all([
      flight.join('k', start),
      flight.join('k', start),
      flight.join('k', start),
    ]);

    expect(start).toHaveBeenCalledTimes(1);
    expect(results).toEqual(['value', 'value', 'value']);
  });

  it('keeps different keys independent', async () => {
    const flight = createInFlight<string>();
    const start = jest.fn(async (v: string) => v);

    await Promise.all([flight.join('a', () => start('a')), flight.join('b', () => start('b'))]);
    expect(start).toHaveBeenCalledTimes(2);
  });

  // A rejection shared by every concurrent caller must not be remembered, or
  // one blip would poison the key until something cleared it.
  it('rejects every joiner and then frees the key', async () => {
    const flight = createInFlight<string>();
    const start = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('recovered');

    const settled = await Promise.allSettled([flight.join('k', start), flight.join('k', start)]);
    expect(settled.every((r) => r.status === 'rejected')).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);

    expect(await flight.join('k', start)).toBe('recovered');
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('holds nothing once its requests have settled', async () => {
    const flight = createInFlight<string>();
    await Promise.all([flight.join('a', async () => 'x'), flight.join('b', async () => 'y')]);
    expect(flight.size).toBe(0);

    await flight.join('c', async () => {
      throw new Error('boom');
    }).catch(() => undefined);
    expect(flight.size).toBe(0);
  });

  // Once the underlying request has finished, the caller's own cache is
  // populated, so a later call must be allowed through to hit it rather than
  // being joined to a stale entry.
  it('does not join a request that has already finished', async () => {
    const flight = createInFlight<number>();
    let calls = 0;
    const start = async () => {
      calls += 1;
      return calls;
    };

    expect(await flight.join('k', start)).toBe(1);
    expect(await flight.join('k', start)).toBe(2);
  });
});
