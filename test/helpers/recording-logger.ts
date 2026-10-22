import type { LogFields, Logger } from '../../src/application/ports/logger';

export interface LogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly fields: LogFields;
  readonly message: string;
}

export class RecordingLogger implements Logger {
  readonly entries: LogEntry[] = [];

  info(fields: LogFields, message: string): void {
    this.entries.push({ level: 'info', fields, message });
  }

  warn(fields: LogFields, message: string): void {
    this.entries.push({ level: 'warn', fields, message });
  }

  error(fields: LogFields, message: string): void {
    this.entries.push({ level: 'error', fields, message });
  }
}
