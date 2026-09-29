import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import GoLivePanel, { GO_LIVE_CONSEQUENCES, type GoLivePanelProps } from "@/components/GoLivePanel";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { GoLiveStatus } from "@/lib/platform/go-live";

/**
 * The Go live section of Settings, as the markup it renders on the server
 * (the `tests/control-ui.test.tsx` shape: vitest's `node` environment, no
 * DOM). The server actions are stand-ins: the panel only hands them to its
 * forms.
 */

vi.mock("@/app/actions/go-live", () => ({
  chooseHostedWalletAction: vi.fn(),
  connectCircleAction: vi.fn(),
  createWalletsAction: vi.fn(),
  goLiveAction: vi.fn(),
  refreshBalanceAction: vi.fn(),
}));

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
/** The text a reader sees, tags dropped. */
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'");

const OPERATING = "0x" + "ab".repeat(20);
const RESERVE = "0x" + "cd".repeat(20);
const WALLETS: GoLiveStatus["wallets"] = [
  { accountName: "Operating", kind: "operating", address: OPERATING },
  { accountName: "Reserve", kind: "reserve", address: RESERVE },
];

function status(overrides: Partial<GoLiveStatus> = {}): GoLiveStatus {
  return {
    step: "connect", connected: false, host: null, hostedAvailable: false, wallets: [], liveSince: null, credentialsUnreadable: false,
    ...overrides,
  };
}

const STEPS: Record<GoLiveStatus["step"], GoLiveStatus> = {
  connect: status(),
  wallets: status({ step: "wallets", connected: true, wallets: [WALLETS[0]] }),
  go_live: status({ step: "go_live", connected: true, wallets: WALLETS }),
  live: status({ step: "live", connected: true, wallets: WALLETS, liveSince: "2026-09-30T09:00:00Z" }),
};

function panel(step: GoLiveStatus | GoLiveStatus["step"], canAdminister = true) {
  return html(<GoLivePanel orgSlug="acme" status={typeof step === "string" ? STEPS[step] : step} canAdminister={canAdminister} />);
}

/** Every `<input>` whose name is one of the two Circle credentials. */
const secretInputs = (markup: string) => [...markup.matchAll(/<input[^>]*name="(?:apiKey|entitySecret)"[^>]*>/g)].map((match) => match[0]);

function expectIgnoredByPasswordManagers(markup: string) {
  const inputs = secretInputs(markup);
  expect(inputs).toHaveLength(2);
  for (const input of inputs) {
    expect(input).toContain('type="password"');
    // Browsers ignore autocomplete="off" on a password field; a one-time code is neither saved nor filled (as in TryIt).
    expect(input).toContain('autoComplete="one-time-code"');
    expect(input).not.toContain('autoComplete="off"');
    expect(input).toContain('data-1p-ignore="true"');
    expect(input).toContain('data-lpignore="true"');
    expect(input).toContain('data-bwignore="true"');
    expect(input).toContain('spellCheck="false"');
    // Nothing is ever filled back in: a stored credential never reaches the page.
    expect(input).not.toMatch(/\svalue=/);
  }
}

describe("GoLivePanel, for every viewer", () => {
  it("is a section titled Go live", () => {
    const markup = panel("connect", false);
    expect(markup).toMatch(/<section[^>]*aria-labelledby="go-live-title"/);
    expect(markup).toMatch(/<h2 id="go-live-title"[^>]*>Go live<\/h2>/);
  });

  it("says a workspace that has not connected Circle is a sandbox with simulated payments", () => {
    expect(text(panel("connect"))).toContain("Sandbox · simulated payments");
    expect(text(panel("connect", false))).toContain("Sandbox · simulated payments");
  });

  it.each(["wallets", "go_live"] as const)("says a connected %s sandbox pays for real when a cycle is run by hand", (step) => {
    for (const canAdminister of [true, false]) {
      const words = text(panel(step, canAdminister));
      expect(words).toContain("Sandbox · connected to Circle — cycles you run by hand pay for real");
      expect(words).not.toContain("simulated payments");
    }
  });

  it("says a live workspace is live", () => {
    expect(text(panel("live"))).toContain("Live · paying on Arc testnet");
    expect(text(panel("live", false))).toContain("Live · paying on Arc testnet");
  });
});

