// Generated from the API's OpenAPI document (/api/v1/openapi.json) by `npm run sdk:types`, with
// scripts/lib/sdk-types.ts. Do not edit it by hand: tests/sdk-types.test.ts fails when it differs from what the
// generator renders now.

/** One of a closed set, so a client can branch on it without parsing the message. */
export const API_ERROR_CODES = ["unauthorized", "forbidden", "not_found", "invalid_request", "conflict", "rate_limited", "unavailable", "internal"] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** What this workspace is, and what it can actually do. */
export interface Status {
  /** The workspace's name. */
  businessName: string;
  /** Payments and yield differ and are reported separately, as in the UI. `unavailable` means nothing can pay in the workspace now: its Circle credentials are stored but could not be read; or it is on Arc mainnet with no Circle account connected yet, or not live yet; or Arc mainnet is switched off on this deployment; or payments are switched off for every workspace, or whether they are could not be read. Cycles refuse to pay then rather than simulate, so neither leg is live or simulated. Yield is also `unavailable` on a network with no yield reserve, such as Arc mainnet. */
  provenance: {
    payments: "live" | "simulate" | "unavailable";
    yield: "live" | "simulate" | "unavailable";
    screening: "live" | "simulate";
  };
  /** The workspace's clock, and when its last cycle ran. */
  clock: {
    mode: "real" | "simulate";
    day: number;
    lastCycleAt: string | null;
  };
  /** Running totals across the workspace. */
  totals: {
    decisionsLogged: number;
    totalPaidOut: number;
    flagged: number;
  };
  /** What is configured for this workspace, as flags and modes. Never carries a secret. */
  configuration: Record<string, unknown>;
  apiVersion: "v1";
}

/** One entry of the audit chain, which the API returns oldest first. */
export interface LedgerEntry {
  /** Monotonic within a workspace, but not gap-free; the hash chain proves continuity. */
  seq: number;
  id: string;
  ts: string;
  actor: string;
  domain: string;
  action: string;
  summary: string;
  detail: Record<string, unknown>;
  /** Present so a consumer can verify the chain itself rather than trust us. */
  bodyHash: string;
  signature: string;
  prevHash: string;
  hash: string;
  /** Which key signed the entry; `null` for entries written before key identity existed. A consumer verifying for itself needs this to pick the right key. */
  signingKeyId: string | null;
}

/** The verdict of replaying the workspace's ledger: signatures, body hashes and hash continuity. */
export interface LedgerVerification {
  /** `true` verified, `false` broken, and `null` not checked, which is a third answer, not a soft failure. A workspace holding no public key has produced no evidence either way. */
  valid: boolean | null;
  checkedEntries: number;
  /** The `seq` of the first entry that failed. Absent unless `valid` is `false`. */
  brokenAt?: number;
  /** Why the verdict is what it is, when it is not a plain `true`. */
  reason?: string;
  /** Configuration problems found on the way to this verdict; not about the chain. */
  warnings?: Array<string>;
}

/** An invoice in the payable or receivable book, with the agent's reasoning. */
export interface Invoice {
  id: string;
  direction: "payable" | "receivable";
  status: string;
  amount: number;
  /** USDC or EURC: what `amount` is in, and what a payable is paid in. A EURC payable is checked against the counterparty's USDC limit at a quoted rate. */
  currency: string;
  memo: string | null;
  poReference: string | null;
  goodsReceived: boolean;
  dueDate: string;
  /** ISO timestamp the agent has committed to pay this on, once scheduled; else null. */
  scheduledFor: string | null;
  /** The early-payment discount this invoice carries, if any: the percent off and the deadline's ISO timestamp. */
  earlyPayDiscount: {
    percent: number;
    deadline: string;
  } | null;
  /** The late fee a payable carries, if any. The agent weighs it when a bill waits and when cash is short; it is never added to what is paid. */
  lateFee: {
    /** `percent_month`, a percent a month of what is still owed, or `fixed`, an amount in `currency`. */
    kind: "percent_month" | "fixed";
    /** The percent a month, or the fixed amount. */
    value: number;
    /** The first day the fee applies, as `YYYY-MM-DD`. */
    startsOn: string;
  } | null;
  decidedAt: string | null;
  settledAt: string | null;
  escalatedAt: string | null;
  /** Why the agent ruled as it did, verbatim from the decision. */
  agentReasoning: string | null;
  /** An on-chain hash once the payment settled, else null: on the workspace's network, or for a payout from a Gateway balance the mint on the payee's chain. */
  txHash: string | null;
  /** What actually left once this invoice was paid; null otherwise, even while a submitted transfer already carries an amount. */
  paidAmount: number | null;
  counterparty: {
    id: string;
    name: string;
    riskLevel: string;
  } | null;
  createdAt: string;
}

/** A vendor, client or contractor, with its risk tier and payment limits. */
export interface Counterparty {
  id: string;
  name: string;
  role: "vendor" | "client" | "contractor";
  address: string | null;
  chain: string | null;
  jurisdiction: string | null;
  riskLevel: "unscreened" | "clear" | "medium" | "high";
  riskNotes: string | null;
  /** The business's baseline payment limit for this counterparty. */
  baselinePaymentLimit: number | null;
  /** The current payment limit, derived from the risk tier. */
  paymentLimit: number | null;
  lastScreenedAt: string | null;
  /** No history is different from a zero score and remains null. */
  performanceScore: number | null;
  performanceInputs: Record<string, unknown> | null;
  createdAt: string;
}

