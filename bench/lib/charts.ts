import { num, TITLES, type PublishedReport, type PublishedRun } from './publish';

// Static SVG charts for docs/benchmarks. Colours are CSS custom properties inside the file so one
// SVG serves light and dark; the palette is the dataviz reference palette (blue ramp for ordered
// percentiles, blue and orange for the two memory series).
const WIDTH = 760;
const LEFT = 130;
const RIGHT = 110;
const BAR = 14;
const GAP = 2;
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

const STYLE = `
    :root {
      --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
      --grid: #e1e0d9; --axis: #c3c2b7;
      --seq-1: #86b6ef; --seq-2: #2a78d6; --seq-3: #104281;
      --series-1: #2a78d6; --series-2: #eb6834;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
        --grid: #2c2c2a; --axis: #383835;
        --seq-1: #184f95; --seq-2: #3987e5; --seq-3: #86b6ef;
        --series-1: #3987e5; --series-2: #d95926;
      }
    }
    .bg { fill: var(--surface); }
    text { font-family: ${FONT}; fill: var(--ink-2); font-size: 12px; }
    .title { fill: var(--ink); font-size: 15px; font-weight: 600; }
    .sub { fill: var(--ink-2); font-size: 12px; }
    .label { fill: var(--ink); }
    .muted { fill: var(--muted); font-size: 11px; }
    .grid { stroke: var(--grid); stroke-width: 1; }
    .axis { stroke: var(--axis); stroke-width: 1; }
    .target { stroke: var(--ink-2); stroke-width: 1.5; }
    .s1 { fill: var(--seq-1); } .s2 { fill: var(--seq-2); } .s3 { fill: var(--seq-3); }
    .line-1 { stroke: var(--series-1); fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
    .line-2 { stroke: var(--series-2); fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
    .dot-1 { fill: var(--series-1); stroke: var(--surface); stroke-width: 2; }
    .dot-2 { fill: var(--series-2); stroke: var(--surface); stroke-width: 2; }
    .range { fill: var(--seq-1); }
    .avg { fill: var(--seq-3); stroke: var(--surface); stroke-width: 2; }
  `;

export const escapeXml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const n = (value: number): string => String(Number(value.toFixed(2)));

/** A round-numbered axis maximum and step that fit `max` in about `ticks` steps. */
export function niceScale(max: number, ticks = 4): { max: number; step: number } {
  if (!(max > 0)) return { max: 1, step: 0.25 };
  const raw = max / ticks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;
  const factor =
    normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10;
  const step = factor * magnitude;
  return { max: Math.ceil(max / step - 1e-9) * step, step };
}

/** Compact tick/value text: 0, 0.05, 2.5, 20K. */
export function compact(value: number): string {
  if (value >= 1000) return `${compact(value / 1000)}K`;
  return String(Number(value.toFixed(3)));
}

const ticksOf = (scale: { max: number; step: number }): number[] =>
  Array.from({ length: Math.round(scale.max / scale.step) + 1 }, (_, i) => i * scale.step);

interface Frame {
  readonly title: string;
  readonly desc: string;
  readonly height: number;
  readonly body: string;
}

const document_ = ({ title, desc, height, body }: Frame): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${n(height)}" width="${WIDTH}" height="${n(height)}" role="img" aria-labelledby="t d">
  <title id="t">${escapeXml(title)}</title>
  <desc id="d">${escapeXml(desc)}</desc>
  <style>${STYLE}</style>
  <rect width="${WIDTH}" height="${n(height)}" rx="8" class="bg"/>
