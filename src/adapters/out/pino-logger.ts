import { pino, type DestinationStream } from 'pino';
import type { LogFields, Logger } from '../../application/ports/logger';

export function createPinoLogger(level: string, destination?: DestinationStream): Logger {
  const base = destination === undefined ? pino({ level }) : pino({ level }, destination);
  return {
    info: (fields: LogFields, message: string) => {
      base.info(fields, message);
    },
    warn: (fields: LogFields, message: string) => {
      base.warn(fields, message);
    },
    error: (fields: LogFields, message: string) => {
      base.error(fields, message);
    },
  };
}