/** A counterparty, with its recent screening history. */
export interface CounterpartyDetail {
  id: string;
  name: string;
  role: "vendor" | "client" | "contractor";
  address: string | null;
  chain: string | null;
  jurisdiction: string | null;
  riskLevel: "unscreened" | "clear" | "medium" | "high";
  riskNotes: string | null;
  /** The business's baseline payment limit for this counterparty. */
  baselinePaymentLimit: number | null;
  /** The current payment limit, derived from the risk tier. */
  paymentLimit: number | null;
  lastScreenedAt: string | null;
  /** No history is different from a zero score and remains null. */
  performanceScore: number | null;
  performanceInputs: Record<string, unknown> | null;
  createdAt: string;
  /** Up to 20 recent screenings, newest first. */
  screeningHistory: Array<{
    id: string;
    riskLevel: string;
    source: string;
    notes: string | null;
    rawScore: number | null;
    matchedEntityId: string | null;
    screeningMode: "live" | "simulate";
    status: "complete" | "failed";
    createdAt: string;
  }>;
}

/** A contractor milestone, how it was verified, and whether it was paid. */
export interface Milestone {
  id: string;
  title: string;
  amount: number;
  status: "pending" | "verified" | "paid" | "held" | "closed";
  verificationSource: string | null;
  verificationMethod: "unverified" | "github" | "manual" | "seed" | "asana" | "linear";
  verificationStatus: "unverified" | "verified" | "not_merged" | "unavailable" | "failed";
  verificationCheckedAt: string | null;
  verifiedAt: string | null;
  verificationDetail: Record<string, unknown>;
  verified: boolean;
  decidedAt: string | null;
  settledAt: string | null;
  /** When a person closed the milestone without paying it (status closed), else null. */
  closedAt: string | null;
  /** The reason the person gave for closing it without paying, else null. */
  closeReason: string | null;
  agentReasoning: string | null;
  /** An on-chain hash when the payment settled on Arc, else null. */
  txHash: string | null;
  contractor: {
    id: string;
    name: string;
    riskLevel: string;
  } | null;
  createdAt: string;
}

/** A one-time link for a payee to enter the address they are paid at. That address waits for a person in the workspace to confirm it before the agent pays to it. */
export interface PayeeLink {
  /** The link's own id. It is not the link: that is `url`. */
  id: string;
  counterpartyId: string;
  /** The one-time page where the payee enters their address. It is in this answer only: Vestiarion keeps just its hash. Send it to the payee yourself. */
  url: string;
  /** When the link stops working, 7 days after it was made. It also stops once the payee has used it, or a newer link replaces it. */
  expiresAt: string;
}

/** The workspace's accounts, reserve, obligations, latest forecast and recent treasury moves. */
export interface Treasury {
  accounts: Array<{
    id: string;
    name: string;
    kind: "operating" | "reserve" | "chain";
    chain: string;
    token: string;
    address: string | null;
    balance: number;
    apy: number;
  }>;
  /** The sum of the reserve accounts' balances. */
  reservePosition: number;
  /** From the latest cycle snapshot; null before any snapshot exists, never an invented zero. */
  obligations: {
    asOf: string | null;
    dueWithin7Days: number | null;
    dueWithin14Days: number | null;
  };
  latestForecast: {
    id: string;
    asOf: string;
    horizonDays: number;
    projectedInflow: number;
    projectedOutflow: number;
    liquidBalance: number;
    recommendation: string | null;
  } | null;
  /** Up to 20 treasury moves, newest first. */
  recentActions: Array<{
    id: string;
    action: "sweep_to_usyc" | "redeem_from_usyc" | "rebalance";
    amount: number;
    fromAccountId: string | null;
    toAccountId: string | null;
    reasoning: string | null;
    createdAt: string;
  }>;
}

/** The telemetry behind the Insights charts: the most recent transfers, cycle runs, snapshots, treasury moves and screenings, each oldest first. */
export interface Insights {
  transfers: Array<{
    id: string;
    targetType: "invoice" | "milestone";
    targetId: string;
    txRef: string;
    feeUsd: number;
    feeSource: "chain_reported" | "provider_estimate" | "simulated_profile";
    settledInMs: number | null;
    chain: string;
    providerMode: "live" | "simulate";
    executedAt: string;
    status: string;
  }>;
  runs: Array<{
    id: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    decisionCount: number;
    paidCount: number;
    heldCount: number;
    flaggedCount: number;
    awaitingInfoCount: number;
    releasedCount: number;
    modelDecisionCount: number;
    heuristicDecisionCount: number;
    guardrailOverrideCount: number;
    /** Model verdicts that chose a different action from the rule-based policy. Null for cycles run before the comparison existed, never zero, which would claim perfect agreement over decisions never compared. */
    referenceDisagreementCount: number | null;
    /** A cycle that failed partway is not a quiet cycle, and must not read as one. Its counts are real but partial: they cover the stages that ran before it stopped, and nothing after. */
    status: "running" | "completed" | "partial" | "failed";
    failedStage: string | null;
    errorMessage: string | null;
    chainMode: "live" | "simulate";
    screeningMode: "live" | "simulate";
  }>;
  snapshots: Array<{
    id: string;
    cycleRunId: string;
    capturedAt: string;
    totalLiquid: number;
    openPayables: number;
    openReceivables: number;
    obligationsDue7d: number;
    obligationsDue14d: number;
    reservePosition: number;
    chainMode: "live" | "simulate";
  }>;
  treasuryMoves: Array<{
    id: string;
    action: "sweep_to_usyc" | "redeem_from_usyc" | "rebalance";
    amount: number;
    createdAt: string;
  }>;
  screenings: Array<{
    id: string;
    counterpartyId: string;
    counterpartyName: string;
    riskLevel: string;
    previousRiskLevel: string | null;
    tierChanged: boolean;
    mode: "live" | "simulate";
    source: string;
    status: "complete" | "failed";
    createdAt: string;
  }>;
}

