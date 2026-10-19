# Vestiarion visual system

The public direction is **The bill's journey**: a clear path through a real bill, with application UI and verifiable evidence. The shared foundation lives in `src/app/globals.css`; primitives live in `src/components/ui`. `/design/visual-system` is a development-only, noindex specimen. It contains no live payment evidence and answers 404 in production.

## Colour and focus

Keep the existing palette: agent-blue `#3048c9`, cream ground `#f3f0e7`, paper surface `#fffefa`, ink and the existing status colours. App, email templates, social images and docs share these values. `tokens.ts` mirrors the values needed outside CSS; tests prevent drift. Status is always named in words as well as colour.

On blue or ink use `text-on-agent` for primary text and solid `text-on-agent-muted` for secondary text. The muted role reuses the existing `agent-soft` colour. Never fade small text with opacity: white at 70% on agent-blue fails AA. White on agent-blue is 7.25:1; the muted role is 6.22:1. Use `text-ink-2` on raised surfaces; `ink-3` is suitable on ground/surface, but fails small-text AA on raised.

Every blue or dark region must carry `focus-inverse`. `Section tone="agent"` and `Section tone="ink"` do this automatically. Use inverse buttons there. Light Section tones restore `focus-default`; give other nested light panels with controls `focus-default` too, so their outline contrasts with the panel. When overriding a background, choose the matching focus palette as well. Focus always has a solid outline or border, never just a soft halo. Check Tab and Shift+Tab in the actual composed page.

## Type

Geist Sans carries headings and interface text; Geist Mono carries short labels and identifiers; Newsreader remains the agent's reasoning voice. Default Tailwind sizes and the app's dense typography stay intact.

| Role | Size | Use |
| --- | --- | --- |
| `text-positioning` | 32–60px, fluid | Prominent product positioning |
| `text-display` | 56–112px, fluid | The large display line |
| `text-section` | 32–64px, fluid | Public section heading |
| `text-lede` | 16–18px, fluid | Short introduction |
| `text-body` | 16px | Public body copy |
| `text-ui` | 14px | Product details and actions |
| `text-caption` | 12px | Supporting metadata |
| `text-eyebrow` | 11px | Short, nonessential labels |

Use one `h1` per page. On the landing it says **Your AI agent for bills and payments**; **Every bill. A clear way through.** remains a large display paragraph. `Heading` separates the semantic element (`as`) from its visual `size` and inherits the surrounding colour. Do not hide useful evidence in tiny captions. Register new size roles in `cn.ts` so a colour utility cannot erase a font size.

## Space, shape and elevation

Keep the existing 4px spacing rhythm. Public `px-page` gutters scale from 20 to 72px; `py-section` scales from 48 to 96px. `Section` supplies a centred `max-w-7xl` container and accepts `containerClassName` for a deliberate override. At 520px with a classic scrollbar and reduced motion, headings, controls and evidence must form an intentional single column.

Radii retain their current values: `md` 6px, `lg` 8px, `xl` 12px, `2xl` 16px, and `full` for pills. Controls retain their touch heights and mobile input text remains 16px. Existing Card tones still describe borders. `Card elevation="flat"` gives evidence a quiet edge; the default `surface` elevation is unchanged. Keep `raised` for interactive hover, `overlay` for floating UI, and `brand` for primary actions. Avoid decorative stacks of floating cards when the content should resemble the app.

## Motion and delivery

CSS `duration-micro/overlay/sheet/page/exit/reveal` mirrors `MOTION.duration`: 150/200/300/420/180/450ms. Use the existing standard, emphasized and exit easing. Existing interaction timings keep their values; do not replace a deliberate disclosure or exit timing just because its name sounds similar.

Nothing moves at rest. Use finite CSS motion only to explain a transition. Reduced motion, no JavaScript, a hidden tab and jumping past a section must all leave meaningful content visible. `Heading` and `Section` add no client boundary. The landing shell remains synchronous, with data-dependent evidence behind Suspense. Page-specific journey motion belongs to the landing PR, not the global primitives.

## Evidence and rollout

The landing must label proof as the team's workspace. Every displayed time, date, transaction and observed step comes from an eligible ledger/payment record, with verification links. Explain general process separately from observed events; omit unsupported details. Distinguish ledger recording time from chain confirmation time. A Base payment needs the confirmed Base mint as well as the Arc burn; a burn alone is not receipt on Base. Signature verification proves the signed hash link, not the public paraphrase. Never create a shared receipt link during a page read.

Roll out in three reviewed, sequential PRs: shared tokens/primitives, landing, public pages. Each starts from a fresh worktree off the merged `origin/main`. Keep API, payment and authentication behaviour intact. Run the full verify and production build; inspect responsive screenshots, computed contrast, keyboard focus, reduced motion and production CSS. Measure production LCP and JS before/after under the same slow-4G conditions.
