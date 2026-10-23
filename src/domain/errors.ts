export class UnknownClientError extends Error {
  constructor(readonly clientId: string) {
    super(`client_id '${clientId}' is not configured`);
    this.name = 'UnknownClientError';
  }
}

/** `/configure` would create a client beyond the configured maximum (HLD §5.3 mitigation). */
export class ClientLimitReachedError extends Error {
  constructor(readonly maxClients: number) {
    super(`client limit of ${maxClients} reached; existing clients can still be updated`);
    this.name = 'ClientLimitReachedError';
  }
}

/** Fail-closed outcome: the limiter could not reach a trustworthy decision (HLD §7). */
export class ServiceUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('rate limiter is unable to make a decision; treat the request as denied', options);
    this.name = 'ServiceUnavailableError';
  }
}
