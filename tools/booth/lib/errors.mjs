// Fixed codes. Callers map them to a process exit code and never attach tokens.
export class BoothError extends Error {
  constructor(code, message, { exitCode = 1, status = 0, retryAfter = 0 } = {}) {
    super(message);
    this.name = 'BoothError';
    this.code = code;
    this.exitCode = exitCode;
    this.status = status;
    // Seconds from a Retry-After header, 0 when absent or not a number of seconds.
    this.retryAfter = retryAfter;
  }
}

export function scrub(text, secret) {
  const raw = String(text ?? '');
  if (!secret) return raw;
  return raw.split(secret).join('[redacted]');
}