${body}
</svg>
`;

const text = (x: number, y: number, content: string, cls = '', anchor = 'start'): string =>
  `  <text x="${n(x)}" y="${n(y)}"${cls ? ` class="${cls}"` : ''} text-anchor="${anchor}">${escapeXml(content)}</text>\n`;

/** Bar with a 4px rounded end on the right and a square left edge on the baseline. */
export function barPath(x: number, y: number, width: number, height: number): string {
  if (width <= 0) return '';
  const r = Math.min(4, width, height / 2);
  return `M${n(x)} ${n(y)}h${n(width - r)}a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(r)}v${n(height - 2 * r)}a${n(r)} ${n(r)} 0 0 1 -${n(r)} ${n(r)}h-${n(width - r)}z`;
}

/** Straight line segments through the points; a single point draws nothing (see `dot`). */
export function linePath(points: readonly (readonly [number, number])[]): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${n(x)} ${n(y)}`).join('');
}

const ms = (value: number): string => `${compact(value)} ms`;

type SeriesClass = 's1' | 's2' | 's3';

interface BarPanel {
  readonly y: number;
  readonly title: string;
  readonly subtitle: string;
  readonly series: readonly { label: string; cls: SeriesClass }[];
  readonly groups: readonly {
    label: string;
    bars: readonly { value: number; cls: SeriesClass }[];
  }[];
  readonly target?: { value: number; label: string };
}

const GROUP_HEIGHT = 3 * BAR + 2 * GAP + 18;

/** Three ordered percentile bars, light to dark, in the series order of the legend. */
const percentileBars = (first: number, second: number, third: number) => [
  { value: first, cls: 's1' as const },
  { value: second, cls: 's2' as const },
  { value: third, cls: 's3' as const },
];

/** Grouped horizontal bars with one shared ms scale; returns the SVG fragment and its height. */
function barPanel(panel: BarPanel): { svg: string; height: number } {
  const values = panel.groups.flatMap((group) => group.bars.map((bar) => bar.value));
  const scale = niceScale(Math.max(...values, panel.target?.value ?? 0) * 1.05);
  const plotWidth = WIDTH - LEFT - RIGHT;
  const x = (value: number) => LEFT + (value / scale.max) * plotWidth;
  const top = panel.y + 78;
  const bottom = top + panel.groups.length * GROUP_HEIGHT;

  let svg =
    text(24, panel.y + 20, panel.title, 'title') + text(24, panel.y + 38, panel.subtitle, 'sub');
  // Legend: a swatch per series, labels in ink.
  panel.series.forEach(({ label, cls }, i) => {
    const lx = LEFT + i * 70;
    svg += `  <rect x="${lx}" y="${panel.y + 50}" width="10" height="10" rx="2" class="${cls}"/>\n`;
    svg += text(lx + 15, panel.y + 59, label);
  });
  for (const tick of ticksOf(scale)) {
    svg += `  <line x1="${n(x(tick))}" x2="${n(x(tick))}" y1="${top - 6}" y2="${bottom}" class="grid"/>\n`;
    svg += text(x(tick), bottom + 16, compact(tick), 'muted', 'middle');
  }
  svg += `  <line x1="${LEFT}" x2="${LEFT}" y1="${top - 6}" y2="${bottom}" class="axis"/>\n`;
  panel.groups.forEach((group, g) => {
    const y0 = top + g * GROUP_HEIGHT;
    svg += text(LEFT - 12, y0 + (3 * BAR + 2 * GAP) / 2 + 4, group.label, 'label', 'end');
    group.bars.forEach(({ value, cls }, i) => {
      const y = y0 + i * (BAR + GAP);
      const path = barPath(LEFT, y, x(value) - LEFT, BAR);
      if (path !== '') svg += `  <path d="${path}" class="${cls}"/>\n`;
      svg += text(x(value) + 6, y + BAR - 3, ms(value), 'sub');
    });
  });
  if (panel.target !== undefined) {
    const tx = x(panel.target.value);
    svg += `  <line x1="${n(tx)}" x2="${n(tx)}" y1="${top - 6}" y2="${bottom}" class="target"/>\n`;
    svg += text(tx - 6, panel.y + 59, panel.target.label, 'sub', 'end');
  }
  return { svg, height: bottom + 34 - panel.y };
}

const describeRuns = (runs: readonly PublishedRun[], pick: (report: PublishedReport) => string) =>
  runs.map(({ mode, report }) => `${TITLES[mode]}: ${pick(report)}`).join('; ');

