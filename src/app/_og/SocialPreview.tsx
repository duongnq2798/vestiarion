import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import type { ReactNode } from "react";
import { COLOR } from "@/components/ui/tokens";
import { LINK_PREVIEWS, type LinkPage } from "@/lib/link-previews";

const OG_ASSET_DIR = join(process.cwd(), "src", "app", "_og");

const [geistSemiBold, newsreaderItalic, iconSvg] = await Promise.all([
  readFile(join(OG_ASSET_DIR, "fonts", "Geist-SemiBold.ttf")),
  readFile(join(OG_ASSET_DIR, "fonts", "Newsreader72pt-Italic.ttf")),
  readFile(join(process.cwd(), "src", "app", "icon.svg"), "utf8"),
]);

const iconSrc = `data:image/svg+xml;base64,${Buffer.from(iconSvg).toString("base64")}`;

export const SOCIAL_IMAGE_SIZE = { width: 1200, height: 630 } as const;
export const SOCIAL_IMAGE_ALT = "Vestiarion — Money moves. Evidence remains. A signed decision ledger with screened, paid, held, and refused outcomes.";

const LEDGER_CARD_WIDTH = 350;
const LEDGER_CARD_HORIZONTAL_PADDING = 24;
const LEDGER_CARD_BORDER = 2;
const LEDGER_DOT_WIDTH = 14;
const LEDGER_DOT_TO_BAR_GAP = 12;
const LEDGER_PILL_WIDTH = 44;
const LEDGER_MIN_BAR_TO_PILL_GAP = 20;
const LEDGER_INNER_WIDTH = LEDGER_CARD_WIDTH
  - 2 * LEDGER_CARD_HORIZONTAL_PADDING
  - 2 * LEDGER_CARD_BORDER;
const LEDGER_BAR_MAX_WIDTH = Math.min(
  180,
  LEDGER_INNER_WIDTH
    - LEDGER_DOT_WIDTH
    - LEDGER_DOT_TO_BAR_GAP
    - LEDGER_PILL_WIDTH
    - LEDGER_MIN_BAR_TO_PILL_GAP,
);
const ledgerBarWidths = [0.78, 1, 0.64].map((ratio) => Math.round(LEDGER_BAR_MAX_WIDTH * ratio));

const SUPPORTING_COPY = "A model proposes each payment, code decides whether it may happen, and every outcome\u00a0— refusals included\u00a0— is signed into a chain you can verify.";

const statusChips = [
  { label: "Screened", color: COLOR.proof, background: COLOR.proofSoft, border: COLOR.proofLine },
  { label: "Paid", color: COLOR.agent, background: COLOR.agentSoft, border: COLOR.agentLine },
  { label: "Held", color: COLOR.held, background: COLOR.heldSoft, border: COLOR.heldLine },
  { label: "Refused", color: COLOR.refused, background: COLOR.refusedSoft, border: COLOR.refusedLine },
] as const;

/**
 * The frame every social image shares: the paper ground, the agent-blue rule,
 * the mark and wordmark with a badge, and the footer line. `children` fills
 * the middle, `footer` names where the page lives, and `network` the line beside
 * it: the platform's card, and a link page's, say only Arc
 * (mainnet polish E1).
 */
