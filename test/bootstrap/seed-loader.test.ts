import { loadSeedClients } from '../../src/bootstrap/seed-loader';
import { StartupError } from '../../src/bootstrap/startup-error';
import { writeSeedFile } from '../helpers/test-app';

const entry = (over: Record<string, unknown> = {}) => ({
  client_id: 'a',
  window_seconds: 10,
  request_per_window: 5,
  ...over,
});

const load = (content: unknown) => () => loadSeedClients(writeSeedFile(content), 1000);

describe('loadSeedClients', () => {
  it('returns validated entries', () => {
    expect(
      loadSeedClients(writeSeedFile({ clients: [entry(), entry({ client_id: 'b' })] }), 1000),
    ).toEqual([entry(), entry({ client_id: 'b' })]);
  });

  it('accepts an empty client list', () => {
    expect(load({ clients: [] })()).toEqual([]);
  });

  it('loads the shipped sample file', () => {
    expect(loadSeedClients('config/clients.json', 1000).length).toBeGreaterThan(0);
  });

  it('names the file when it cannot be read', () => {
    expect(() => loadSeedClients('/definitely/missing.json', 1000)).toThrow(
      /Seed file '\/definitely\/missing\.json' could not be read: .*ENOENT/,
    );
  });

  it('rejects unparsable JSON', () => {
    expect(load('{ not json')).toThrow(/is not valid JSON/);
  });

  it.each([
    ['null', 'must contain a JSON object with a "clients" array'],
    ['[]', 'must contain a JSON object with a "clients" array'],
    [{ clients: 'nope' }, '"clients" must be an array'],
    [{}, '"clients" must be an array'],
  ])('rejects wrong top-level shape %j', (content, message) => {
    expect(load(content)).toThrow(message);
  });

  it.each([
    [
      entry({ window_seconds: 0 }),
      'clients[0]: window_seconds must be between 1 and 300 (min 1, max 300)',
    ],
    [entry({ window_seconds: 301 }), 'window_seconds must be between 1 and 300'],
    [
      entry({ request_per_window: 501 }),
      'request_per_window must be between 1 and 500 (min 1, max 500)',
    ],
    [
      entry({ client_id: 'x'.repeat(37) }),
      'client_id must be between 1 and 36 characters (min 1, max 36)',
    ],
    [entry({ client_id: '' }), 'client_id must be between 1 and 36 characters'],
    [entry({ client_id: 5 }), 'clients[0]: client_id must be a string'],
    [{ window_seconds: 1, request_per_window: 1 }, 'client_id is required'],
    [entry({ window_seconds: 1.5 }), 'window_seconds must be an integer'],
    ['text', 'clients[0]: request body must be a JSON object'],
  ])('rejects invalid entry %j', (bad, message) => {
    const error = (() => {
      try {
        load({ clients: [bad] })();
      } catch (e) {
        return e as Error;
      }
      throw new Error('expected failure');
    })();
    expect(error).toBeInstanceOf(StartupError);
    expect(error.message).toContain(message);
    expect(error.message).toContain("Seed file '");
  });

  it('reports the index of the offending entry', () => {
    expect(load({ clients: [entry(), entry({ client_id: 'b', window_seconds: 0 })] })).toThrow(
      'clients[1]',
    );
  });

  it('rejects a seed file with more clients than MAX_CLIENTS', () => {
    const content = { clients: [entry(), entry({ client_id: 'b' }), entry({ client_id: 'c' })] };
    expect(() => loadSeedClients(writeSeedFile(content), 2)).toThrow(
      '3 clients exceed the limit of 2 (MAX_CLIENTS)',
    );
    expect(loadSeedClients(writeSeedFile(content), 3)).toHaveLength(3);
  });

  it('rejects duplicate client ids', () => {
    expect(load({ clients: [entry(), entry({ window_seconds: 20 })] })).toThrow(
      "clients[1]: duplicate client_id 'a' (first defined at clients[0])",
    );
  });
});