describe("GoLivePanel, for an owner", () => {
  it("connect: two masked inputs and a Connect button, saying where the values come from and that they are never shown again", () => {
    const markup = panel("connect");
    expectIgnoredByPasswordManagers(markup);
    expect(markup).toContain('<input type="hidden" name="orgSlug" value="acme"/>');
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>(?:(?!<\/button>).)*Connect Circle<\/button>/);
    const words = text(markup);
    expect(words).toContain("Circle developer console");
    expect(words).toContain("encrypted");
    expect(words).toContain("never shown again");
    expect(words).not.toContain("Replace Circle credentials");
    expect(words).not.toContain("Create treasury wallets");
  });

  it("wallets: a Create treasury wallets button, and the counterparty address note linked to Counterparties", () => {
    const markup = panel("wallets");
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>(?:(?!<\/button>).)*Create treasury wallets<\/button>/);
    expect(markup).toContain('href="/o/acme/counterparties"');
    const words = text(markup);
    expect(words).toContain("paid only at a real address");
    // The wallets created so far stay visible while the rest are made.
    expect(words).toContain(OPERATING);
  });

  it("go_live: the operating address with a copy button, the faucet, the balance line and a Go live button", () => {
    const markup = panel("go_live");
    const words = text(markup);
    expect(words).toContain(OPERATING);
    expect(markup).toContain('aria-label="Copy the operating wallet address"');
    expect(markup).toContain('href="https://faucet.circle.com"');
    expect(words).toContain("select Arc Testnet");
    expect(words).toContain("USDC on chain");
    expect(markup).toMatch(/<button[^>]*>(?:(?!<\/button>).)*Refresh<\/button>/);
    // The trigger that opens the confirmation; the dialog itself is portalled, so it renders only when open.
    expect(markup).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>(?:(?!<\/button>).)*Go live<\/button>/);
    expect(markup).toMatch(/<form[^>]*id="go-live-form"/);
    expect(words).not.toContain("Create treasury wallets");
  });

  it("go_live: the confirmation states the three consequences of spec §2", () => {
    const words = text(html(<>{GO_LIVE_CONSEQUENCES}</>));
    expect(words).toContain("Real testnet USDC moves when the agent pays");
    expect(words).toContain("runs every 6 hours");
    expect(words).toContain("no longer deleted when inactive");
  });

  it("live: the addresses, live since, and the cadence, with no step left to take", () => {
    const markup = panel("live");
    const words = text(markup);
    expect(words).toContain(OPERATING);
    expect(words).toContain(RESERVE);
    expect(words).toContain("Live since 2026-09-30 09:00 UTC");
    expect(words).toContain("Runs every 6 hours; pause the agent from the console to stop it.");
    expect(markup).toContain('href="/o/acme/console"');
    expect(words).not.toContain("Create treasury wallets");
    expect(markup).not.toContain('id="go-live-form"');
    expect(markup).not.toContain('href="https://faucet.circle.com"');
  });

  it("live, for the founding workspace: no live-since when the ledger has none", () => {
    const words = text(panel(status({ step: "live", connected: true, wallets: WALLETS, liveSince: null })));
    expect(words).not.toContain("Live since");
    expect(words).toContain("Runs every 6 hours");
  });

  it.each(["wallets", "go_live", "live"] as const)("%s: a Replace Circle credentials disclosure holding the same form", (step) => {
    const markup = panel(step);
    expect(markup).toMatch(/<details[^>]*>\s*<summary[^>]*>(?:(?!<\/summary>).)*Replace Circle credentials/);
    expectIgnoredByPasswordManagers(markup);
  });

  it("live: the replace form warns that the credentials must open the same Circle account", () => {
    expect(text(panel("live"))).toContain("same Circle account");
  });

  it.each(["wallets", "go_live", "live"] as const)("%s: once the operating wallet exists, the replace form says another account is refused (R4)", (step) => {
    expect(text(panel(step))).toContain("Credentials for another account are refused.");
  });

  it.each(["wallets", "go_live", "live"] as const)("%s: the replace form says the entity secret cannot be confirmed once wallets exist (R5)", (step) => {
    expect(text(panel(step))).toContain(
      "Vestiarion can confirm the API key and the wallets, but not the entity secret once wallets exist; if payments start failing with the entity secret rejected, pause the agent and reconnect with the right one."
    );
  });
});

describe("GoLivePanel, for anyone who is not an owner", () => {
  it.each(["connect", "wallets", "go_live", "live"] as const)("%s: never a form, an input or a step control", (step) => {
    const markup = panel(step, false);
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("Replace Circle credentials");
    expect(markup).not.toContain("Create treasury wallets");
    expect(markup).not.toContain('href="https://faucet.circle.com"');
    expect(markup).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*Go live<\/button>/);
  });

  it.each(["connect", "wallets", "go_live"] as const)("%s: only the status, and who can take the workspace live", (step) => {
    const words = text(panel(step, false));
    expect(words).toContain("An owner can connect Circle");
    expect(words).not.toContain(OPERATING);
  });

  it("live: the status and the wallet addresses", () => {
    const words = text(panel("live", false));
    expect(words).toContain(OPERATING);
    expect(words).toContain(RESERVE);
    expect(words).toContain("Live since 2026-09-30 09:00 UTC");
  });
});

