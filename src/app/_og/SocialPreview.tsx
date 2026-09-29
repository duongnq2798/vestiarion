import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { COLOR } from "@/components/ui/tokens";

const OG_ASSET_DIR = join(process.cwd(), "src", "app", "_og");

const [geistSemiBold, newsreaderItalic, iconSvg] = await Promise.all([
  readFile(join(OG_ASSET_DIR, "fonts", "Geist-SemiBold.ttf")),
  readFile(join(OG_ASSET_DIR, "fonts", "Newsreader72pt-Italic.ttf")),
  readFile(join(process.cwd(), "src", "app", "icon.svg"), "utf8"),
]);

const iconSrc = `data:image/svg+xml;base64,${Buffer.from(iconSvg).toString("base64")}`;

export const SOCIAL_IMAGE_SIZE = { width: 1200, height: 630 } as const;

const statusChips = [
  { label: "Screened", color: COLOR.proof, background: COLOR.proofSoft, border: COLOR.proofLine },
  { label: "Paid", color: COLOR.agent, background: COLOR.agentSoft, border: COLOR.agentLine },
  { label: "Held", color: COLOR.held, background: COLOR.heldSoft, border: COLOR.heldLine },
  { label: "Refused", color: COLOR.refused, background: COLOR.refusedSoft, border: COLOR.refusedLine },
] as const;

/** One static, brand-matched image shared by the Open Graph and X routes. */
export function socialPreviewImage(): ImageResponse {
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
            Autonomous treasury agent · Arc testnet
          </div>
        </div>

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
              A model proposes each payment, code decides whether it may happen, and every outcome — refusals included — is signed into a chain you can verify.
            </div>
          </div>

          <div
            style={{
              width: 350,
              height: 326,
              display: "flex",
              flexDirection: "column",
              position: "relative",
              padding: "28px 28px 26px",
              border: `2px solid ${COLOR.line}`,
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

            {[154, 218, 124].map((width, index) => (
              <div key={width} style={{ display: "flex", alignItems: "center", marginTop: index === 0 ? 28 : 18 }}>
                <div
                  style={{
                    width: 14,
                    height: 14,
                    display: "flex",
                    border: `3px solid ${COLOR.proof}`,
                    borderRadius: 999,
                    backgroundColor: COLOR.proofSoft,
                  }}
                />
                <div style={{ display: "flex", width, height: 10, marginLeft: 14, borderRadius: 999, backgroundColor: COLOR.line }} />
                <div style={{ display: "flex", width: 44, height: 10, marginLeft: "auto", borderRadius: 999, backgroundColor: COLOR.agentSoft }} />
              </div>
            ))}

            <div style={{ display: "flex", flexWrap: "wrap", gap: 9, marginTop: "auto" }}>
              {statusChips.map((chip) => (
                <div
                  key={chip.label}
                  style={{
                    display: "flex",
                    padding: "7px 10px 6px",
                    border: `1px solid ${chip.border}`,
                    borderRadius: 999,
                    color: chip.color,
                    backgroundColor: chip.background,
                    fontSize: 15,
                  }}
                >
                  {chip.label}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", color: COLOR.ink3, fontSize: 18 }}>
          <div style={{ display: "flex" }}>vestiarion.xyz</div>
          <div style={{ display: "flex", margin: "0 12px", color: COLOR.lineStrong }}>·</div>
          <div style={{ display: "flex" }}>Arc testnet</div>
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