/** Client and server latency percentiles per test. */
export function latencyChart(runs: readonly PublishedRun[]): string {
  const client = barPanel({
    y: 12,
    title: 'Client-side latency',
    subtitle: 'Measured by the load generator (1 ms resolution). The line is the pass limit.',
    series: [
      { label: 'p50', cls: 's1' },
      { label: 'p99', cls: 's2' },
      { label: 'p99.9', cls: 's3' },
    ],
    groups: runs.map(({ mode, report }) => ({
      label: TITLES[mode],
      bars: percentileBars(
        report.client.latencyMs.p50,
        report.client.latencyMs.p99,
        report.client.latencyMs.p99_9,
      ),
    })),
    target: {
      value: Math.max(...runs.map(({ report }) => report.options.p99LimitMs)),
      label: 'p99 limit',
    },
  });
  const served = runs.flatMap(({ mode, report }) =>
    report.server === undefined ? [] : [{ mode, server: report.server }],
  );
  const server = barPanel({
    y: 12 + client.height + 16,
    title: 'Server-side handler time, /ratelimit',
    subtitle: 'From /metrics; each value is a histogram bucket upper bound.',
    series: [
      { label: 'p50', cls: 's1' },
      { label: 'p95', cls: 's2' },
      { label: 'p99', cls: 's3' },
    ],
    groups: served.map(({ mode, server: s }) => ({
      label: TITLES[mode],
      bars: percentileBars(s.p50Ms, s.p95Ms, s.p99Ms),
    })),
  });
  return document_({
    title: 'Latency percentiles per test',
    desc:
      `Client p99: ${describeRuns(runs, (r) => ms(r.client.latencyMs.p99))}. ` +
      `Server /ratelimit p99: ${served.map(({ mode, server: s }) => `${TITLES[mode]}: ${ms(s.p99Ms)}`).join('; ')}.`,
    height: 12 + client.height + 16 + server.height + 12,
    body: client.svg + server.svg,
  });
}

const ROW = 92;

/** Requests per second per test: the min to max range, the average and the target rate. */
export function throughputChart(runs: readonly PublishedRun[]): string {
  const plotWidth = WIDTH - LEFT - RIGHT;
  let body = text(24, 32, 'Throughput', 'title');
  body += text(
    24,
    50,
    'Requests per second during the measured run. Bar: minimum to maximum, dot: average.',
    'sub',
  );
  runs.forEach(({ mode, report }, i) => {
    const { avg, min, max } = report.client.requestsPerSec;
    const rate = report.options.rate;
    const scale = niceScale(Math.max(max, rate ?? 0) * 1.05);
    const x = (value: number) => LEFT + (value / scale.max) * plotWidth;
    const y0 = 70 + i * ROW;
    const mid = y0 + 26;
    body += text(LEFT - 12, mid - 2, TITLES[mode], 'label', 'end');
    body += text(LEFT - 12, mid + 14, `avg ${num(Math.round(avg))}`, 'sub', 'end');
    body += text(LEFT - 12, mid + 28, `${num(min)} to ${num(max)}`, 'muted', 'end');
    for (const tick of ticksOf(scale)) {
      body += `  <line x1="${n(x(tick))}" x2="${n(x(tick))}" y1="${y0 + 8}" y2="${y0 + 52}" class="grid"/>\n`;
      body += text(x(tick), y0 + 66, compact(tick), 'muted', 'middle');
    }
    body += `  <line x1="${LEFT}" x2="${LEFT}" y1="${y0 + 8}" y2="${y0 + 52}" class="axis"/>\n`;
    body += `  <rect x="${n(x(min))}" y="${mid - 5}" width="${n(Math.max(x(max) - x(min), 2))}" height="10" rx="4" class="range"/>\n`;
    body += `  <circle cx="${n(x(avg))}" cy="${mid}" r="5" class="avg"/>\n`;
    if (rate !== undefined) {
      body += `  <line x1="${n(x(rate))}" x2="${n(x(rate))}" y1="${y0 + 8}" y2="${y0 + 52}" class="target"/>\n`;
      body += text(x(rate), y0 + 4, `target ${num(rate)}`, 'muted', 'middle');
    }
  });
  return document_({
    title: 'Throughput per test',
    desc: `Average requests per second. ${describeRuns(runs, (r) => compact(r.client.requestsPerSec.avg))}.`,
    height: 70 + runs.length * ROW + 8,
    body,
  });
}

