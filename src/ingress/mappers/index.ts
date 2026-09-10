// Mapper registry. Products reference a ProductMapper (see products.ts); a request
// with no matched product falls back to the Helpdesk Buttons mapper — the historical
// default (the relay always ran HDB report parsing regardless of product match).
//
// Onboarding a new vendor whose payload differs: add a mapper module here, point its
// Product entry at it, and add a golden fixture. No existing path changes.

import type { ProductMapper } from "./types.js";
import { helpdeskButtonsMapper } from "./helpdeskButtons.js";

export { helpdeskButtonsMapper } from "./helpdeskButtons.js";
export { HALO_UNREGISTERED_EMAIL, HALO_UNREGISTERED_USER_ID } from "./helpdeskButtons.js";
export type { HaloTicket, MapperDeviceContext, ParsedInbound, ProductMapper } from "./types.js";

/** Resolve the mapper for a product's optional mapper reference, defaulting to HDB. */
export function mapperFor(mapper: ProductMapper | undefined | null): ProductMapper {
  return mapper ?? helpdeskButtonsMapper;
}
