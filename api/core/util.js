// @ts-check

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} [message]   not sent to the client
   * @param {Record<string, unknown>} [extra]   extra fields for the JSON error body, e.g. { currentVersion: 3 }.
   *   `error` is always the code and cannot be overridden. Without extra fields the reply is exactly `{ error: code }`.
   */
  constructor(status, code, message, extra) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }

  /** The JSON error body: the extra fields (if any), then `error`. */
  body() {
    return { ...this.extra, error: this.code };
  }
}
/** @param {string} code @param {string} [msg] @param {Record<string, unknown>} [extra] */
export const bad = (code, msg, extra) => new HttpError(400, code, msg, extra);
export const notFound = () => new HttpError(404, 'not_found');
/** @param {string} [code] @param {Record<string, unknown>} [extra] */
export const forbidden = (code = 'forbidden', extra) => new HttpError(403, code, undefined, extra);
/** @param {string} code @param {Record<string, unknown>} [extra] */
export const conflict = (code, extra) => new HttpError(409, code, undefined, extra);

/** @param {unknown} data @param {number} [status] */
export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

export const newId = () => crypto.randomUUID();

/** ISO-8601 UTC with 6 fractional digits, the same width the importer writes, so text ordering matches time ordering. */
export const nowIso = (ms = Date.now()) => new Date(ms).toISOString().replace('Z', '000Z');

/** @param {string} s */
export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const MAX_BODY_CHARS = 100_000;

/**
 * Reads a JSON object from the request body. The body is read as text, in pieces, and refused with 400 body_too_large as
 * soon as it passes `maxChars` characters. The Content-Length header is not trusted (it may be missing or wrong).
 * @param {Request} req
 * @param {number} [maxChars]   the limit in characters (default 100,000)
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJson(req, maxChars = MAX_BODY_CHARS) {
  // A header that already says "huge" saves reading anything (4 bytes is the most one character takes in UTF-8).
  if (Number(req.headers.get('content-length') ?? 0) > maxChars * 4) throw bad('body_too_large');
  let text = '';
  if (req.body) {
    const reader = req.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > maxChars) { await reader.cancel(); throw bad('body_too_large'); }
    }
    text += decoder.decode();
    if (text.length > maxChars) throw bad('body_too_large');
  }
  /** @type {unknown} */
  let v;
  try { v = JSON.parse(text); } catch { throw bad('invalid_json'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('invalid_json');
  return /** @type {Record<string, unknown>} */ (v);
}

/**
 * The exact origins allowed to call the API from a browser. `*` is never accepted.
 * @param {{ ALLOWED_ORIGINS?: string }} env
 * @returns {string[]}
 */
export function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean).filter(o => o !== '*');
}
