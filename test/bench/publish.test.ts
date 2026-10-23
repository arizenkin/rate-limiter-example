import {
  describeEnvironment,
  FRIENDLY_NAMES,
  MODES,
  parseReport,
  parseReportName,
  pickLatest,
  renderReadme,
  type PublishedRun,
} from '../../bench/lib/publish';
import { report } from '../helpers/bench-fixtures';

const environment = describeEnvironment({
  nodeVersion: 'v24.22.0',
  platform: 'linux',
  arch: 'x64',
  release: '6.18.54.1-microsoft-standard-WSL2',
  cpuModel: ' Some CPU ',
  cpuCount: 16,
  totalMemBytes: 16 * 2 ** 30,
});

describe('parseReportName', () => {
  it('reads timestamp, mode and extension', () => {
    expect(parseReportName('2026-10-23T00-52-51-771Z-latency.json')).toEqual({
      startedAt: '2026-10-23T00-52-51-771Z',
      mode: 'latency',
      ext: 'json',
    });
    expect(parseReportName('2026-10-23T01-14-19-934Z-hot.md')?.mode).toBe('hot');
  });

  it.each(MODES)('parses the report file name of every mode: %s', (mode) => {
    expect(parseReportName(`2026-10-23T00-52-51-771Z-${mode}.json`)?.mode).toBe(mode);
  });

  it.each(['notes.md', '2026-10-23T00-52-51-771Z-other.json', '2026-10-23T00-52-51-771Z-hot.txt'])(
    'ignores %s',
    (name) => {
      expect(parseReportName(name)).toBeUndefined();
    },
  );
});

describe('pickLatest', () => {
  it('picks the newest complete run of each mode, whatever the order', () => {
    const files = [
      '2026-10-23T01-14-19-934Z-hot.md',
      '2026-10-23T00-48-24-988Z-latency.json',
      '2026-10-23T00-52-51-771Z-latency.json',
      '2026-10-23T00-48-24-988Z-latency.md',
      '2026-10-23T00-52-51-771Z-latency.md',
      '2026-10-23T01-14-19-934Z-hot.json',
      'README.txt',
    ];
    expect(pickLatest(files)).toEqual({
      latency: {
        json: '2026-10-23T00-52-51-771Z-latency.json',
        md: '2026-10-23T00-52-51-771Z-latency.md',
      },
      hot: { json: '2026-10-23T01-14-19-934Z-hot.json', md: '2026-10-23T01-14-19-934Z-hot.md' },
    });
    expect(pickLatest([...files].reverse())).toEqual(pickLatest(files));
  });

  it('skips a run that has only one of its two files, falling back to an older complete one', () => {
    const files = [
      '2026-10-23T00-48-24-988Z-capacity.json',
      '2026-10-23T00-48-24-988Z-capacity.md',
      '2026-10-23T01-02-00-502Z-capacity.json',
    ];
    expect(pickLatest(files).capacity?.json).toBe('2026-10-23T00-48-24-988Z-capacity.json');
  });

  it('returns nothing for no reports', () => {
    expect(pickLatest([])).toEqual({});
  });
});

describe('parseReport', () => {
  it('accepts a report', () => {
    expect(parseReport('r.json', JSON.stringify(report())).options.mode).toBe('latency');
  });

  it('accepts a report without server metrics or memory', () => {
    const text = JSON.stringify({ ...report(), server: undefined, memory: undefined });
    expect(parseReport('r.json', text).server).toBeUndefined();
  });

  it('names the file when the report is unreadable', () => {
    expect(() => parseReport('bad.json', '{')).toThrow(/cannot read report bad\.json/);
    expect(() => parseReport('bad.json', '{"startedAt":1}')).toThrow(
      /cannot read report bad\.json/,
    );
    expect(() => parseReport('bad.json', '"x"')).toThrow(/cannot read report bad\.json/);
  });

  it('explains a null latency as a histogram overflow', () => {
    const text = JSON.stringify(report()).replace('"p99Ms":0.1', '"p99Ms":null');
    expect(() => parseReport('inf.json', text)).toThrow(/overflowed the 1000 ms bucket/);
  });

  it('rejects a non-finite latency bound (serialised as null)', () => {
    const broken = report({ server: { ...(report().server as object), p99Ms: Infinity } as never });
    expect(() => parseReport('inf.json', JSON.stringify(broken))).toThrow(
      /cannot read report inf\.json/,
    );
  });
});

