import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, availableParallelism, cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { format, resolveConfig } from 'prettier';
import { latencyChart, memoryChart, throughputChart } from './lib/charts';
import {
  describeEnvironment,
  FRIENDLY_NAMES,
  MODES,
  parseReport,
  pickLatest,
  renderReadme,
  type PublishedRun,
} from './lib/publish';

const USAGE = `Usage: pnpm bench:publish [--from <dir>] [--out <dir>]

Copies the newest report of each benchmark mode from --from (default bench/reports) into
--out (default docs/benchmarks) under friendly names, draws the charts and writes the README.`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      from: { type: 'string', default: 'bench/reports' },
      out: { type: 'string', default: 'docs/benchmarks' },
      help: { type: 'boolean' },
    },
    strict: true,
  });
  if (values.help === true) {
    console.log(USAGE);
    return 0;
  }
  const { from, out } = values;

  const latest = pickLatest(readdirSync(from));
  const runs: PublishedRun[] = [];
  const copies: [string, string][] = [];
  for (const mode of MODES) {
    const files = latest[mode];
    if (files === undefined) continue;
    const report = parseReport(files.json, readFileSync(join(from, files.json), 'utf8'));
    if (report.options.mode !== mode) {
      throw new Error(
        `${files.json} is named for ${mode} but contains a ${report.options.mode} run`,
      );
    }
    runs.push({ mode, report });
    for (const ext of ['json', 'md'] as const) {
      copies.push([join(from, files[ext]), join(out, 'data', `${FRIENDLY_NAMES[mode]}.${ext}`)]);
    }
    console.log(`${mode}: ${files.json}`);
  }
  if (runs.length === 0) {
    console.error(`No benchmark reports found in ${from}. Run pnpm bench first.`);
    return 1;
  }

  mkdirSync(join(out, 'data'), { recursive: true });
  mkdirSync(join(out, 'charts'), { recursive: true });
  for (const [source, target] of copies) copyFileSync(source, target);
  writeFileSync(join(out, 'charts', 'latency.svg'), latencyChart(runs));
  writeFileSync(join(out, 'charts', 'throughput.svg'), throughputChart(runs));
  writeFileSync(join(out, 'charts', 'memory.svg'), memoryChart(runs));

  const cpu = cpus();
  const readme = renderReadme({
    runs,
    environment: describeEnvironment({
      nodeVersion: process.version,
      platform: platform(),
      arch: arch(),
      release: release(),
      cpuModel: cpu[0]?.model ?? 'unknown CPU',
      cpuCount: availableParallelism(),
      totalMemBytes: totalmem(),
    }),
  });
  const readmePath = join(out, 'README.md');
  const options = (await resolveConfig(readmePath)) ?? {};
  writeFileSync(readmePath, await format(readme, { ...options, filepath: readmePath }));
  console.log(`Wrote ${out}/ (${runs.length} test${runs.length === 1 ? '' : 's'}, 3 charts)`);
  return 0;
}

main().then(
  (code) => {
    process.exit(code);
  },
  (error: unknown) => {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
    ) {
      console.error(`${error.message}\n\n${USAGE}`);
      process.exit(2);
    }
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
