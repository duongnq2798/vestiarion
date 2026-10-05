import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWithConfig } from "@/lib/context";
import { assertPaymentsEnabled, paymentsDisabled, PaymentsDisabledError, PAYMENTS_OFF } from "@/lib/payments-switch";

const base = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

/** The platform's stop switch (payment safety S1): set on the deployment, it stops every payment in every workspace. */
describe("the platform's payment switch (payment safety S1)", () => {
  it("refuses while the deployment has payments switched off, in words a person reads", () => {
    runWithConfig({ ...base, paymentsDisabled: true }, () => {
      expect(paymentsDisabled()).toBe(true);
      expect(() => assertPaymentsEnabled()).toThrow(PaymentsDisabledError);
      expect(() => assertPaymentsEnabled()).toThrow("Payments are switched off for every workspace right now.");
    });
    expect(PAYMENTS_OFF).toBe("Payments are switched off for every workspace right now.");
  });

  it("lets payments through otherwise", () => {
    runWithConfig(base, () => {
      expect(paymentsDisabled()).toBe(false);
      expect(() => assertPaymentsEnabled()).not.toThrow();
    });
  });
});