/** One payable's or milestone's evidence, `vestiarion-evidence/1`: the chain its evidence page shows, each fact citing the signed entries it rests on, which it carries in full. */
export interface PaymentEvidence {
  format: "vestiarion-evidence/1";
  exportedAt: string;
  /** The workspace the document is of. */
  workspace: {
    slug: string;
    name: string;
  };
  /** The workspace's network. */
  network: {
    id: "arc-testnet" | "arc-mainnet";
    /** The network's name, as the workspace's pages write it. */
    label: string;
  };
  /** The payable or milestone the evidence is of. */
  subject: {
    kind: "invoice" | "milestone";
    id: string;
    title: string;
    payee: string;
    /** The bill's or the milestone's amount. */
    amount: number;
    /** What was paid, when an early-payment discount took part of the bill off; null when the whole amount was paid, and for anything not paid. */
    paidAmount: number | null;
    currency: string;
    status: string;
    paid: boolean;
    /** Rejected by a person, or closed without paying: it will not be paid. */
    closed: boolean;
    /** Marked paid by a simulated transfer: nothing moved on chain. */
    simulated: boolean;
    /** Paid by a transaction on chain the chain shows. */
    onChain: boolean;
  };
  /** The seven words a fact is labelled with, what each means, and how many facts each holds. */
  labels: Record<string, {
    words: string;
    meaning: string;
    facts: number;
  }>;
  steps: Array<{
    id: "agreed" | "delivered" | "bill" | "payee" | "decision" | "people" | "payment" | "books" | "receipt" | "signatures";
    title: string;
    /** The step's label in words. */
    label: string;
    kind: "checked" | "verified" | "stated" | "inferred" | "missing" | "unreachable" | "contradicted";
    caveat?: string;
    facts: Array<{
      /** The fact's label in words. */
      label: string;
      kind: "checked" | "verified" | "stated" | "inferred" | "missing" | "unreachable" | "contradicted";
      text: string;
      /** Who stated it: a member by user id, "a former member", "a member" when the members could not be read, "the payee", "@<login> on GitHub" for a GitHub bounty; null when the ledger names no one. */
      who: string | null;
      at: string | null;
      /** For a missing fact: what would fill it. */
      fill?: string;
      notes?: Array<string>;
      /** A link a fact points to, and what its check found. */
      link?: {
        href: string;
        label: string;
        state: "checked" | "not_opened" | "unreachable" | "contradicted" | "cannot_open";
        reason?: string;
        /** A link a person, a payee or GitHub gave, rather than one Vestiarion built. */
        given?: true;
      };
      /** What it says is bad news, however well it is known. */
      warn?: true;
      /** The signed entries it rests on, by `seq`. */
      entries: Array<number>;
    }>;
  }>;
  /** What a signed entry proves, and what it does not. */
  signedEntryProves: string;
  /** How to check one entry alone: its body hash, its signature and its chain hash. */
  checkAnEntry: Array<string>;
  /** The workspace's public keys, active and retired, each under its id: what the entries were signed with. */
  keys: Array<{
    /** The first 16 hex characters of the SHA-256 of the key's public SPKI: a key counts only under this id. */
    id: string;
    status: "active" | "retired";
    publicKeyPem: string;
  }>;
  /** Every entry the document cites, oldest first, in full, each with the server's check. */
  entries: Array<{
    seq: number;
    id: string | null;
    ts: string;
    actor: string;
    domain: string;
    action: string;
    summary: string;
    detail: Record<string, unknown>;
    body_hash: string;
    signature: string;
    prev_hash: string;
    hash: string;
    signing_key_id: string | null;
    /** The server's check of this entry alone. A checker re-checks it rather than trust this field. */
    check: {
      ok: true;
    } | {
      ok: false;
      reason: string;
    } | {
      ok: null;
      reason: string;
    } | null;
  }>;
}

