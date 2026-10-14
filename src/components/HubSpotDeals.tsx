"use client";

import type { ComponentProps } from "react";
import { CrmDeals } from "@/components/CrmDeals";

/**
 * Bills & receivables' deals from HubSpot (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H11, H12, H13,
 * H20): the CRM list (`CrmDeals`) in HubSpot's words, at `#from-hubspot`, planning with `?hubspot=<row>`.
 */
export function HubSpotDeals(props: Omit<ComponentProps<typeof CrmDeals>, "provider">) {
  return <CrmDeals provider="hubspot" {...props} />;
}