describe('describeEnvironment', () => {
  it('lists node, OS, CPU and memory', () => {
    expect(environment).toEqual([
      ['Node.js', 'v24.22.0'],
      ['OS', 'linux x64, kernel 6.18.54.1-microsoft-standard-WSL2 (WSL2)'],
      ['CPU', 'Some CPU, 16 logical cores'],
      ['Memory', '16.0 GiB'],
    ]);
  });

  it('does not claim WSL2 elsewhere', () => {
    const rows = describeEnvironment({
      nodeVersion: 'v24.0.0',
      platform: 'darwin',
      arch: 'arm64',
      release: '25.0.0',
      cpuModel: 'M',
      cpuCount: 8,
      totalMemBytes: 2 ** 30,
    });
    expect(rows[1]?.[1]).toBe('darwin arm64, kernel 25.0.0');
  });
});

describe('renderReadme', () => {
  const runs: PublishedRun[] = [
    { mode: 'latency', report: report() },
    {
      mode: 'capacity',
      report: report({
        startedAt: '2026-10-23T01:02:00.502Z',
        options: { ...report().options, mode: 'capacity', rate: undefined, configureEvery: 0 },
      }),
    },
    {
      mode: 'hot',
      report: report({
        startedAt: '2026-10-23T01:14:19.934Z',
        passed: false,
        server: undefined,
        memory: undefined,
      }),
    },
  ];

  it('describes environment, runs, results, charts and raw data links', () => {
    const md = renderReadme({ runs, environment });
    expect(md).toContain('| Node.js | v24.22.0 |');
    expect(md).toContain(
      '| Latency | 2026-10-23 00:52:51 | 300 s | 3 s | 50 | 1,500 req/s | 100 | 2,000 requests |',
    );
    expect(md).toContain('unthrottled');
    expect(md).toContain('| off |');
    expect(md).toContain(
      '| Latency | 1,500.02 | 2 ms | ≤ 0.1 ms | 155,440 / 294,378 | 0 | 105.01 MB | PASS |',
    );
    expect(md).toContain('| Hot key | 1,500.02 | 2 ms | n/a | n/a | 0 | n/a | FAIL |');
    for (const chart of ['latency', 'throughput', 'memory']) {
      expect(md).toContain(`](charts/${chart}.svg)`);
    }
    for (const name of Object.values(FRIENDLY_NAMES)) {
      expect(md).toContain(`[${name}.json](data/${name}.json)`);
    }
    expect(md).toContain('shared this machine');
    expect(md).not.toContain('Not run yet');
    expect(md).not.toContain('--url');
  });

  it('lists tests that have not been run and omits their rows', () => {
    const md = renderReadme({ runs: runs.slice(0, 1), environment });
    expect(md).toContain('Not run yet: Capacity, Hot key.');
    expect(md).not.toContain('data/capacity.json');
  });

  it('only claims a shared machine when every target is loopback', () => {
    const remote = [
      { mode: 'latency' as const, report: report({ target: 'http://10.0.0.5:3000' }) },
    ];
    expect(renderReadme({ runs: remote, environment })).not.toContain('shared this machine');
    const named = [
      { mode: 'latency' as const, report: report({ target: 'http://localhost:3000/' }) },
    ];
    expect(renderReadme({ runs: named, environment })).toContain('shared this machine');
  });

  it('warns that a separately started service may have been reused across runs', () => {
    const external = [
      {
        mode: 'latency' as const,
        report: report({ options: { ...report().options, url: 'http://127.0.0.1:3000' } }),
      },
    ];
    expect(renderReadme({ runs: external, environment })).toContain('`--url`');
  });

  it('renders an empty run list as all tests not run', () => {
    expect(renderReadme({ runs: [], environment })).toContain(
      'Not run yet: Latency, Capacity, Hot key.',
    );
  });

  it('is deterministic', () => {
    expect(renderReadme({ runs, environment })).toBe(renderReadme({ runs, environment }));
  });
});