/** A payable's receipt, `vestiarion-receipt/1`: what it states, the entry that recorded it, its sharing and its checks. */
export interface PaymentReceipt {
  format: "vestiarion-receipt/1";
  exportedAt: string;
  /** The workspace the document is of. */
  workspace: {
    slug: string;
    name: string;
  };
  /** The workspace's network. */
  network: {
    id: "arc-testnet" | "arc-mainnet";
    /** The network's name, as the workspace's pages write it. */
    label: string;
  };
  invoiceId: string;
  /** Paid, confirmed, on chain, and a signed entry records its transaction: what Share receipt needs. */
  ready: boolean;
  /** Why not, when not ready. `simulated` never changes; `not_paid` and `not_minted` pass. */
  notReady: {
    code: "not_payable" | "not_paid" | "simulated" | "not_minted" | "no_transaction" | "not_recorded";
    reason: string;
  } | null;
  facts: {
    amount: number;
    token: "USDC" | "EURC";
    /** When the payment was confirmed. */
    paidAt: string;
    /** The address paid. */
    payee: string;
    /** The chain the payee was paid on. */
    chain: string;
    /** The transaction that paid the payee: the transfer on the workspace's network, or the mint on the payee's chain. */
    txHash: string;
    route: "direct" | "cctp" | "gateway";
    /** CCTP only: the burn on the workspace's network. */
    sourceTxHash?: string;
    /** CCTP and Gateway: the route's fee, in USDC. */
    feeUsdc?: number;
    /** The invoice's own number, as the vendor wrote it. */
    invoiceNumber?: string;
    /** The invoice's amount, only when it was for more than was paid: an early-payment discount. */
    invoiceAmount?: number;
    /** Who paid the fees: the sender, on top of the amount, and never the payee. */
    feesPaidBy?: "sender";
  } | null;
  /** The entry that recorded the transaction; null when not ready. */
  records: {
    seq: number;
    hash: string;
  } | null;
  /** The entry the bill was added with, which its invoice number comes from, or null. */
  invoiceEntry: number | null;
  /** When a member shared the receipt; null when no one has. */
  shared: {
    /** When a member first shared it. */
    at: string;
    /** The `receipt_shared` entry that signed the statement the payee saw. */
    entry: number;
    /** Whether its link opens now. The link itself is never in the answer. */
    linkOpen: boolean;
    changes: Array<{
      action: "receipt_link_renewed" | "receipt_revoked";
      at: string;
      entry: number;
    }>;
  } | null;
  /** The receipt's two checks; null when not ready. */
  checks: {
    /** The recording entry checked alone, and holding the transaction. */
    recorded: {
      ok: true;
    } | {
      ok: false;
      reason: string;
    } | {
      ok: null;
      reason: string;
    };
    /** The transaction as its chain records it: it matches the payment, it does not, or the chain could not be read just now. */
    onChain: {
      state: "matches";
      /** The block the transaction is in. */
      block: number;
      /** What the payee received, read from the chain's transfer. */
      received?: number;
    } | {
      state: "mismatch";
      reason: string;
    } | {
      state: "unreadable";
    };
  } | null;
  /** What a signed entry proves, and what it does not. */
  signedEntryProves: string;
  /** How to check one entry alone: its body hash, its signature and its chain hash. */
  checkAnEntry: Array<string>;
  /** The workspace's public keys, active and retired, each under its id: what the entries were signed with. */
  keys: Array<{
    /** The first 16 hex characters of the SHA-256 of the key's public SPKI: a key counts only under this id. */
    id: string;
    status: "active" | "retired";
    publicKeyPem: string;
  }>;
  /** Every entry the document cites, oldest first, in full, each with the server's check. */
  entries: Array<{
    seq: number;
    id: string | null;
    ts: string;
    actor: string;
    domain: string;
    action: string;
    summary: string;
    detail: Record<string, unknown>;
    body_hash: string;
    signature: string;
    prev_hash: string;
    hash: string;
    signing_key_id: string | null;
    /** The server's check of this entry alone. A checker re-checks it rather than trust this field. */
    check: {
      ok: true;
    } | {
      ok: false;
      reason: string;
    } | {
      ok: null;
      reason: string;
    } | null;
  }>;
}