export function renderSocialImage({
  badge,
  footer,
  children,
  network = "Arc",
}: {
  badge: string;
  footer: string;
  children: ReactNode;
  network?: string;
}): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          position: "relative",
          overflow: "hidden",
          padding: "64px 68px 52px",
          color: COLOR.ink,
          backgroundColor: COLOR.surface,
          backgroundImage: `linear-gradient(135deg, ${COLOR.surface} 0%, ${COLOR.ground} 68%, ${COLOR.agentSoft} 100%)`,
          fontFamily: "Geist",
        }}
      >
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 10,
            display: "flex",
            backgroundColor: COLOR.agent,
          }}
        />

        <div style={{ display: "flex", alignItems: "center", height: 48 }}>
          {/* ImageResponse renders this data URI itself; next/image is not available here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={iconSrc} alt="" width={48} height={48} />
          <div style={{ display: "flex", marginLeft: 16, fontSize: 30, letterSpacing: -1 }}>
            Vestiarion
          </div>
          <div
            style={{
              display: "flex",
              marginLeft: "auto",
              padding: "9px 14px 8px",
              border: `1px solid ${COLOR.agentLine}`,
              borderRadius: 999,
              color: COLOR.agent,
              backgroundColor: COLOR.agentSoft,
              fontSize: 16,
              letterSpacing: 1.6,
              textTransform: "uppercase",
            }}
          >
            {badge}
          </div>
        </div>

        {children}

        <div style={{ display: "flex", alignItems: "center", color: COLOR.ink3, fontSize: 18 }}>
          <div style={{ display: "flex" }}>{footer}</div>
          <div style={{ display: "flex", margin: "0 12px", color: COLOR.lineStrong }}>·</div>
          <div style={{ display: "flex" }}>{network}</div>
          <div style={{ display: "flex", flex: 1, height: 1, marginLeft: 20, backgroundColor: COLOR.line }} />
        </div>
      </div>
    ),
    {
      ...SOCIAL_IMAGE_SIZE,
      fonts: [
        { name: "Geist", data: geistSemiBold, style: "normal", weight: 600 },
        { name: "Newsreader", data: newsreaderItalic, style: "italic", weight: 400 },
      ],
    },
  );
}

/** One static, brand-matched image shared by the Open Graph and X routes. */
export function socialPreviewImage(): ImageResponse {
  return renderSocialImage({
    badge: "Autonomous treasury agent",
    footer: "vestiarion.xyz",
    children: (
      <div style={{ display: "flex", flex: 1, alignItems: "center", marginTop: 26 }}>
        <div style={{ display: "flex", flexDirection: "column", width: 696, paddingRight: 32 }}>
          <div
            style={{
              display: "flex",
              fontSize: 82,
              lineHeight: 0.94,
              letterSpacing: -4.6,
            }}
          >
            Money moves.
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 4,
              color: COLOR.agent,
              fontFamily: "Newsreader",
              fontSize: 82,
              fontStyle: "italic",
              fontWeight: 400,
              lineHeight: 0.94,
              letterSpacing: -3.5,
            }}
          >
            Evidence remains.
          </div>
          <div
            style={{
              display: "flex",
              maxWidth: 650,
              marginTop: 26,
              color: COLOR.ink2,
              fontSize: 24,
              lineHeight: 1.42,
            }}
          >
            {SUPPORTING_COPY}
          </div>
        </div>

        <div
          style={{
            width: LEDGER_CARD_WIDTH,
            height: 286,
            display: "flex",
            flexDirection: "column",
            position: "relative",
            padding: `24px ${LEDGER_CARD_HORIZONTAL_PADDING}px 22px`,
            border: `${LEDGER_CARD_BORDER}px solid ${COLOR.line}`,
            borderRadius: 24,
            backgroundColor: COLOR.surface,
            boxShadow: `0 18px 48px ${COLOR.ink}1f`,
          }}
        >
          <div
            style={{
              display: "flex",
              color: COLOR.ink3,
              fontSize: 15,
              letterSpacing: 2.2,
              textTransform: "uppercase",
            }}
          >
            Signed decision ledger
          </div>

          {ledgerBarWidths.map((width, index) => (
            <div key={width} style={{ display: "flex", alignItems: "center", marginTop: index === 0 ? 24 : 16 }}>
              <div
                style={{
                  width: LEDGER_DOT_WIDTH,
                  height: LEDGER_DOT_WIDTH,
                  display: "flex",
                  border: `3px solid ${COLOR.proof}`,
                  borderRadius: 999,
                  backgroundColor: COLOR.proofSoft,
                }}
              />
              <div style={{ display: "flex", width, height: 10, marginLeft: LEDGER_DOT_TO_BAR_GAP, borderRadius: 999, backgroundColor: COLOR.line }} />
              <div style={{ display: "flex", width: LEDGER_PILL_WIDTH, height: 10, marginLeft: "auto", borderRadius: 999, backgroundColor: COLOR.agentSoft }} />
            </div>
          ))}

          <div style={{ display: "flex", gap: 6, marginTop: "auto" }}>
            {statusChips.map((chip) => (
              <div
                key={chip.label}
                style={{
                  display: "flex",
                  padding: "6px 7px 5px",
                  border: `1px solid ${chip.border}`,
                  borderRadius: 999,
                  color: chip.color,
                  backgroundColor: chip.background,
                  fontSize: 14,
                }}
              >
                {chip.label}
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
  });
}


/** A link page's card: the platform's frame, the page's badge and words, and no network named beyond Arc (E1). */
export function linkPreviewImage(page: LinkPage): ImageResponse {
  const { badge, title, line } = LINK_PREVIEWS[page];
  return renderSocialImage({
    badge,
    footer: "vestiarion.xyz",
    network: "Arc",
    children: (
      <div style={{ display: "flex", flex: 1, flexDirection: "column", justifyContent: "center", marginTop: 26 }}>
        <div style={{ display: "flex", fontFamily: "Geist", fontSize: 64, fontWeight: 600, letterSpacing: -1.6, color: COLOR.ink }}>{title}</div>
        <div style={{ display: "flex", marginTop: 20, fontSize: 28, color: COLOR.ink2 }}>{line}</div>
      </div>
    ),
  });
}
