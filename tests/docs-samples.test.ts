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
    expect(s.python).toContain(`requests.${op.method}(`);
  });

  it.each(OPERATIONS.filter((op) => op.method === "post").map((op) => [op.id, op] as const))(
    "%s sends its example body as JSON, with its Idempotency-Key when it takes one, in every sample (write API R8; part 2, W3)",
    (_id, op) => {
      const key = op.params.find((param) => param.in === "header" && param.name === "Idempotency-Key");
      const s = sampleRequest(op, "https://x.test");

      expect(s.curl.split("\n")).toEqual([
        `curl "https://x.test${op.path}" \\`,
        "  -X POST \\",
        '  -H "Authorization: Bearer $VESTIARION_API_KEY" \\',
        '  -H "Content-Type: application/json" \\',
        ...(key ? [`  -H "Idempotency-Key: ${key.example}" \\`] : []),
        `  -d '${JSON.stringify(op.requestExample)}'`,
      ]);
      expect(s.javascript).toContain('method: "POST"');
      expect(s.javascript).toContain('"Content-Type": "application/json"');
      const sent = s.javascript.match(/body: JSON\.stringify\((\{[\s\S]*?\n {2}\})\),/);
      expect(sent, s.javascript).not.toBeNull();
      expect(JSON.parse(sent![1])).toEqual(op.requestExample);
      expect(s.python).toContain(`requests.post(`);
      expect(s.python).toContain("    json={\n");
      if (key) {
        expect(s.javascript).toContain(`"Idempotency-Key": "${key.example}"`);
        expect(s.python).toContain(`"Idempotency-Key": "${key.example}",`);
      } else {
        expect(s.javascript).not.toContain("Idempotency-Key");
        expect(s.python).not.toContain("Idempotency-Key");
      }
    }
  );

  it("sends no Idempotency-Key for a payee link, which keeps no outcome for one (write API part 2, W3)", () => {
    expect(operationById("create-payee-link")!.params).toEqual([]);
    for (const op of OPERATIONS.filter((candidate) => candidate.method === "post" && candidate.id !== "create-payee-link")) {
      expect(op.params.map((param) => param.name), op.id).toEqual(["Idempotency-Key"]);
    }
  });

  it("writes a body for Python with Python's literals", () => {
    const op = {
      ...operationById("create-invoice")!,
      requestExample: { counterpartyId: "6b361405-cfda-4400-a286-364b561911ce", memo: null, goodsReceived: true, earlyPayDiscount: { percent: 2, deadline: "2026-10-20" } },
    };
    const python = sampleRequest(op, "https://x.test").python;
    expect(python).toContain('        "goodsReceived": True,\n');
    expect(python).toContain('        "memo": None,\n');
    expect(python).toContain('        "earlyPayDiscount": {\n            "percent": 2,\n            "deadline": "2026-10-20",\n        },\n');
    expect(python).not.toMatch(/\btrue\b|\bfalse\b|\bnull\b/);
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
