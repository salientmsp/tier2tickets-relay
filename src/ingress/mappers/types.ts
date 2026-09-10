// Per-product mapper contract. A ProductMapper turns a raw inbound Halo payload into
// the product-specific signals that feed generic routing (reporter email, device
// hostname, emergency flag, submitter name) and renders the Gorelo ticket description.
//
// Everything product-SHAPED lives behind this interface, so onboarding a new vendor is
// one mapper + one fixture — the generic resolver (client/location/contact/device DB
// lookups in halo.ts) and every existing path stay untouched. Generic contact/device
// resolution is NOT a mapper concern; it operates on the signals the mapper extracts.

import type { DeviceFullRow } from "../../core/db.js";
import type { PublicDeviceResponse } from "../../core/types.js";

/** A raw inbound Halo ticket payload (the first ticket object of a /tickets POST). */
export type HaloTicket = Record<string, unknown>;

/** Product-specific routing signals parsed from a raw inbound ticket. */
export interface ParsedInbound {
  /** Reporter email (explicit ticket fields, then any product-report field). "" if none. */
  email: string;
  /** Device hostname (normalized) parsed from the product report. "" if none. */
  hostname: string;
  /** Whether the submitter flagged this as an emergency (bumps ticket priority). */
  isEmergency: boolean;
  /** A submitter name carried by the payload/report, used as a contact-name fallback. "" if none. */
  reporterName: string;
  /** Parsed report key/values (e.g. the HDB report table); empty {} for free-text products. */
  report: Record<string, string>;
}

/** Resolved device detail available to the description builder (from the mirror + live agent). */
export interface MapperDeviceContext {
  /** The live Gorelo agent record, when one was fetched. */
  agent: PublicDeviceResponse | null;
  /** The mirrored device row, when one matched. */
  device: DeviceFullRow | null;
}

/** A source product's parsing + description strategy. */
export interface ProductMapper {
  /** Stable key identifying the mapper (e.g. "helpdeskButtons"). */
  readonly key: string;
  /** Parse product-specific routing signals out of the raw inbound ticket. Pure. */
  parse(t: HaloTicket): ParsedInbound;
  /**
   * Build the Gorelo ticket description HTML from the raw ticket + resolved device
   * detail. `bodyHeading` is the product's heading over the pasted body (e.g. the HDB
   * "Report Summary" vs a free-text product's "Details"). Pure — no DB/env access.
   */
  buildDescription(t: HaloTicket, device: MapperDeviceContext, bodyHeading: string): string;
}
