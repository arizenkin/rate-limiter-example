import { parseOptions, redactOptions, resolveApiKey, UsageError } from '../../bench/lib/options';

describe('parseOptions', () => {
  it('defaults to latency mode with a fixed rate', () => {
    expect(parseOptions([])).toEqual({
      mode: 'latency',
      url: undefined,
      durationSec: 30,
      warmupSec: 3,
      connections: 50,
      rate: 1500,
      clients: 100,
      configureEvery: 100,
      outDir: 'bench/reports',
      p99LimitMs: 10,
      minRps: 1000,
      apiKey: undefined,
    });
  });

  it('has an unthrottled capacity mode and a single-client hot mode', () => {
    expect(parseOptions(['--mode', 'capacity'])).toMatchObject({
      rate: undefined,
      connections: 100,
      clients: 1000,
    });
    expect(parseOptions(['--mode', 'hot'])).toMatchObject({ rate: 1500, clients: 1 });
  });

  it('accepts overrides', () => {
    expect(
      parseOptions(
        [
          '--url',
          'http://x:1',
          '--duration',
          '5',
          '--warmup',
          '0',
          '--connections',
          '7',
          '--rate',
          '200',
          '--clients',
          '3',
          '--configure-every',
          '0',
          '--out',
          'o',
        ],
        { BENCH_API_KEY: 'k' },
      ),
    ).toMatchObject({
      url: 'http://x:1',
      durationSec: 5,
      warmupSec: 0,
      connections: 7,
      rate: 200,
      clients: 3,
      configureEvery: 0,
      outDir: 'o',
    });
  });

  it.each([
    [['--mode', 'x'], '--mode must be one of latency, capacity, hot'],
    [['--duration', '0'], '--duration must be an integer >= 1'],
    [['--duration', 'abc'], '--duration must be an integer >= 1'],
    [['--rate', '0'], '--rate must be an integer >= 1'],
    [['--warmup=-1'], '--warmup must be an integer >= 0'],
    [['--bogus'], 'Unknown option'],
  ])('rejects %j', (argv, message) => {
    expect(() => parseOptions(argv)).toThrow(UsageError);
    expect(() => parseOptions(argv)).toThrow(message);
  });

  describe('admin API key', () => {
    it('is read from BENCH_API_KEY only (never from argv)', () => {
      expect(parseOptions([], { BENCH_API_KEY: 'k2' }).apiKey).toBe('k2');
      expect(() => parseOptions(['--api-key', 'k1'])).toThrow(UsageError);
    });

    it('is required when targeting an existing server with --url', () => {
      for (const env of [{}, { BENCH_API_KEY: '' }]) {
        expect(() => parseOptions(['--url', 'http://x:1'], env)).toThrow(UsageError);
        expect(() => parseOptions(['--url', 'http://x:1'], env)).toThrow(
          'set the BENCH_API_KEY environment variable',
        );
      }
      expect(parseOptions(['--url', 'http://x:1'], { BENCH_API_KEY: 'k' }).apiKey).toBe('k');
    });

    it('is removed from the options recorded in reports', () => {
      const redacted = redactOptions(parseOptions([], { BENCH_API_KEY: 'secret' }));
      expect(JSON.stringify(redacted)).not.toContain('secret');
      expect('apiKey' in redacted).toBe(false);
      expect(redacted.mode).toBe('latency');
    });
  });

  it('prefers the key minted for a spawned server over BENCH_API_KEY', () => {
    const options = parseOptions([], { BENCH_API_KEY: 'from-env' });
    expect(resolveApiKey(options, 'minted')).toBe('minted');
    expect(resolveApiKey(options, undefined)).toBe('from-env');
  });
});
