export function extractErrorMessage(err: any): string {
  if (!err) return 'Unknown generation error';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  if (err.title && err.message) return `${err.title}: ${err.message}`;
  if (err.title) return err.title;
  if (err.error) return typeof err.error === 'string' ? err.error : extractErrorMessage(err.error);
  try {
    return JSON.stringify(err);
  } catch (_) {
    return String(err);
  }
}

// Node's fetch reports every transport-level failure as the bare string "fetch failed";
// the real reason (ENOTFOUND, ECONNRESET, certificate, ...) only lives on err.cause.
export function describeFetchError(err: any): string {
  const base = err?.message || String(err);
  const cause = err?.cause;
  const detail = cause?.code || cause?.errno || cause?.message;
  return detail && detail !== base ? `${base} (${detail})` : base;
}

// True when the request never got an answer from the server (as opposed to an API error).
export function isTransportError(err: any): boolean {
  if (!err) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return false;
  return err.name === 'TypeError' || !!err.cause;
}
