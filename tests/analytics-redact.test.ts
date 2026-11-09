import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { redactPath, redactReferrer, redactTitle } from "@/lib/analytics/redact";

const ORIGIN = "https://vestiarion.xyz";
const ID = "3f2b8c1e-9d4a-4e7b-8a6c-1b2d3e4f5a6b";
const OTHER = "a0b1c2d3-e4f5-4a6b-9c8d-7e6f5a4b3c2d";

/** Every page under `dir` whose route has an `[id]` segment, as `base` plus its route. */
function routesWithAnId(dir: string, base: string): string[] {
  const found = existsSync(path.join(dir, "page.tsx")) && base.includes("[id]") ? [base] : [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...routesWithAnId(path.join(dir, entry.name), `${base}/${entry.name}`));
  }
  return found;
}

describe("redactPath", () => {
  it.each([
    ["/invite/abc", "/invite/:token"],
    ["/invite/abc/", "/invite/:token"],
    ["/invite/abc/extra", "/invite/:token"],
    ["/payee/vxp_secret", "/payee/:token"],
    ["/payee/vxp_secret/", "/payee/:token"],
    ["/receipt/vxr_secret", "/receipt/:token"],
    ["/receipt/vxr_secret/", "/receipt/:token"],
    ["/report/vxs_secret", "/report/:token"],
    ["/report/vxs_secret/", "/report/:token"],
    ["/pay/vxl_secret", "/pay/:token"],
    ["/pay/vxl_secret/", "/pay/:token"],
    ["/statement/vxc_secret", "/statement/:token"],
    ["/statement/vxc_secret/", "/statement/:token"],
    ["/offer/vxo_secret", "/offer/:token"],
    ["/discount/vxd_secret", "/discount/:token"],
    ["/more-time/vxt_secret", "/more-time/:token"],
    ["/address-change/vxw_secret", "/address-change/:token"],
    ["/join/vxj_secret", "/join/:token"],
    ["/join/vxj_secret/", "/join/:token"],
    ["/documents/vxu_secret", "/documents/:token"],
    ["/o/acme", "/o/:org"],
    ["/o/acme/", "/o/:org/"],
    ["/o/acme/audit", "/o/:org/audit"],
    ["/", "/"],
    ["/docs/api", "/docs/api"],
  ])("redacts %s as %s", (pathname, expected) => {
    expect(redactPath(pathname)).toBe(expected);
  });

  it.each([
    [`/o/acme/counterparties/${ID}`, "/o/:org/counterparties/:id"],
    [`/o/acme/counterparties/${ID}/`, "/o/:org/counterparties/:id/"],
    [`/o/acme/counterparties/${ID.toUpperCase()}`, "/o/:org/counterparties/:id"],
    [`/o/acme/projects/${ID}`, "/o/:org/projects/:id"],
    [`/o/acme/evidence/invoice/${ID}`, "/o/:org/evidence/invoice/:id"],
    [`/o/acme/evidence/milestone/${OTHER}`, "/o/:org/evidence/milestone/:id"],
    [`/o/acme/invoices/deals/${ID}`, "/o/:org/invoices/deals/:id"],
    [`/o/acme/x/${ID}/${OTHER}`, "/o/:org/x/:id/:id"],
    [`/o/${ID}/audit`, "/o/:org/audit"],
  ])("CL17: redacts the id in %s as %s", (pathname, expected) => {
    expect(redactPath(pathname)).toBe(expected);
  });

  it.each([
    ["/o/acme/counterparties/not-a-uuid", "/o/:org/counterparties/not-a-uuid"],
    [`/o/acme/counterparties/${ID}x`, `/o/:org/counterparties/${ID}x`],
    [`/o/acme/counterparties/x${ID}`, `/o/:org/counterparties/x${ID}`],
    [`/o/acme/counterparties/${ID.slice(0, -1)}`, `/o/:org/counterparties/${ID.slice(0, -1)}`],
    ["/o/acme/evidence/close-pack", "/o/:org/evidence/close-pack"],
    [`/docs/${ID}`, `/docs/${ID}`],
  ])("CL17: keeps a segment that is not a whole UUID, and a path outside a workspace: %s as %s", (pathname, expected) => {
    expect(redactPath(pathname)).toBe(expected);
  });

  it.each([
    [`/payee/${ID}`, "/payee/:token"],
    [`/receipt/${ID}`, "/receipt/:token"],
    [`/documents/${ID}/${OTHER}`, "/documents/:token"],
  ])("CL17: leaves a token path as it was: %s as %s", (pathname, expected) => {
    expect(redactPath(pathname)).toBe(expected);
  });

  it("CL17: names no record on any workspace page with an id in its path", () => {
    const pages = routesWithAnId(path.join(process.cwd(), "src/app/o/[slug]"), "/o/acme");
    expect(pages).toEqual(expect.arrayContaining(["/o/acme/projects/[id]", "/o/acme/evidence/[kind]/[id]"]));
    for (const route of pages) {
      const redacted = redactPath(route.replace("[kind]", "invoice").replace("[id]", ID));
      expect(redacted, route).not.toContain(ID);
      expect(redacted, route).toMatch(/\/:id$/);
    }
  });
});

describe("redactReferrer", () => {
  it.each([
    ["", ""],
    ["not a url", ""],
    [`${ORIGIN}/invite/abc?next=x#y`, `${ORIGIN}/invite/:token`],
    [`${ORIGIN}/o/acme/settings`, `${ORIGIN}/o/:org/settings`],
    [`${ORIGIN}/receipt/vxr_secret`, `${ORIGIN}/receipt/:token`],
    [`${ORIGIN}/report/vxs_secret`, `${ORIGIN}/report/:token`],
    [`${ORIGIN}/pay/vxl_secret`, `${ORIGIN}/pay/:token`],
    [`${ORIGIN}/statement/vxc_secret`, `${ORIGIN}/statement/:token`],
    [`${ORIGIN}/join/vxj_secret`, `${ORIGIN}/join/:token`],
    [`${ORIGIN}/o/acme/counterparties/${ID}?history=all#payments`, `${ORIGIN}/o/:org/counterparties/:id`],
    [`${ORIGIN}/o/acme/evidence/invoice/${ID}`, `${ORIGIN}/o/:org/evidence/invoice/:id`],
    [`${ORIGIN}/login?next=%2Fo%2Facme`, `${ORIGIN}/login`],
    [`${ORIGIN}/docs/api`, `${ORIGIN}/docs/api`],
    ["https://mail.example.com/inbox/123?q=invite", "https://mail.example.com/"],
  ])("redacts %s as %s", (referrer, expected) => {
    expect(redactReferrer(referrer, ORIGIN)).toBe(expected);
  });
});

describe("redactTitle", () => {
  it("keeps the title of a page whose path is public", () => {
    expect(redactTitle("/docs/api", "API reference · Vestiarion")).toBe("API reference · Vestiarion");
  });

  it("replaces a workspace title, which names the organization, with the redacted path", () => {
    expect(redactTitle("/o/acme/audit", "Audit log · Acme · Vestiarion")).toBe("/o/:org/audit");
    expect(redactTitle("/o/acme", "Acme · Vestiarion")).toBe("/o/:org");
  });

  it("CL17: replaces a counterparty page's title with the redacted path, so neither names the record", () => {
    expect(redactTitle(`/o/acme/counterparties/${ID}`, "Counterparty · Acme · Vestiarion")).toBe("/o/:org/counterparties/:id");
  });

  it("replaces an invite title with the redacted path", () => {
    expect(redactTitle("/invite/abc", "Accept invitation · Vestiarion")).toBe("/invite/:token");
  });
});
