/**
 * Everything Vestiarion needs to know, as data rather than as ambient state.
 *
 * Thirty-one environment variables were being read directly from twelve files
 * scattered through the library, and three clients were cached in module-level
 * singletons. That combination has one consequence that matters more than
 * tidiness: **a process can serve exactly one business.** There is no way to
 * run two configurations side by side, because the second one would overwrite
 * the first's cached Supabase client and read the same `process.env`.
 *
 * That is fine for a single-tenant Next.js app and fatal for everything this
 * project is meant to become. An MCP server answering for several workspaces,
 * a Slack bot installed by more than one team, or anybody consuming Vestiarion
 * as a package, all need to say "run this cycle for *that* business" — and
 * none of them configure a library by mutating their own process environment.
 *
 * So configuration is a value. `configFromEnv()` is the only place the
 * environment is consulted, it happens once at the edge, and everything below
 * receives the result. A caller who wants two businesses builds two configs.
 *
 * Secrets live here, so this object must never be logged, serialised into a
 * response, or written to the ledger. `describeConfig()` exists for when
 * something does need to say what is configured.
 */

/** Anything shaped like an environment: process.env, a .env parse, a test fixture. */
export type EnvLike = Record<string, string | undefined>;

export type LlmProvider = "anthropic" | "openai" | "deepseek" | "heuristic";

export interface DatabaseConfig {
  url: string;
  serviceRoleKey: string;
}

export interface ChainConfig {
  circleApiKey?: string;
  circleEntitySecret?: string;
  /** Discovered from the wallet's own balances when omitted. */
  usdcTokenId?: string;
  /** Overrides the public Arc testnet RPC used to read real transaction fees. */
  arcRpcUrl?: string;
}

export interface LlmConfig {
  /** Pins a provider. Omitted means "the first configured key, in preference order". */
  provider?: LlmProvider;
  anthropic?: { apiKey: string; model?: string };
  openai?: { apiKey: string; model?: string; baseUrl?: string };
  deepseek?: { apiKey: string; model?: string; baseUrl?: string };
}

export interface ComplianceConfig {
  /** A self-hosted yente base URL, or a full OpenSanctions match endpoint. */
  openSanctionsUrl?: string;
  openSanctionsApiKey?: string;
  /** Hours a screening stays fresh. 0 re-screens every cycle. */
  rescreenIntervalHours: number;
}

export interface FollowUpConfig {
  staleAfterDays: number;
  reEscalateAfterDays: number;
}

export interface VestiarionConfig {
  /** Shown in the product. No customer name is hard-coded into the interface. */
  businessName: string;
  database: DatabaseConfig;
  chain: ChainConfig;
  llm: LlmConfig;
  compliance: ComplianceConfig;
  followUp: FollowUpConfig;
  /** PKCS8 PEM. Serverless hosts have no persistent disk to keep a key on. */
  ledgerSigningKey?: string;
  /**
   * SPKI PEM. Checking a signature needs only this half, so a host that serves
   * the audit trail without ever appending to it holds no secret at all.
   */
  ledgerPublicKey?: string;
  /**
   * Whether this deployment may sign with a key it generated itself. True in a
   * development checkout, where a throwaway key keeps `npm run dev` working
   * with no setup. False in production, where an invented key would sign
   * entries nobody can verify afterwards and would leave with the instance.
   */
  allowGeneratedLedgerKey: boolean;
  /**
   * Public halves of keys that signed earlier entries and no longer sign, as
   * one concatenated PEM bundle. Rotating a key moves its public half here, so
   * the history it signed stays verifiable instead of reading as forged.
   */
  ledgerRetiredPublicKeys?: string;
  /** Read-only token used to check whether a milestone's PR URL is merged. */
  githubToken?: string;
  /** `simulate` advances a numbered demo day; `real` uses wall-clock time. */
  clockMode: "real" | "simulate";
  /** Multiplies seeded demo amounts. Only the demo seeder consults it. */
  seedScale?: number;
}

