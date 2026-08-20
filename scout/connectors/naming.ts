/**
 * How a request URL maps to a file name.
 *
 * Lives in its own module because both the fixture transport and the offline
 * transport need it: if either owned it, the two would import each other.
 */

import type { TransportRequest } from '../contracts/index.ts';
import { shortHash } from '../runtime/hash.ts';

/** Stable file name for a request. Same URL in, same name out, forever. */
export function fixtureNameFor(req: TransportRequest): string {
  const url = new URL(req.url);
  const host = url.hostname.replace(/[^a-z0-9]+/gi, '-');
  const path = url.pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root';
  const query = url.search ? `-${shortHash(url.search + (req.body ?? ''))}` : '';
  return `${host}__${path}${query}.json`;
}
