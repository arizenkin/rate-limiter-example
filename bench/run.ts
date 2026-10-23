import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApiKeyPair } from '../src/adapters/out/sha256-api-key-verifier';
import { fetchMetrics, startMemorySampler } from './harness/sampler';
import { runLoad, seedClients } from './harness/load';
import { spawnServer, type TargetServer } from './harness/server';
import { summarizeMemory } from './lib/memory';
import { diffMetrics } from './lib/metrics-diff';
import { parseOptions, redactOptions, resolveTarget, UsageError, USAGE } from './lib/options';
import { evaluate, renderMarkdown, type BenchReport } from './lib/report';
import { buildPlan, RATELIMIT_ROUTE, seedBodies } from './lib/requests';

async function main(): Promise<number> {
  if (process.argv.includes('--help')) {
    console.log(USAGE);
    return 0;
  }
  const options = parseOptions(process.argv.slice(2), process.env);
  // When spawning, the harness mints a throwaway admin key and gives the server only its hash.
  const pair = options.url === undefined ? createApiKeyPair(randomBytes(32)) : undefined;
  const spawned: TargetServer | undefined = pair && (await spawnServer(pair.hash));
  const { url, apiKey } = resolveTarget(
    options,
    pair && spawned && { url: spawned.url, key: pair.key },
  );

  try {
    console.log(`Seeding ${options.clients} client(s) on ${url} ...`);
    await seedClients(url, apiKey, seedBodies(options));
    const plan = buildPlan(options);

    if (options.warmupSec > 0) {
      console.log(`Warming up for ${options.warmupSec}s ...`);
      await runLoad(url, options, apiKey, options.warmupSec, plan);
    }

    console.log(`Running ${options.mode} test for ${options.durationSec}s ...`);
    const before = await fetchMetrics(url, apiKey);
    const startedAt = new Date().toISOString();
    const sampler = startMemorySampler(url, apiKey);
    const client = await runLoad(url, options, apiKey, options.durationSec, plan);
    const memorySamples = sampler.stop();
    const after = await fetchMetrics(url, apiKey);

    const server = before && after ? diffMetrics(before, after, RATELIMIT_ROUTE) : undefined;
    const checks = evaluate(redactOptions(options), client, server);
    const report: BenchReport = {
      startedAt,
      target: url,
      options: redactOptions(options),
      client,
      server,
      memory: summarizeMemory(memorySamples),
      memorySamples,
      checks,
      passed: checks.every((c) => c.pass),
    };

    const markdown = renderMarkdown(report);
    mkdirSync(options.outDir, { recursive: true });
    const base = join(options.outDir, `${startedAt.replace(/[:.]/g, '-')}-${options.mode}`);
    writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
    writeFileSync(`${base}.md`, markdown);
    console.log(`\n${markdown}\nReports written to ${base}.json and ${base}.md`);
    return report.passed ? 0 : 1;
  } finally {
    await spawned?.stop();
  }
}

main().then(
  (code) => {
    process.exit(code);
  },
  (error: unknown) => {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${USAGE}`);
      process.exit(2);
    }
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
