import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  clientConfigInputSchema,
  parseInput,
  type ClientConfigInput,
} from '../adapters/in/schemas';
import { StartupError } from './startup-error';

const seedFileSchema = z.object(
  { clients: z.array(z.unknown(), { error: '"clients" must be an array' }) },
  { error: 'the file must contain a JSON object with a "clients" array' },
);

/**
 * Loads and validates the static seed file (HLD §11). Any problem aborts startup with a message
 * naming the file, the offending entry/field and the violated bound; nothing is skipped.
 */
export function loadSeedClients(path: string, maxClients: number): ClientConfigInput[] {
  const fail = (detail: string): never => {
    throw new StartupError(`Seed file '${path}' is invalid: ${detail}`);
  };

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new StartupError(`Seed file '${path}' could not be read: ${(cause as Error).message}`, {
      cause,
    });
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new StartupError(`Seed file '${path}' is not valid JSON: ${(cause as Error).message}`, {
      cause,
    });
  }

  const file = parseInput(seedFileSchema, json);
  if (!file.ok) return fail(file.failure.message);

  if (file.value.clients.length > maxClients) {
    return fail(
      `${file.value.clients.length} clients exceed the limit of ${maxClients} (MAX_CLIENTS)`,
    );
  }

  const seen = new Map<string, number>();
  return file.value.clients.map((entry, index) => {
    const parsed = parseInput(clientConfigInputSchema, entry);
    if (!parsed.ok) {
      const { message, min, max } = parsed.failure;
      const bounds = min === undefined ? '' : ` (min ${min}, max ${max})`;
      return fail(`clients[${index}]: ${message}${bounds}`);
    }
    const first = seen.get(parsed.value.client_id);
    if (first !== undefined) {
      return fail(
        `clients[${index}]: duplicate client_id '${parsed.value.client_id}' (first defined at clients[${first}])`,
      );
    }
    seen.set(parsed.value.client_id, index);
    return parsed.value;
  });
}