/** Every payout address change in a period, `vestiarion-payee-lock-evidence/1`, each fact citing the signed entries it rests on. */
export interface PayeeLockEvidence {
  format: "vestiarion-payee-lock-evidence/1";
  exportedAt: string;
  /** The workspace the document is of. */
  workspace: {
    slug: string;
    name: string;
  };
  /** The workspace's network. */
  network: {
    id: "arc-testnet" | "arc-mainnet";
    /** The network's name, as the workspace's pages write it. */
    label: string;
  };
  /** Whole UTC days, `YYYY-MM-DD`; null for an open end. */
  period: {
    from: string | null;
    to: string | null;
  };
  lock: {
    /** The payee lock's setting. */
    now: {
      on: boolean;
      /** Hours a changed address waits before it can be paid; 0 is no wait. */
      coolingHours: number;
    };
    changes: Array<{
      at: string;
      /** Who did a step. */
      by: {
        kind: "member";
        userId: string;
        /** Null through the API, which names members by user id only. */
        email: string | null;
      } | {
        kind: "former_member";
        /** The first 8 characters of their user id. */
        id: string;
      } | {
        kind: "payee_link";
        linkId: string | null;
      } | {
        kind: "github";
        login: string | null;
      } | {
        kind: "unknown";
      };
      from: {
        on: boolean;
        /** Hours a changed address waits before it can be paid; 0 is no wait. */
        coolingHours: number;
      } | null;
      to: {
        on: boolean;
        /** Hours a changed address waits before it can be paid; 0 is no wait. */
        coolingHours: number;
      } | null;
      entry: number;
    }>;
  };
  summary: {
    changes: number;
    confirmed: number;
    confirmedWithRecord: number;
    confirmedBySecondPerson: number;
    heldWhileUnconfirmed: number;
    heldForTheWait: number;
    heldAsNewPayee: number;
    paid: number;
    paidOnlyAfterConfirmation: number;
  };
  changes: Array<{
    counterparty: {
      id: string;
      name: string | null;
    };
    change: {
      at: string;
      from: string | null;
      to: string | null;
      chain: string | null;
      /** Who did a step. */
      enteredBy: {
        kind: "member";
        userId: string;
        /** Null through the API, which names members by user id only. */
        email: string | null;
      } | {
        kind: "former_member";
        /** The first 8 characters of their user id. */
        id: string;
      } | {
        kind: "payee_link";
        linkId: string | null;
      } | {
        kind: "github";
        login: string | null;
      } | {
        kind: "unknown";
      };
      entry: number;
    };
    confirmation: {
      at: string;
      /** Who did a step. */
      by: {
        kind: "member";
        userId: string;
        /** Null through the API, which names members by user id only. */
        email: string | null;
      } | {
        kind: "former_member";
        /** The first 8 characters of their user id. */
        id: string;
      } | {
        kind: "payee_link";
        linkId: string | null;
      } | {
        kind: "github";
        login: string | null;
      } | {
        kind: "unknown";
      };
      /** With Confirm address (`confirm`), or by approving a payment to it (`approval`). */
      via: string | null;
      record: {
        method: "call" | "message" | "in_person" | "other" | null;
        methodLabel: string | null;
        contact: string | null;
        contactOnFileBefore: boolean;
        note: string | null;
      } | null;
      secondPerson: boolean | null;
      soloConfirmation: boolean;
      byGiver: boolean;
      giverUnknown: boolean;
      waitHours: number | null;
      payableFrom: string | null;
      lookalikeOf: Array<{
        id: string;
        name: string | null;
      }>;
      looksLikeEarlier: string | null;
      entry: number;
    } | null;
    holds: Array<{
      at: string;
      rule: string;
      subject: {
        kind: "invoice" | "milestone";
        id: string;
      } | null;
      entry: number;
    }>;
    firstPayment: {
      at: string;
      amount: number | null;
      currency: string;
      txRef: string;
      txUrl: string | null;
      decidedBy: "person" | "agent";
      subject: {
        kind: "invoice" | "milestone";
        id: string;
      } | null;
      entry: number;
    } | null;
    checks: {
      recordKept: boolean | null;
      contactOnFileBefore: boolean | null;
      secondPerson: boolean | null;
      paidAfterConfirmation: boolean | null;
      paidAfterWait: boolean | null;
    };
  }>;
  /** What a signed entry proves, and what it does not. */
  signedEntryProves: string;
  /** How to check one entry alone: its body hash, its signature and its chain hash. */
  checkAnEntry: Array<string>;
  /** The workspace's public keys, active and retired, each under its id: what the entries were signed with. */
  keys: Array<{
    /** The first 16 hex characters of the SHA-256 of the key's public SPKI: a key counts only under this id. */
    id: string;
    status: "active" | "retired";
    publicKeyPem: string;
  }>;
  /** Every entry the document cites, oldest first, in full, each with the server's check. */
  entries: Array<{
    seq: number;
    id: string | null;
    ts: string;
    actor: string;
    domain: string;
    action: string;
    summary: string;
    detail: Record<string, unknown>;
    body_hash: string;
    signature: string;
    prev_hash: string;
    hash: string;
    signing_key_id: string | null;
    /** The server's check of this entry alone. A checker re-checks it rather than trust this field. */
    check: {
      ok: true;
    } | {
      ok: false;
      reason: string;
    } | {
      ok: null;
      reason: string;
    } | null;
  }>;
}