const PANEL = 170;

type Sample = PublishedReport['memorySamples'][number];

/** Server RSS and heap used over each run, one panel per test on a shared MB scale. */
export function memoryChart(runs: readonly PublishedRun[]): string {
  const plotWidth = WIDTH - LEFT - RIGHT;
  const mb = (bytes: number) => bytes / 2 ** 20;
  const peak = Math.max(
    ...runs.flatMap(({ report }) => report.memorySamples.map((s) => mb(s.rssBytes))),
    0,
  );
  const scale = niceScale(peak * 1.05);
  let body = text(24, 32, 'Server memory', 'title');
  body += text(24, 50, 'Resident set size and heap used, sampled once per second.', 'sub');
  body +=
    `  <line x1="${LEFT}" x2="${LEFT + 24}" y1="68" y2="68" class="line-1"/>\n` +
    text(LEFT + 32, 72, 'RSS');
  body +=
    `  <line x1="${LEFT + 80}" x2="${LEFT + 104}" y1="68" y2="68" class="line-2"/>\n` +
    text(LEFT + 112, 72, 'Heap used');

  runs.forEach(({ mode, report }, i) => {
    const samples = report.memorySamples;
    const top = 100 + i * PANEL;
    const base = top + 100;
    const y = (value: number) => base - (value / scale.max) * 100;
    body += text(
      24,
      top - 8,
      `${TITLES[mode]} (${compact(report.options.durationSec)} s run)`,
      'label',
    );
    for (const tick of ticksOf(scale)) {
      body += `  <line x1="${LEFT}" x2="${LEFT + plotWidth}" y1="${n(y(tick))}" y2="${n(y(tick))}" class="grid"/>\n`;
      body += text(LEFT - 8, y(tick) + 4, compact(tick), 'muted', 'end');
    }
    body += `  <line x1="${LEFT}" x2="${LEFT + plotWidth}" y1="${base}" y2="${base}" class="axis"/>\n`;
    const last = samples.at(-1);
    if (last === undefined) {
      body += text(LEFT + 8, top + 50, 'no memory samples recorded', 'muted');
      return;
    }
    const span = Math.max(last.tSec, 1);
    const x = (tSec: number) => LEFT + (tSec / span) * plotWidth;
    const series = [
      { cls: '1', label: 'RSS', pick: (s: Sample) => s.rssBytes },
      { cls: '2', label: 'Heap', pick: (s: Sample) => s.heapUsedBytes },
    ];
    for (const { cls, label, pick } of series) {
      const points = samples.map((s) => [x(s.tSec), y(mb(pick(s)))] as const);
      body += `  <path d="${linePath(points)}" class="line-${cls}"/>\n`;
      const endX = x(last.tSec);
      const endY = y(mb(pick(last)));
      body += `  <circle cx="${n(endX)}" cy="${n(endY)}" r="4" class="dot-${cls}"/>\n`;
      body += text(endX + 10, endY + 4, `${label} ${num(Math.round(mb(pick(last))))} MB`, 'sub');
    }
    body += text(LEFT, base + 16, '0 s', 'muted', 'middle');
    body += text(LEFT + plotWidth, base + 16, `${num(Math.round(last.tSec))} s`, 'muted', 'middle');
  });
  return document_({
    title: 'Server memory over each run',
    desc: `Peak resident set size in MB. ${describeRuns(runs, (r) => (r.memory === undefined ? 'n/a' : `${compact(r.memory.peakRssMb)} MB`))}.`,
    height: 100 + runs.length * PANEL,
    body,
  });
}
