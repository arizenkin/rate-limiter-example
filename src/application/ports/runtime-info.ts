export interface RuntimeSample {
  readonly uptimeSeconds: number;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
}

export interface RuntimeInfo {
  sample(): RuntimeSample;
}