/** A month's close pack, `vestiarion-close-pack/1`: every payment settled in it, one row each with its signed entry, the payments not settled, the escrow moves, totals, and every cited entry in full. */
export interface ClosePack {
  format: "vestiarion-close-pack/1";
  exportedAt: string;
  /** The workspace the document is of. */
  workspace: {
    slug: string;
    name: string;
  };
  /** The workspace's network. */
  network: {
    id: "arc-testnet" | "arc-mainnet";
    /** The network's name, as the workspace's pages write it. */
    label: string;
  };
  /** A calendar month in UTC. */
  month: {
    /** The first day, `YYYY-MM-DD` (UTC). */
    from: string;
    /** The next month's first day: the month runs up to it, not including it. */
    to: string;
    label: string;
    /** `YYYY-MM`. */
    key: string;
    /** Whether the month has ended: false for this month so far. */
    ended: boolean;
  };
  /** The ledger's newest entry when the pack was read. */
  ledgerHead: {
    seq: number;
    hash: string;
  } | null;
  /** The month holds more payments than one pack reads (2,000), and the pack stops there. */
  cut: boolean;
  /** Parts that could not be read just now; the rest shows. */
  unread: Array<"members" | "screening">;
  totals: {
    onChain: Array<{
      token: "USDC" | "EURC";
      payments: number;
      /** An amount as text with exactly six decimal places, never a float. */
      amount: string;
      /** An amount as text with exactly six decimal places, never a float. */
      routeFeesUsdc: string;
    }>;
    simulated: Array<{
      token: "USDC" | "EURC";
      payments: number;
      /** An amount as text with exactly six decimal places, never a float. */
      amount: string;
      /** An amount as text with exactly six decimal places, never a float. */
      routeFeesUsdc: string;
    }>;
    shadow: number;
    notSettled: Record<string, number>;
    withoutBill: number;
    entries: {
      cited: number;
      verified: number;
      failed: number;
      unchecked: number;
    };
  };
  rows: Array<{
    paymentId: string;
    source: {
      kind: "invoice" | "milestone";
      id: string;
    };
    paidAt: string;
    sentAt: string;
    /** An amount as text with exactly six decimal places, never a float. */
    amount: string;
    token: "USDC" | "EURC";
    discount: string | null;
    simulated: boolean;
    shadow: boolean;
    payee: {
      counterpartyId: string;
      name: string | null;
      address: string | null;
      bank: {
        provider: "blindpay";
        bankCode: string | null;
        last4: string | null;
        rail: string | null;
        receiverAmount: string | null;
        receiverCurrency: string | null;
        payoutId: string | null;
      } | null;
    };
    bill: {
      kind: "invoice";
      id: string;
      /** The vendor's own number. */
      number: string | null;
      /** An amount as text with exactly six decimal places, never a float. */
      amount: string;
      currency: "USDC" | "EURC";
      written: {
        amount: number;
        currency: string;
      } | null;
      dueDate: string | null;
      poReference: string | null;
      memo: string | null;
      /** The document the bill was read from, by its SHA-256; the document itself is not kept. */
      document: {
        sha256: string;
        kind: string | null;
      } | null;
      vendorDocuments: Array<{
        sha256: string;
        type: string | null;
        at: string;
        entry: number;
      }>;
      entry: number | null;
    } | {
      kind: "milestone";
      id: string;
      title: string;
      /** An amount as text with exactly six decimal places, never a float. */
      amount: string;
      currency: "USDC";
      entry: number | null;
    };
    approval: {
      authorizedBy: "code" | "person" | "two_people" | null;
      agent: {
        action: string;
        decider: string;
        guardrailRule: string | null;
        shadow: boolean;
        at: string;
        entry: number;
      } | null;
      approvals: Array<{
        /** Who did a step. */
        who: {
          kind: "member";
          userId: string;
          /** Null through the API, which names members by user id only. */
          email: string | null;
          roleNow: "owner" | "admin" | "approver" | "accountant" | "viewer" | null;
        } | {
          kind: "former_member";
          userId: string;
        } | {
          kind: "payee_link";
          linkId: string | null;
        } | {
          kind: "github";
          login: string | null;
        } | {
          kind: "unknown";
        };
        at: string;
        cosign: boolean;
        paid: boolean;
        via: string | null;
        entry: number | null;
      }>;
      verdict: {
        verdict: "agree" | "disagree";
        /** Who did a step. */
        who: {
          kind: "member";
          userId: string;
          /** Null through the API, which names members by user id only. */
          email: string | null;
          roleNow: "owner" | "admin" | "approver" | "accountant" | "viewer" | null;
        } | {
          kind: "former_member";
          userId: string;
        } | {
          kind: "payee_link";
          linkId: string | null;
        } | {
          kind: "github";
          login: string | null;
        } | {
          kind: "unknown";
        };
        at: string;
        entry: number;
      } | null;
      flags: {
        soleApprover: boolean;
        addressGiverApproved: boolean;
        firstPayment: boolean;
        fewApprovers: boolean;
      };
      address: {
        address: string;
        mirror: boolean;
        givenBy: {
          kind: "member";
          userId: string;
          /** Null through the API, which names members by user id only. */
          email: string | null;
          roleNow: "owner" | "admin" | "approver" | "accountant" | "viewer" | null;
        } | {
          kind: "former_member";
          userId: string;
        } | {
          kind: "payee_link";
          linkId: string | null;
        } | {
          kind: "github";
          login: string | null;
        } | {
          kind: "unknown";
        } | null;
        givenAt: string | null;
        confirmedBy: {
          kind: "member";
          userId: string;
          /** Null through the API, which names members by user id only. */
          email: string | null;
          roleNow: "owner" | "admin" | "approver" | "accountant" | "viewer" | null;
        } | {
          kind: "former_member";
          userId: string;
        } | {
          kind: "payee_link";
          linkId: string | null;
        } | {
          kind: "github";
          login: string | null;
        } | {
          kind: "unknown";
        } | null;
        confirmedAt: string | null;
        confirmedWith: "confirm" | "approval" | null;
        secondPerson: boolean | null;
        entries: Array<number>;
      } | null;
    };
    checks: {
      guardrails: {
        kind: "checked" | "verified" | "stated" | "inferred" | "missing" | "unreachable" | "contradicted" | "not_applicable";
        text: string;
        notes: Array<string>;
        at: string | null;
        entries: Array<number>;
        /** Bad news, however well it is known. */
        warn: boolean;
      };
      screening: {
        kind: "checked" | "verified" | "stated" | "inferred" | "missing" | "unreachable" | "contradicted" | "not_applicable";
        text: string;
        notes: Array<string>;
        at: string | null;
        entries: Array<number>;
        /** Bad news, however well it is known. */
        warn: boolean;
      };
      walletList: {
        kind: "checked" | "verified" | "stated" | "inferred" | "missing" | "unreachable" | "contradicted" | "not_applicable";
        text: string;
        notes: Array<string>;
        at: string | null;
        entries: Array<number>;
        /** Bad news, however well it is known. */
        warn: boolean;
      };
      payeeLock: {
        kind: "checked" | "verified" | "stated" | "inferred" | "missing" | "unreachable" | "contradicted" | "not_applicable";
        text: string;
        notes: Array<string>;
        at: string | null;
        entries: Array<number>;
        /** Bad news, however well it is known. */
        warn: boolean;
      };
      payTo: {
        kind: "checked" | "verified" | "stated" | "inferred" | "missing" | "unreachable" | "contradicted" | "not_applicable";
        text: string;
        notes: Array<string>;
        at: string | null;
        entries: Array<number>;
        /** Bad news, however well it is known. */
        warn: boolean;
      };
      milestone: {
        kind: "checked" | "verified" | "stated" | "inferred" | "missing" | "unreachable" | "contradicted" | "not_applicable";
        text: string;
        notes: Array<string>;
        at: string | null;
        entries: Array<number>;
        /** Bad news, however well it is known. */
        warn: boolean;
      };
    };
    transaction: {
      route: "direct" | "cctp" | "gateway" | "escrow" | "bank" | "simulated";
      txHash: string | null;
      chain: string | null;
      chainLabel: string | null;
      explorerUrl: string | null;
      sourceTxHash: string | null;
      sourceExplorerUrl: string | null;
      simulatedRef: string | null;
      note: string | null;
      networkFeeUsd: string | null;
      networkFeeSource: "chain_reported" | "provider_estimate" | "simulated_profile" | null;
      routeFeeUsdc: string | null;
      earlierAttempts: number;
    };
    /** The signed entry that records the payment: a copy of its hash and signature, which `entries` carries in full. */
    record: {
      seq: number;
      action: string;
      ts: string;
      hash: string;
      signature: string;
      signingKeyId: string | null;
      /** One entry checked alone: `true` it verifies, `false` it does not, `null` it could not be checked here, for example by a key not known here. */
      check: {
        ok: true;
      } | {
        ok: false;
        reason: string;
      } | {
        ok: null;
        reason: string;
      };
    } | null;
    books: {
      markedPaid: boolean;
      mismatch: "confirmed_not_marked_paid" | "marked_paid_not_confirmed" | "marked_paid_other_transaction" | "no_signed_entry" | null;
      booked: {
        tool: string;
        state: string;
        paymentId: string | null;
        at: string;
        entry: number;
      } | null;
    };
    evidencePath: string;
    /** Every entry the row cites, ascending. */
    entries: Array<number>;
    evidenceUrl: string;
  }>;
  notSettled: Array<{
    paymentId: string;
    source: {
      kind: "invoice" | "milestone";
      id: string;
    };
    payee: {
      counterpartyId: string;
      name: string | null;
    };
    /** An amount as text with exactly six decimal places, never a float. */
    amount: string;
    token: "USDC" | "EURC";
    simulated: boolean;
    state: "settled_later" | "waiting" | "in_flight" | "unknown" | "gateway_failed" | "failed" | "cancelled" | "not_sent" | "refunded";
    sentAt: string | null;
    settledAt: string | null;
    reason: string | null;
    txHash: string | null;
    explorerUrl: string | null;
    evidencePath: string;
    evidenceUrl: string;
  }>;
  escrow: Array<{
    kind: "funded" | "refunded";
    at: string;
    milestoneId: string;
    title: string | null;
    /** An amount as text with exactly six decimal places, never a float. */
    amount: string;
    txHash: string | null;
    explorerUrl: string | null;
    entry: number;
  }>;
  /** Each check kind's words and what it means. */
  labels: Record<string, {
    words: string;
    meaning: string;
  }>;
  /** What a signed entry proves, and what it does not. */
  signedEntryProves: string;
  /** How to check one entry alone: its body hash, its signature and its chain hash. */
  checkAnEntry: Array<string>;
  /** The workspace's public keys, active and retired, each under its id: what the entries were signed with. */
  keys: Array<{
    /** The first 16 hex characters of the SHA-256 of the key's public SPKI: a key counts only under this id. */
    id: string;
    status: "active" | "retired";
    publicKeyPem: string;
  }>;
  /** Every entry the document cites, oldest first, in full, each with the server's check. */
  entries: Array<{
    seq: number;
    id: string | null;
    ts: string;
    actor: string;
    domain: string;
    action: string;
    summary: string;
    detail: Record<string, unknown>;
    body_hash: string;
    signature: string;
    prev_hash: string;
    hash: string;
    signing_key_id: string | null;
    /** The server's check of this entry alone. A checker re-checks it rather than trust this field. */
    check: {
      ok: true;
    } | {
      ok: false;
      reason: string;
    } | {
      ok: null;
      reason: string;
    } | null;
  }>;
}

