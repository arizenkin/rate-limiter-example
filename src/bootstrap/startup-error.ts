/** A problem that prevents the service from starting; the message is shown to the operator. */
export class StartupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StartupError';
  }
}
