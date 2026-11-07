/** API error with an HTTP-ish status. status 0 = network / CORS / server down. */
export class ApiError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}
