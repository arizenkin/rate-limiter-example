import {
  clientConfigInputSchema,
  parseInput,
  rateLimitRequestSchema,
} from '../../../src/adapters/in/schemas';

describe('parseInput', () => {
  it('returns the parsed value and strips unknown keys', () => {
    expect(parseInput(rateLimitRequestSchema, { client_id: 'a', resource: 'b', x: 1 })).toEqual({
      ok: true,
      value: { client_id: 'a', resource: 'b' },
    });
  });

  it('reports field and bounds for range errors only', () => {
    expect(
      parseInput(clientConfigInputSchema, {
        client_id: 'a',
        window_seconds: 999,
        request_per_window: 1,
      }),
    ).toEqual({
      ok: false,
      failure: {
        message: 'window_seconds must be between 1 and 300',
        field: 'window_seconds',
        min: 1,
        max: 300,
      },
    });
    expect(
      parseInput(clientConfigInputSchema, {
        client_id: 'a',
        window_seconds: 'x',
        request_per_window: 1,
      }),
    ).toEqual({
      ok: false,
      failure: { message: 'window_seconds must be an integer', field: 'window_seconds' },
    });
  });

  it('reports only a message when the body is not an object', () => {
    expect(parseInput(clientConfigInputSchema, [])).toEqual({
      ok: false,
      failure: { message: 'request body must be a JSON object' },
    });
  });
});
