import { Writable } from 'node:stream';
import { PerformanceClock } from '../../../src/adapters/out/performance-clock';
import { createPinoLogger } from '../../../src/adapters/out/pino-logger';
import { ProcessRuntimeInfo } from '../../../src/adapters/out/process-runtime-info';

describe('PerformanceClock', () => {
  it('is monotonic', () => {
    const clock = new PerformanceClock();
    const a = clock.nowMs();
    expect(clock.nowMs()).toBeGreaterThanOrEqual(a);
  });
});

describe('ProcessRuntimeInfo', () => {
  it('samples uptime and memory', () => {
    const sample = new ProcessRuntimeInfo().sample();
    expect(sample.uptimeSeconds).toBeGreaterThan(0);
    expect(sample.rssBytes).toBeGreaterThan(0);
    expect(sample.heapUsedBytes).toBeGreaterThan(0);
  });
});

describe('createPinoLogger', () => {
  const capture = () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    return { lines, stream };
  };

  it('writes structured JSON for each level', () => {
    const { lines, stream } = capture();
    const logger = createPinoLogger('info', stream);
    logger.info({ a: 1 }, 'hello');
    logger.warn({ b: 2 }, 'careful');
    logger.error({ c: 3 }, 'boom');
    const parsed = lines.map((l) => JSON.parse(l) as { msg: string; level: number });
    expect(parsed.map((p) => p.msg)).toEqual(['hello', 'careful', 'boom']);
    expect(parsed.map((p) => p.level)).toEqual([30, 40, 50]);
    expect(parsed[0]).toMatchObject({ a: 1 });
  });

  it('respects the configured level', () => {
    const { lines, stream } = capture();
    createPinoLogger('error', stream).info({}, 'hidden');
    expect(lines).toEqual([]);
  });

  it('logs to stdout by default', () => {
    const write = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      createPinoLogger('silent').info({}, 'x');
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });
});
