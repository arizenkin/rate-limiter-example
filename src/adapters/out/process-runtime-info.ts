import type { RuntimeInfo, RuntimeSample } from '../../application/ports/runtime-info';

export class ProcessRuntimeInfo implements RuntimeInfo {
  sample(): RuntimeSample {
    const usage = process.memoryUsage();
    return {
      uptimeSeconds: process.uptime(),
      rssBytes: usage.rss,
      heapUsedBytes: usage.heapUsed,
    };
  }
}