/** Where this page sits in the collection. */
export interface Page {
  /** Pass back as `?cursor=` to continue. Null when the end is reached. */
  nextCursor: string | null;
  /** Whether another page follows this one. */
  hasMore: boolean;
  /** How many items this response carries. */
  count: number;
}

/** An invoice to add. The agent decides a payable as one typed in, with every guardrail, usually within a minute. */
export interface CreateInvoiceInput {
  /** `payable`, a bill the business pays, which is the default, or `receivable`, one it is owed. */
  direction?: "payable" | "receivable";
  /** The counterparty's `id`, from `GET /api/v1/counterparties` or from the answer that added it. */
  counterpartyId: string;
  /** What it bills, in `currency`, with at most 6 decimal places. A decimal string such as `"1250.50"` keeps it exact; a number is read the same way. */
  amount: string | number;
  /** `USDC`, the default, or `EURC`. */
  currency?: "USDC" | "EURC";
  /** The day it is due, as `YYYY-MM-DD`. */
  dueDate: string;
  /** What it is for, up to 280 characters. */
  memo?: string;
  /** The purchase order it bills against, up to 100 characters. */
  poReference?: string;
  /** Whether what it bills for has arrived. Defaults to `false`. Without it, or without `poReference`, the agent asks for the missing detail instead of paying. */
  goodsReceived?: boolean;
  /** A discount for paying by `deadline`. The agent weighs it against what the cash would earn in the reserve until `dueDate`. */
  earlyPayDiscount?: {
    /** The percent off, greater than 0 and less than 100, with at most 2 decimal places. */
    percent: string | number;
    /** The last day it applies, as `YYYY-MM-DD`, on or before `dueDate`. */
    deadline: string;
  };
  /** A late fee the invoice charges once it is paid late, for a payable only. The agent weighs it when a bill waits and when cash is short; it never adds it to what is paid. */
  lateFee?: {
    /** `percent_month`, a percent a month of what is still owed, or `fixed`, an amount in `currency`. */
    kind: "percent_month" | "fixed";
    /** The percent a month, more than 0 and at most 10, with at most 2 decimal places; or the fixed amount, more than 0 and at most `amount`, with at most 6. */
    value: string | number;
    /** The first day the fee applies, as `YYYY-MM-DD`, on or after `dueDate`. Defaults to the day after `dueDate`. */
    startsOn?: string;
  } | null;
}

