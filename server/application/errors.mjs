// Application failures carry an HTTP-compatible status without depending on request/response objects.
export class HttpError extends Error {
  constructor(status, message, reason, details = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
    Object.assign(this, details);
  }
}

