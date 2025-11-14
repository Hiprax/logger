/**
 * Error thrown when an invalid IANA timezone identifier is provided.
 */
export class InvalidTimezoneError extends Error {
  constructor(zone: string) {
    super(`Invalid timezone identifier: ${zone}`);
    this.name = 'InvalidTimezoneError';
  }
}

