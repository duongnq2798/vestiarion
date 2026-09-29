import { describe, expect, it } from "vitest";
import { operationById, OPERATIONS } from "@/lib/api/openapi";
import { requestUrl, sampleRequest } from "@/lib/docs/samples";

describe("code samples are generated from the operation", () => {
  it.each(OPERATIONS.map((op) => [op.id, op] as const))("%s names the method, path, key and required params", (_id, op) => {
    const s = sampleRequest(op, "https://www.vestiarion.xyz");
    for (const lang of ["curl", "javascript", "python"] as const) {
      expect(s[lang]).toContain(op.path.replace(/\{(\w+)\}/g, (_m, name) => `<${name}>`));
      expect(s[lang]).toContain("Bearer");
    }
    expect(s.curl).toMatch(/^curl /);
    expect(s.javascript).toContain("await fetch(");
    expect(s.python).toContain("requests.get(");
  });

  it("fills path params encoded and drops empty query values", () => {
    const op = operationById("get-counterparty")!;
    expect(requestUrl(op, "https://x.test", { id: "a b" })).toBe("https://x.test/api/v1/counterparties/a%20b");
    const list = operationById("list-invoices")!;
    expect(requestUrl(list, "https://x.test", { limit: "25", status: "" })).toBe("https://x.test/api/v1/invoices?limit=25");
  });

  it("orders query values as the operation lists its params, encodes them, and ignores names it does not take", () => {
    const list = operationById("list-invoices")!;
    expect(requestUrl(list, "https://x.test/", { status: "paid", limit: "10", nope: "1", cursor: "a+b/c=" })).toBe(
      "https://x.test/api/v1/invoices?limit=10&cursor=a%2Bb%2Fc%3D&status=paid"
    );
  });

  it("fills the values it is given into every sample", () => {
    const s = sampleRequest(operationById("list-invoices")!, "https://x.test", { direction: "payable" });
    for (const lang of ["curl", "javascript", "python"] as const) expect(s[lang]).toContain("https://x.test/api/v1/invoices?direction=payable");
  });

  it("reads the key from the environment, never a literal key", () => {
    for (const op of OPERATIONS) {
      const s = sampleRequest(op, "https://x.test");
      expect(s.curl).toContain('"Authorization: Bearer $VESTIARION_API_KEY"');
      expect(s.javascript).toContain("process.env.VESTIARION_API_KEY");
      expect(s.python).toContain('os.environ["VESTIARION_API_KEY"]');
      for (const lang of ["curl", "javascript", "python"] as const) expect(s[lang]).not.toMatch(/vxk_/);
    }
  });

  it("produces JavaScript that parses", () => {
    for (const op of OPERATIONS) expect(() => new Function(`return (async () => { ${sampleRequest(op, "https://x.test").javascript} })`)).not.toThrow();
  });
});
