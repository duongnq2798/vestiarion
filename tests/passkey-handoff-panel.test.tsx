import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PhoneHandoffPanel } from "@/components/treasury/PhoneHandoff";

/** The handoff as it renders (the tests/go-live-panel.test.tsx shape: vitest's node environment, no DOM). */

const PAGE = "https://www.vestiarion.xyz/o/mainnet-wp/settings";

describe("PhoneHandoffPanel", () => {
  it("folds a code that opens this page on the phone under Use your phone instead", () => {
    const folded = renderToStaticMarkup(<PhoneHandoffPanel kind="confirm" url={PAGE} open={false} />);
    expect(folded).toContain("<details");
    expect(folded).not.toMatch(/<details[^>]*\sopen/);
    expect(folded).toContain("Use your phone instead");
    expect(folded).toMatch(/<svg[^>]*role="img"[^>]*aria-label="A code that opens this page on your phone"/);
    expect(folded).toContain(PAGE);
  });

  it("is open where the device keeps no passkey of its own", () => {
    expect(renderToStaticMarkup(<PhoneHandoffPanel kind="confirm" url={PAGE} open />)).toMatch(/<details[^>]*\sopen/);
  });

  it("says whether the passkey is made or used on the phone, and why the computer may wait", () => {
    const create = renderToStaticMarkup(<PhoneHandoffPanel kind="create" url={PAGE} open />);
    expect(create).toContain("create the passkey on the phone itself");
    expect(create).toContain("Connecting to your device");
    const confirm = renderToStaticMarkup(<PhoneHandoffPanel kind="confirm" url={PAGE} open />);
    expect(confirm).toContain("Scan this code with the phone that holds the passkey");
    expect(confirm).toContain("confirm on the phone");
  });
});