/** Reads a positive number, falling back when absent or nonsense. */
function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Reads a non-negative number, falling back when absent or nonsense. */
function nonNegativeNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function trimmed(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

function clockModeFrom(env: EnvLike): "real" | "simulate" {
  const configured = trimmed(env.CYCLE_CLOCK_MODE)?.toLowerCase();
  if (configured === "real" || configured === "simulate") return configured;
  return env.NODE_ENV === "production" ? "real" : "simulate";
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Builds a config from a environment-shaped record — `process.env` by default,
 * but any record, which is what makes it testable without mutating globals.
 *
 * Throws on a missing database, because nothing works without one, and on a
 * pinned LLM provider whose key is absent: choosing a provider and then
 * quietly billing a different one is the failure this has always guarded
 * against. Everything else is optional and degrades to a labelled fallback.
 */
export function configFromEnv(env: EnvLike = process.env): VestiarionConfig {
  const url = trimmed(env.NEXT_PUBLIC_SUPABASE_URL);
  const serviceRoleKey = trimmed(env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !serviceRoleKey) {
    throw new ConfigError(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY — see README.md."
    );
  }

  const llm: LlmConfig = {};
  const anthropicKey = trimmed(env.ANTHROPIC_API_KEY);
  if (anthropicKey) llm.anthropic = { apiKey: anthropicKey, model: trimmed(env.ANTHROPIC_MODEL) };
  const openaiKey = trimmed(env.OPENAI_API_KEY);
  if (openaiKey) {
    llm.openai = {
      apiKey: openaiKey,
      model: trimmed(env.OPENAI_MODEL),
      baseUrl: trimmed(env.OPENAI_BASE_URL),
    };
  }
  const deepseekKey = trimmed(env.DEEPSEEK_API_KEY);
  if (deepseekKey) {
    llm.deepseek = {
      apiKey: deepseekKey,
      model: trimmed(env.DEEPSEEK_MODEL),
      baseUrl: trimmed(env.DEEPSEEK_BASE_URL),
    };
  }

  const pinned = trimmed(env.AGENT_LLM_PROVIDER)?.toLowerCase();
  if (pinned) {
    if (!["anthropic", "openai", "deepseek", "heuristic"].includes(pinned)) {
      // An unrecognised name is a typo, not a request. Silently auto-selecting
      // would spend money through a provider the operator did not name.
      throw new ConfigError(
        `AGENT_LLM_PROVIDER="${pinned}" is not one of anthropic, openai, deepseek, heuristic.`
      );
    }
    if (pinned !== "heuristic" && !llm[pinned as "anthropic" | "openai" | "deepseek"]) {
      throw new ConfigError(
        `AGENT_LLM_PROVIDER=${pinned} but no ${pinned.toUpperCase()}_API_KEY is set.`
      );
    }
    llm.provider = pinned as LlmProvider;
  }

  const screeningIsLive = !!trimmed(env.OPENSANCTIONS_API_URL);

  return {
    businessName: trimmed(env.BUSINESS_NAME) ?? "Vestiarion workspace",
    database: { url, serviceRoleKey },
    chain: {
      circleApiKey: trimmed(env.CIRCLE_API_KEY),
      circleEntitySecret: trimmed(env.CIRCLE_ENTITY_SECRET),
      usdcTokenId: trimmed(env.CIRCLE_USDC_TOKEN_ID),
      arcRpcUrl: trimmed(env.ARC_RPC_URL),
    },
    llm,
    compliance: {
      openSanctionsUrl: trimmed(env.OPENSANCTIONS_API_URL),
      openSanctionsApiKey: trimmed(env.OPENSANCTIONS_API_KEY),
      // Live screening is a network call per counterparty per cycle, so it
      // defaults to a day. The bundled list costs nothing, so it re-screens
      // every cycle — the behaviour RFB5 describes.
      rescreenIntervalHours: nonNegativeNumber(
        env.COMPLIANCE_RESCREEN_HOURS,
        screeningIsLive ? 24 : 0
      ),
    },
    followUp: {
      staleAfterDays: positiveNumber(env.FOLLOW_UP_STALE_DAYS, 3),
      reEscalateAfterDays: positiveNumber(env.FOLLOW_UP_RE_ESCALATE_DAYS, 7),
    },
    ledgerSigningKey: trimmed(env.LEDGER_SIGNING_KEY),
    ledgerPublicKey: trimmed(env.LEDGER_PUBLIC_KEY),
    allowGeneratedLedgerKey: env.NODE_ENV !== "production",
    ledgerRetiredPublicKeys: trimmed(env.LEDGER_RETIRED_PUBLIC_KEYS),
    githubToken: trimmed(env.GITHUB_TOKEN),
    // Matches what `cycleClockMode` has always done: an explicit setting wins,
    // and otherwise production runs on the wall clock while a development
    // checkout keeps the numbered demo day. Defaulting to "real" here would
    // have quietly changed how the demo behaves for everyone running locally.
    clockMode: clockModeFrom(env),
    seedScale: env.SEED_SCALE == null ? undefined : Number(env.SEED_SCALE),
  };
}

/**
 * What is configured, with nothing that could leak. Safe for logs, the ledger
 * and API responses — which is the whole reason it exists separately from the
 * config itself.
 */
export function describeConfig(config: VestiarionConfig): Record<string, unknown> {
  return {
    businessName: config.businessName,
    database: { host: safeHost(config.database.url) },
    chain: {
      circleConfigured: !!(config.chain.circleApiKey && config.chain.circleEntitySecret),
      arcRpcConfigured: !!config.chain.arcRpcUrl,
    },
    llm: {
      pinned: config.llm.provider ?? null,
      available: (["anthropic", "openai", "deepseek"] as const).filter((p) => config.llm[p]),
    },
    compliance: {
      mode: config.compliance.openSanctionsUrl ? "live" : "bundled",
      rescreenIntervalHours: config.compliance.rescreenIntervalHours,
    },
    followUp: config.followUp,
    ledgerSigningKeyProvided: !!config.ledgerSigningKey,
    // Separate from the signing key on purpose: a host that serves the audit
    // trail without appending to it holds only this half, and an operator needs
    // to see that signatures can be checked there at all.
    ledgerPublicKeyProvided: !!config.ledgerPublicKey,
    // A count, never the material: after a rotation an operator confirms the
    // old key landed in the bundle from /api/v1/status without it being echoed.
    ledgerRetiredKeyCount: (config.ledgerRetiredPublicKeys?.match(/-----BEGIN /g) ?? []).length,
    githubTokenProvided: !!config.githubToken,
    clockMode: config.clockMode,
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}