describe("GoLivePanel, with credentials this deployment cannot read", () => {
  it("warns a non-owner, and shows no step or form", () => {
    const markup = panel(status({ step: "live", connected: true, wallets: WALLETS, credentialsUnreadable: true }), false);
    const words = text(markup);
    expect(words).toContain("Circle credentials cannot be read");
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("<input");
    expect(words).not.toContain("Replace Circle credentials");
    expect(words).not.toContain(OPERATING);
  });

  it("warns an owner, and offers the reconnect form the message asks for", () => {
    const markup = panel(status({ step: "live", connected: true, wallets: WALLETS, credentialsUnreadable: true }), true);
    const words = text(markup);
    expect(words).toContain("Circle credentials cannot be read");
    expect(words).toContain("Replace Circle credentials");
    expect(words).not.toContain(OPERATING);
  });
});

const HOSTED_LABEL = "Hosted by Vestiarion · Arc testnet · no real money";

const HOSTED: Record<Exclude<GoLiveStatus["step"], "connect">, GoLiveStatus> = {
  wallets: status({ step: "wallets", host: "hosted", hostedAvailable: true }),
  go_live: status({ step: "go_live", host: "hosted", hostedAvailable: true, wallets: WALLETS }),
  live: status({ step: "live", host: "hosted", hostedAvailable: true, wallets: WALLETS, liveSince: "2026-09-30T09:00:00Z" }),
};

describe("GoLivePanel, where the deployment offers hosted testnet wallets", () => {
  const offered = status({ hostedAvailable: true });

  it("connect: the hosted wallet first, recommended and labelled, as one button, then the own-account form", () => {
    const markup = panel(offered);
    const words = text(markup);
    expect(words).toContain(HOSTED_LABEL);
    expect(words).toContain("Recommended");
    const hosted = markup.search(/<button[^>]*type="submit"[^>]*>(?:(?!<\/button>).)*Use a Vestiarion testnet wallet<\/button>/);
    const own = markup.search(/<summary[^>]*>(?:(?!<\/summary>).)*Connect your own Circle account/);
    expect(hosted).toBeGreaterThan(-1);
    expect(own).toBeGreaterThan(hosted);
    // The hosted choice is its own form: the org, and nothing else.
    const hostedForm = markup.slice(markup.lastIndexOf("<form", hosted), hosted);
    expect(hostedForm).toContain('<input type="hidden" name="orgSlug" value="acme"/>');
    expect(hostedForm).not.toContain('name="apiKey"');
    // The own-account form is still there, unchanged.
    expectIgnoredByPasswordManagers(markup);
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>(?:(?!<\/button>).)*Connect Circle<\/button>/);
    expect(words).toContain("never shown again");
  });

  it("connect, without the platform pair: no hosted choice, only the existing form", () => {
    const words = text(panel("connect"));
    expect(words).not.toContain("Vestiarion testnet wallet");
    expect(words).not.toContain(HOSTED_LABEL);
    expect(words).not.toContain("Recommended");
    expect(words).not.toContain("Connect your own Circle account");
    expect(words).toContain("Connect your Circle account");
    expectIgnoredByPasswordManagers(panel("connect"));
  });

  it("connect, for a non-owner: no choice and no form", () => {
    const markup = panel(offered, false);
    expect(markup).not.toContain("<form");
    expect(text(markup)).not.toContain("Use a Vestiarion testnet wallet");
  });

  it.each(["wallets", "go_live"] as const)("%s, hosted: the status says Sandbox · hosted testnet wallet", (step) => {
    for (const canAdminister of [true, false]) {
      const words = text(panel(HOSTED[step], canAdminister));
      expect(words).toContain("Sandbox · hosted testnet wallet");
      expect(words).not.toContain("connected to Circle");
    }
  });

  it.each([
    ["wallets", status({ step: "wallets", host: "hosted", hostedAvailable: true, wallets: [WALLETS[0]] })],
    ["go_live", HOSTED.go_live],
  ] as const)("%s, hosted, once wallets exist: the status says cycles run by hand pay testnet USDC, and wraps", (_step, state) => {
    for (const canAdminister of [true, false]) {
      const markup = panel(state, canAdminister);
      expect(text(markup)).toContain("Sandbox · hosted testnet wallet — cycles you run by hand pay testnet USDC");
      // The long line wraps inside the badge at 360 px, like the connected one.
      expect(markup).toMatch(/<span class="[^"]*whitespace-normal[^"]*"[^>]*>(?:(?!<\/span>).)*<\/span>Sandbox · hosted testnet wallet — /);
    }
  });

  it("wallets, hosted, before any wallet exists: the status does not say cycles pay", () => {
    const words = text(panel(HOSTED.wallets));
    expect(words).toContain("Sandbox · hosted testnet wallet");
    expect(words).not.toContain("cycles you run by hand");
  });

  it("live, hosted: the status says Live · hosted testnet wallet on Arc", () => {
    const words = text(panel(HOSTED.live));
    expect(words).toContain("Live · hosted testnet wallet on Arc");
    expect(words).not.toContain("Live · paying on Arc testnet");
  });

  it("wallets, hosted: the wallets are created in Vestiarion's testnet account", () => {
    const words = text(panel(HOSTED.wallets));
    expect(words).toContain("in Vestiarion's testnet account");
    expect(words).not.toContain("in a wallet set in your own Circle account");
    expect(words).not.toContain("proves the entity secret");
  });

  it.each(["go_live", "live"] as const)("%s, hosted: no Replace Circle credentials, one line saying to start a new workspace", (step) => {
    const markup = panel(HOSTED[step]);
    const words = text(markup);
    expect(words).not.toContain("Replace Circle credentials");
    expect(secretInputs(markup)).toHaveLength(0);
    expect(words).toContain("To use your own Circle account, start a new workspace.");
  });

  it("wallets, hosted, before any wallet exists: the owner may still switch to their own account (H4)", () => {
    const markup = panel(HOSTED.wallets);
    const words = text(markup);
    expect(words).not.toContain("Replace Circle credentials");
    expect(words).not.toContain("start a new workspace");
    expect(markup).toMatch(/<summary[^>]*>(?:(?!<\/summary>).)*Connect your own Circle account instead/);
    expectIgnoredByPasswordManagers(markup);
  });

  it("wallets, hosted, once a wallet exists: the choice is fixed", () => {
    const markup = panel(status({ step: "wallets", host: "hosted", hostedAvailable: true, wallets: [WALLETS[0]] }));
    expect(text(markup)).toContain("To use your own Circle account, start a new workspace.");
    expect(secretInputs(markup)).toHaveLength(0);
  });

  it("hosted, for a non-owner: neither the line nor a form", () => {
    const markup = panel(HOSTED.go_live, false);
    expect(markup).not.toContain("<form");
    expect(text(markup)).not.toContain("start a new workspace");
  });
});