/** A counterparty to add. It is screened as one added in the console. */
export interface CreateCounterpartyInput {
  /** 2 to 160 characters. */
  name: string;
  /** `vendor` or `contractor`, whom the business pays, or `client`, who pays the business. */
  role: "vendor" | "client" | "contractor";
  /** Where the agent pays it. An address added through the API waits for a person in the workspace to confirm it on Counterparties; until then the agent pays nothing to it. */
  address?: string;
  /** The chain the address receives on. Defaults to the workspace's own chain: `ARC-TESTNET` on Arc testnet, `ARC` on Arc mainnet. Only a chain the workspace's network pays on is accepted (on Arc mainnet, `BASE` or `ARB` besides its own), and only a vendor can be paid on another chain than the workspace's own. */
  chain?: "ARC-TESTNET" | "BASE-SEPOLIA" | "ARB-SEPOLIA" | "ETH-SEPOLIA" | "ARC" | "BASE" | "ARB";
  /** Where it is based, up to 80 characters; screening uses it. */
  jurisdiction?: string;
  /** The most the agent pays it in one payment, in USDC, with up to 6 decimal places. Required for a vendor or a contractor. */
  paymentLimit?: string | number;
  /** Where it is emailed once a payment to it is confirmed. */
  noticeEmail?: string;
}

/** A milestone to add. It starts pending: the agent pays it only once it is verified, by GitHub or by a person, and only after its own checks. */
export interface CreateMilestoneInput {
  /** The `id` of the contractor or vendor to pay, from `GET /api/v1/counterparties` or from the answer that added it. A client is not paid for milestones. */
  contractorId: string;
  /** What was delivered, 3 to 160 characters. */
  title: string;
  /** What the work is paid, in USDC, with at most 6 decimal places. A decimal string such as `"250.00"` keeps it exact; a number is read the same way. */
  amount: string | number;
  /** A link to the delivered work: https, up to 500 characters. A GitHub pull request (`https://github.com/<owner>/<repo>/pull/<number>`) is checked by the agent, which verifies the milestone once it is merged. Any other link is evidence for the person who verifies the milestone on Contractors. */
  verificationSource?: string;
}

/** Who the link is for. */
export interface CreatePayeeLinkInput {
  /** The `id` of the vendor or contractor who is to enter the address they are paid at. A client gets no link: the agent never pays one. */
  counterpartyId: string;
}

/** The query parameters of `list-ledger-entries`. */
export interface ListLedgerEntriesParams {
  /** How many items to return. Defaults to 50; a larger value is capped at 200. */
  limit?: number;
  /** The previous response's `page.nextCursor`, passed back unchanged to continue. Opaque: never decode or construct one. A cursor this endpoint could not have issued is refused with `400`. */
  cursor?: string;
  /** Only entries in this domain. */
  domain?: string;
  /** Only entries written by this actor. */
  actor?: string;
}

/** The query parameters of `list-invoices`. */
export interface ListInvoicesParams {
  /** How many items to return. Defaults to 50; a larger value is capped at 200. */
  limit?: number;
  /** The previous response's `page.nextCursor`, passed back unchanged to continue. Opaque: never decode or construct one. A cursor this endpoint could not have issued is refused with `400`. */
  cursor?: string;
  /** Only payables, or only receivables. */
  direction?: "payable" | "receivable";
  /** Only invoices in this status. */
  status?: "pending" | "matched" | "scheduled" | "paid" | "held" | "flagged" | "awaiting_info" | "received" | "rejected";
  /** Only invoices from or to this counterparty. */
  counterpartyId?: string;
}

/** The query parameters of `list-counterparties`. */
export interface ListCounterpartiesParams {
  /** How many items to return. Defaults to 50; a larger value is capped at 200. */
  limit?: number;
  /** The previous response's `page.nextCursor`, passed back unchanged to continue. Opaque: never decode or construct one. A cursor this endpoint could not have issued is refused with `400`. */
  cursor?: string;
  /** Only counterparties with this role. */
  role?: "vendor" | "client" | "contractor";
  /** Only counterparties at this risk tier. */
  riskLevel?: "unscreened" | "clear" | "medium" | "high";
}

/** The query parameters of `list-milestones`. */
export interface ListMilestonesParams {
  /** How many items to return. Defaults to 50; a larger value is capped at 200. */
  limit?: number;
  /** The previous response's `page.nextCursor`, passed back unchanged to continue. Opaque: never decode or construct one. A cursor this endpoint could not have issued is refused with `400`. */
  cursor?: string;
  /** Only milestones in this status. */
  status?: "pending" | "verified" | "paid" | "held" | "closed";
  /** Only milestones for this contractor. */
  contractorId?: string;
}

/** The query parameters of `get-payee-lock-evidence`. */
export interface GetPayeeLockEvidenceParams {
  /** The first day, as `YYYY-MM-DD`, in UTC. Leave it out to start from the first change. */
  from?: string;
  /** The last day, included, as `YYYY-MM-DD`, in UTC. Leave it out to run to now. */
  to?: string;
}
