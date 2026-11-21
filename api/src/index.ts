import type { Deps, Env } from './types';
import { app } from './router';

/**
 * The core handles the request; SplitTrip adds two response headers on top (the core is shared and stays as it is):
 * nosniff, so a browser never treats a JSON reply as anything else, and no-referrer.
 */
export const handle = async (req: Request, env: Env, deps: Deps = {}): Promise<Response> => {
  const res = await app.handle(req, env, deps);
  const out = new Response(res.body, res);
  out.headers.set('x-content-type-options', 'nosniff');
  out.headers.set('referrer-policy', 'no-referrer');
  return out;
};

export default { fetch: (req: Request, env: Env) => handle(req, env) };
