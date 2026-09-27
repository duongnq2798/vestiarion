import { afterEach, describe, expect, it } from "vitest";
import { configFromEnv, type VestiarionConfig } from "@/lib/config";
import {
  createContext,
  currentConfig,
  currentContext,
  currentOrgId,
  currentUserId,
  currentOrgConfig,
  currentSecretWarnings,
  hasScope,
  NoOrgScopeError,
  resetAmbientContext,
  runWith,
  runWithConfig,
} from "@/lib/context";

function configFor(name: string, project: string): VestiarionConfig {
  return configFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: `https://${project}.supabase.co`,
    SUPABASE_SERVICE_ROLE_KEY: `${project}-service-role`,
    BUSINESS_NAME: name,
  });
}

const northstar = configFor("Northstar Studio", "northstar");
const meridian = configFor("Meridian Works", "meridian");

const SAVED = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in SAVED)) delete process.env[key];
  Object.assign(process.env, SAVED);
  resetAmbientContext();
});

describe("scoping", () => {
  it("gives each scope its own configuration", () => {
    runWithConfig(northstar, () => {
      expect(currentConfig().businessName).toBe("Northstar Studio");
    });
    runWithConfig(meridian, () => {
      expect(currentConfig().businessName).toBe("Meridian Works");
    });
  });

  it("gives each scope its own database client", () => {
    // The property the module-level singleton destroyed: whoever called first
    // decided which database the whole process talked to.
    const a = runWithConfig(northstar, () => currentContext().db);
    const b = runWithConfig(meridian, () => currentContext().db);
    expect(a).not.toBe(b);
  });

  it("reuses one client within a scope rather than reconnecting per call", () => {
    const context = createContext(northstar);
    const [first, second] = runWith(context, () => [currentContext().db, currentContext().db]);
    expect(first).toBe(second);
  });

  it("survives await boundaries, which a module variable does not", async () => {
    // The reason this is AsyncLocalStorage and not a plain variable: a cycle
    // is hundreds of awaits long, and a second business must not be able to
    // change which database the first one is mid-way through writing to.
    const seen: string[] = [];

    const work = async (label: string) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(`${label}:${currentConfig().businessName}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(`${label}:${currentConfig().businessName}`);
    };

    await Promise.all([
      runWithConfig(northstar, () => work("a")),
      runWithConfig(meridian, () => work("b")),
    ]);

    expect(seen.filter((s) => s.startsWith("a:"))).toEqual([
      "a:Northstar Studio",
      "a:Northstar Studio",
    ]);
    expect(seen.filter((s) => s.startsWith("b:"))).toEqual([
      "b:Meridian Works",
      "b:Meridian Works",
    ]);
  });

  it("keeps interleaved concurrent work on its own database throughout", async () => {
    const clients = await Promise.all([
      runWithConfig(northstar, async () => {
        const before = currentContext().db;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [before, currentContext().db];
      }),
      runWithConfig(meridian, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return [currentContext().db, currentContext().db];
      }),
    ]);

    const [[a1, a2], [b1, b2]] = clients;
    expect(a1).toBe(a2);
    expect(b1).toBe(b2);
    expect(a1).not.toBe(b1);
  });

  it("restores the outer scope when an inner one ends", () => {
    runWithConfig(northstar, () => {
      runWithConfig(meridian, () => {
        expect(currentConfig().businessName).toBe("Meridian Works");
      });
      expect(currentConfig().businessName).toBe("Northstar Studio");
    });
  });

  it("does not leak a scope past a throw", () => {
    expect(() =>
      runWithConfig(meridian, () => {
        throw new Error("cycle failed");
      })
    ).toThrow("cycle failed");
    expect(hasScope()).toBe(false);
  });
});

describe("the ambient fallback", () => {
  it("derives a context from the environment when nothing is scoped", () => {
    // This is what keeps the change additive: the single-tenant app never
    // enters a scope and keeps working untouched.
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://ambient.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "ambient-key";
    process.env.BUSINESS_NAME = "Ambient Co";
    resetAmbientContext();

    expect(hasScope()).toBe(false);
    expect(currentConfig().businessName).toBe("Ambient Co");
  });

  it("builds the ambient context once", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://ambient.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "ambient-key";
    resetAmbientContext();

    expect(currentContext()).toBe(currentContext());
  });

  it("reports the environment's failure, not a confusing one further in", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    resetAmbientContext();

    expect(() => currentConfig()).toThrow(/Supabase is not configured/);
  });

  it("prefers an explicit scope over the environment", () => {
    process.env.BUSINESS_NAME = "Ambient Co";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://ambient.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "ambient-key";
    resetAmbientContext();

    runWithConfig(northstar, () => {
      expect(hasScope()).toBe(true);
      expect(currentConfig().businessName).toBe("Northstar Studio");
    });
  });
});

const ORG_A = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const ORG_B = "0b6c1c9e-4a4f-4a7e-9b1e-000000000b0b";

describe("the organization in scope", () => {
  it("is absent outside every scope, and asking for it throws", () => {
    expect(currentContext().orgId).toBeUndefined();
    expect(() => currentOrgId()).toThrow(NoOrgScopeError);
  });

  it("is absent in a scope that names only a configuration", () => {
    runWithConfig(northstar, () => {
      expect(() => currentOrgId()).toThrow("Tenant data was touched with no organization in scope");
    });
  });

  it("is the one the scope names, and the inner scope wins", () => {
    runWithConfig(northstar, () => {
      expect(currentOrgId()).toBe(ORG_A);
      runWithConfig(meridian, () => expect(currentOrgId()).toBe(ORG_B), { orgId: ORG_B });
      expect(currentOrgId()).toBe(ORG_A);
    }, { orgId: ORG_A });
  });

  it("survives awaits without leaking between concurrent scopes", async () => {
    const seen = await Promise.all([
      runWithConfig(northstar, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return currentOrgId();
      }, { orgId: ORG_A }),
      runWithConfig(meridian, async () => currentOrgId(), { orgId: ORG_B }),
    ]);
    expect(seen).toEqual([ORG_A, ORG_B]);
  });

  it("carries the user when one is named", () => {
    runWithConfig(northstar, () => expect(currentUserId()).toBe("user-1"), { orgId: ORG_A, userId: "user-1" });
    runWithConfig(northstar, () => expect(currentUserId()).toBeUndefined(), { orgId: ORG_A });
  });

  it("guards the organization's configuration and its secret warnings", () => {
    expect(() => currentOrgConfig()).toThrow(NoOrgScopeError);
    expect(() => currentSecretWarnings()).toThrow(NoOrgScopeError);
    runWithConfig(northstar, () => {
      expect(currentOrgConfig().businessName).toBe("Northstar Studio");
      expect(currentSecretWarnings()).toEqual(["stored key could not be read"]);
    }, { orgId: ORG_A, secretWarnings: ["stored key could not be read"] });
  });
});