describe("GoLivePanel, hosted on a deployment without the platform pair", () => {
  const unreadable = (step: "wallets" | "live") =>
    status({ step, host: "hosted", hostedAvailable: false, wallets: step === "live" ? WALLETS : [], credentialsUnreadable: true });

  it.each([true, false])("warns that the hosted testnet wallet is unavailable, without asking for a reconnect (owner: %s)", (canAdminister) => {
    const markup = panel(unreadable("live"), canAdminister);
    const words = text(markup);
    expect(words).toContain("Hosted testnet wallet unavailable");
    expect(words).toContain("unavailable on this deployment");
    expect(words).not.toContain("reconnect");
    expect(words).not.toContain("Circle credentials cannot be read");
    expect(words).not.toContain("Replace Circle credentials");
    expect(words).not.toContain(OPERATING);
    expect(markup).not.toContain('id="go-live-form"');
    expect(secretInputs(markup)).toHaveLength(0);
  });

  it("shows no step while the pair is missing", () => {
    const words = text(panel(unreadable("wallets")));
    expect(words).toContain("Hosted testnet wallet unavailable");
    expect(words).not.toContain("Create treasury wallets");
  });
});

/** Every property name reachable from `T`, however deeply nested. */
type DeepKeys<T> = T extends readonly (infer Item)[]
  ? DeepKeys<Item>
  : T extends object
    ? { [K in keyof T & string]: K | DeepKeys<T[K]> }[keyof T & string]
    : never;

/** A name that could hold a credential or a Circle id. */
type SecretLike<K extends string> = Lowercase<K> extends `${string}${"secret" | "key" | "token" | "password" | "walletid" | "cipher"}${string}` ? K : never;

describe("GoLivePanel's props", () => {
  it("carry no secret field at all, at any depth", () => {
    expectTypeOf<SecretLike<DeepKeys<GoLivePanelProps>>>().toEqualTypeOf<never>();
    // The names the check walks, so an empty walk cannot pass it vacuously.
    expectTypeOf<DeepKeys<GoLivePanelProps>>().toEqualTypeOf<
      "orgSlug" | "status" | "canAdminister" | keyof GoLiveStatus | keyof GoLiveStatus["wallets"][number]
    >();
  });
});
