export interface MemorySample {
  readonly tSec: number;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
}

export interface MemorySummary {
  readonly samples: number;
  readonly startRssMb: number;
  readonly peakRssMb: number;
  readonly endRssMb: number;
  readonly growthRssMb: number;
  readonly peakHeapMb: number;
  readonly endHeapMb: number;
}

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 100) / 100;

/** Summarises the server's own memory readings taken during the run; undefined without samples. */
export function summarizeMemory(samples: readonly MemorySample[]): MemorySummary | undefined {
  const first = samples[0];
  const last = samples.at(-1);
  if (first === undefined || last === undefined) return undefined;
  return {
    samples: samples.length,
    startRssMb: mb(first.rssBytes),
    peakRssMb: mb(Math.max(...samples.map((s) => s.rssBytes))),
    endRssMb: mb(last.rssBytes),
    growthRssMb: mb(last.rssBytes - first.rssBytes),
    peakHeapMb: mb(Math.max(...samples.map((s) => s.heapUsedBytes))),
    endHeapMb: mb(last.heapUsedBytes),
  };
}
