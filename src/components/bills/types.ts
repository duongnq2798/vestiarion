import type { ReactNode } from "react";
import type { NextStep } from "@/components/vx/bill-next-step";
import type { Outcome } from "@/components/vx/types";
import type { Page } from "@/lib/bills-view";

/** One bill or receivable as its row shows it, before it is opened (B6). Every href is the page's own, ready to use. */
export interface BillRowItem {
  id: string;
  /** The counterparty. */
  name: string;
  /** Its memo: an invoice number, a purchase order, what it is for. */
  reference: string | null;
  amount: number | null;
  token: string;
  /** Refused by code: the amount is struck, as on its card. */
  struck: boolean;
  /** The day that matters: "Due Oct 14", "Overdue Oct 9", "Pays Oct 20". */
  date: { label: string; tone?: "held" } | null;
  outcome: Outcome;
  outcomeLabel?: string;
  /** No badge: a receivable simply awaiting payment, which its date already says. */
  quiet?: boolean;
  /** What stands in its way, a word or two each. */
  blockers: string[];
  /** Why it waits, in one line, when no check names it. */
  why?: string | null;
  /** A plain fact: what a part-paid receivable still owes. */
  note?: string | null;
  /** What it belongs to: the deal a receivable was released from. */
  context?: string | null;
  next: NextStep | null;
  /** Where a receivable's reminders stand. */
  collection?: string | null;
  /** Added in the last few minutes, while the list shows the newest first. */
  justAdded?: boolean;
  /** Its detail's address. */
  href: string;
}

export interface FilterChip {
  key: string;
  label: string;
  count: number;
  href: string;
  current: boolean;
}

export interface SortOption {
  value: string;
  label: string;
  href: string;
}

/** A tab's list: its filters, search, sort, the page shown and how to move between pages. */
export interface ListData {
  label: string;
  filters: FilterChip[];
  q: string | null;
  /** The search form's hidden fields: tab, filter and sort, so a search keeps them. */
  keep: Record<string, string>;
  clearSearchHref: string;
  sort: string;
  sorts: SortOption[];
  page: Page<BillRowItem>;
  previousHref: string | null;
  nextHref: string | null;
  /** What the list says with nothing in it. */
  empty: { title: string; body: string; action?: ReactNode };
  /** Under the search, when it finds something on the other tab too. */
  elsewhere?: { text: string; href: string } | null;
  /** Nothing to list at all: the list says so, without filters, search or order to choose from. */
  bare?: boolean;
}
