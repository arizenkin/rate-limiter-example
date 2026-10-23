import type { IncomingMessage } from 'node:http';
import { ClientAbortedError, payloadTooLarge } from './http-errors';

/** Reads the request body as UTF-8 text, refusing anything larger than `maxBytes` (413). */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > maxBytes) {
      reject(payloadTooLarge(maxBytes));
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onAbort);
      req.off('close', onAbort);
    };
    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        cleanup();
        req.resume();
        reject(payloadTooLarge(maxBytes));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onAbort = () => {
      cleanup();
      reject(new ClientAbortedError());
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onAbort);
    req.on('close', onAbort);
  });
}
