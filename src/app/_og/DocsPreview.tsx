import type { ImageResponse } from "next/og";
import { COLOR } from "@/components/ui/tokens";
import { operationById } from "@/lib/api/openapi";
import { DOCS_NAV, findPage } from "@/lib/docs/nav";
import { docsHref } from "@/lib/docs/paths";
import { renderSocialImage } from "./SocialPreview";

/**
 * A summary is cut at a word, with an ellipsis, so it never runs into the
 * footer: four lines fit under a one-line title, three under a title that
 * wraps. Past `WRAPS_AFTER` characters a title at 76px takes two lines.
 */
const WRAPS_AFTER = 18;
const MAX_SUMMARY = { oneLineTitle: 170, twoLineTitle: 120 };

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

/** Nav titles run to about twenty characters; a longer one steps down so it still fits in two lines. */
function titleSize(title: string): number {
  if (title.length <= 22) return 76;
  if (title.length <= 34) return 62;
  return 52;
}

/**
 * The social image for the docs page at `slug`, or null when the nav has no
 * such page. A reference page leads with its request line; every other page
 * with its section. The card beside it lists the docs' sections, the page's
 * own marked, so the image says where in the docs the link lands.
 */
export function docsPreviewImage(slug: string): ImageResponse | null {
  const found = findPage(slug);
  if (!found) return null;
  const { page, section } = found;
  const operation = slug.startsWith("api/") ? operationById(slug.slice("api/".length)) : undefined;

  return renderSocialImage({
    badge: "Developer docs",
    footer: `vestiarion.xyz${docsHref(page.slug)}`,
    children: (
      <div style={{ display: "flex", flex: 1, alignItems: "center", marginTop: 26 }}>
        <div style={{ display: "flex", flexDirection: "column", width: 696, paddingRight: 32 }}>
          {operation ? (
            <div style={{ display: "flex", alignItems: "center", fontSize: 24 }}>
              <div
                style={{
                  display: "flex",
                  padding: "5px 12px 4px",
                  border: `1px solid ${COLOR.proofLine}`,
                  borderRadius: 8,
                  color: COLOR.proof,
                  backgroundColor: COLOR.proofSoft,
                  fontSize: 20,
                  letterSpacing: 1,
                  textTransform: "uppercase",
                }}
              >
                {operation.method}
              </div>
              <div style={{ display: "flex", marginLeft: 14, color: COLOR.ink2 }}>{operation.path}</div>
            </div>
          ) : (
            <div style={{ display: "flex", color: COLOR.agent, fontSize: 20, letterSpacing: 2.2, textTransform: "uppercase" }}>
              {section}
            </div>
          )}
          <div
            style={{
              display: "flex",
              marginTop: 22,
              fontSize: titleSize(page.title),
              lineHeight: 1,
              letterSpacing: -3,
            }}
          >
            {page.title}
          </div>
          <div style={{ display: "flex", maxWidth: 650, marginTop: 26, color: COLOR.ink2, fontSize: 26, lineHeight: 1.4 }}>
            {clip(page.description, page.title.length > WRAPS_AFTER ? MAX_SUMMARY.twoLineTitle : MAX_SUMMARY.oneLineTitle)}
          </div>
        </div>

        <div
          style={{
            width: 350,
            display: "flex",
            flexDirection: "column",
            padding: "24px 24px 18px",
            border: `2px solid ${COLOR.line}`,
            borderRadius: 24,
            backgroundColor: COLOR.surface,
            boxShadow: `0 18px 48px ${COLOR.ink}1f`,
          }}
        >
          <div style={{ display: "flex", marginBottom: 12, color: COLOR.ink3, fontSize: 15, letterSpacing: 2.2, textTransform: "uppercase" }}>
            Vestiarion docs
          </div>
          {DOCS_NAV.map((navSection) => {
            const current = navSection.title === section;
            return (
              <div
                key={navSection.title}
                style={{
                  display: "flex",
                  alignItems: "center",
                  marginTop: 4,
                  padding: "8px 12px",
                  borderRadius: 12,
                  color: current ? COLOR.agent : COLOR.ink3,
                  backgroundColor: current ? COLOR.agentSoft : "transparent",
                  fontSize: 20,
                }}
              >
                <div
                  style={{
                    width: 8,
                    height: 8,
                    display: "flex",
                    marginRight: 12,
                    borderRadius: 999,
                    backgroundColor: current ? COLOR.agent : COLOR.lineStrong,
                  }}
                />
                {navSection.title}
              </div>
            );
          })}
        </div>
      </div>
    ),
  });
}
