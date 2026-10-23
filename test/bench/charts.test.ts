import {
  barPath,
  compact,
  escapeXml,
  latencyChart,
  linePath,
  memoryChart,
  niceScale,
  throughputChart,
} from '../../bench/lib/charts';
import type { PublishedRun } from '../../bench/lib/publish';
import { report } from '../helpers/bench-fixtures';

const runs: PublishedRun[] = [
  { mode: 'latency', report: report() },
  {
    mode: 'capacity',
    report: report({
      options: { ...report().options, mode: 'capacity', rate: undefined },
      client: {
        ...report().client,
        requestsPerSec: { avg: 61624.54, min: 50774, max: 64550 },
        latencyMs: { p50: 1, p99: 3, p99_9: 6 },
      },
    }),
  },
  { mode: 'hot', report: report({ server: undefined, memory: undefined, memorySamples: [] }) },
];

const wellFormed = (svg: string) => {
  expect(svg.startsWith('<svg ')).toBe(true);
  expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  expect(svg).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/);
  expect(svg).not.toContain('NaN');
  expect(svg).not.toContain('undefined');
  expect(svg.match(/<text /g)?.length).toBe(svg.match(/<\/text>/g)?.length);
};

describe('helpers', () => {
  it.each([
    [10.5, 15, 5],
    [0.105, 0.15, 0.05],
    [1585, 2000, 500],
    [67000, 80000, 20000],
    [3, 3, 1],
    [9, 10, 2.5],
    [24, 30, 10],
    [4, 4, 1],
  ])('niceScale(%d) covers the value with round ticks', (value, max, step) => {
    const scale = niceScale(value);
    expect(scale.max).toBeCloseTo(max);
    expect(scale.step).toBeCloseTo(step);
  });

  it('falls back to a unit scale when there is nothing to scale', () => {
    expect(niceScale(0)).toEqual({ max: 1, step: 0.25 });
    expect(niceScale(Number.NaN)).toEqual({ max: 1, step: 0.25 });
  });

  it('formats ticks compactly', () => {
    expect([compact(0), compact(0.05), compact(2.5), compact(1500), compact(20000)]).toEqual([
      '0',
      '0.05',
      '2.5',
      '1.5K',
      '20K',
    ]);
  });

  it('escapes XML special characters', () => {
    expect(escapeXml(`a&b<c>"d"`)).toBe('a&amp;b&lt;c&gt;&quot;d&quot;');
  });

  it('draws bars with a rounded far end, and nothing for a zero value', () => {
    expect(barPath(10, 5, 40, 14)).toMatch(/^M10 5h36a4 4 0 0 1 4 4v6a4 4 0 0 1 -4 4h-36z$/);
    expect(barPath(10, 5, 0, 14)).toBe('');
    expect(barPath(10, 5, 2, 14)).toContain('a2 2');
  });

  it('draws a polyline, and nothing for no points', () => {
    expect(
      linePath([
        [0, 1],
        [2, 3.456],
      ]),
    ).toBe('M0 1L2 3.46');
    expect(linePath([])).toBe('');
  });
});

describe('latencyChart', () => {
  const svg = latencyChart(runs);

  it('is accessible and themed', () => {
    wellFormed(svg);
    expect(svg).toContain('<title id="t">Latency percentiles per test</title>');
    expect(svg).toContain('Client p99: Latency: 2 ms; Capacity: 3 ms; Hot key: 2 ms.');
    expect(svg).toContain('Server /ratelimit p99: Latency: 0.1 ms; Capacity: 0.1 ms.');
    expect(svg).toContain('prefers-color-scheme: dark');
  });

  it('shows both panels, every test with data, the legend and the limit line', () => {
    expect(svg).toContain('Client-side latency');
    expect(svg).toContain('Server-side handler time, /ratelimit');
    expect(svg).toContain('p99.9');
    expect(svg).toContain('p99 limit');
    expect(svg).toContain('>Capacity<');
    expect(svg).toContain('6 ms');
    expect(svg).toContain('0.1 ms');
  });

  it('omits tests without server metrics from the server panel', () => {
    const withoutServer = latencyChart([{ mode: 'hot', report: report({ server: undefined }) }]);
    wellFormed(withoutServer);
    expect(withoutServer).toContain('Server /ratelimit p99: .');
  });
});

describe('throughputChart', () => {
  const svg = throughputChart(runs);

  it('labels each test with its numbers and marks the target only for fixed-rate tests', () => {
    wellFormed(svg);
    expect(svg).toContain('avg 1,500');
    expect(svg).toContain('avg 61,625');
    expect(svg).toContain('50,774 to 64,550');
    expect(svg.match(/target 1,500/g)).toHaveLength(2);
  });

  it('keeps a very narrow range visible', () => {
    const flat = throughputChart([
      {
        mode: 'latency',
        report: report({
          client: { ...report().client, requestsPerSec: { avg: 1500, min: 1500, max: 1500 } },
        }),
      },
    ]);
    wellFormed(flat);
    expect(flat).toContain('width="2"');
  });
});

describe('memoryChart', () => {
  it('draws RSS and heap lines with end labels, in MB', () => {
    const svg = memoryChart(runs);
    wellFormed(svg);
    expect(svg).toContain('class="line-1"');
    expect(svg).toContain('class="line-2"');
    expect(svg).toContain('RSS 88 MB');
    expect(svg).toContain('Heap 17 MB');
    expect(svg).toContain(
      'Peak resident set size in MB. Latency: 105.01 MB; Capacity: 105.01 MB; Hot key: n/a.',
    );
  });

  it('says so when a run has no samples', () => {
    expect(memoryChart(runs)).toContain('no memory samples recorded');
  });

  it('handles a single sample and a run with no usable time span', () => {
    const single = memoryChart([
      {
        mode: 'latency',
        report: report({
          memorySamples: [{ tSec: 0, rssBytes: 100 * 2 ** 20, heapUsedBytes: 10 * 2 ** 20 }],
        }),
      },
    ]);
    wellFormed(single);
    expect(single).toContain('RSS 100 MB');
  });

  it('copes with no runs having samples at all', () => {
    const none = memoryChart([{ mode: 'hot', report: report({ memorySamples: [] }) }]);
    wellFormed(none);
  });
});
