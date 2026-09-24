import { afterEach, describe, expect, it } from "vitest";
import { configFromEnv, type VestiarionConfig } from "@/lib/config";
import {
  createContext,
  currentConfig,
  currentContext,
  hasScope,
  resetAmbientContext,
  runWith,
  runWithConfig,
} from "@/lib/context";
import { supabase } from "@/lib/supabase";

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
    const a = runWithConfig(northstar, () => supabase());
    const b = runWithConfig(meridian, () => supabase());
    expect(a).not.toBe(b);
  });

  it("reuses one client within a scope rather than reconnecting per call", () => {
    const context = createContext(northstar);
    const [first, second] = runWith(context, () => [supabase(), supabase()]);
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
        const before = supabase();
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [before, supabase()];
      }),
      runWithConfig(meridian, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return [supabase(), supabase()];
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
