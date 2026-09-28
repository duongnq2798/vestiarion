# Component system — Plan A: foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tested design system in `src/components/ui/` — tokens, Radix-based primitives, motion, toasts and a form hook — rendered in every state on a development-only `/design` page, with no existing screen changed yet.

**Architecture:** Brand tokens live in `src/app/globals.css` (`@theme`); primitives read nothing else. Server-safe primitives (Button, Badge, Card, …) carry no `"use client"`; anything with state, context or a Radix overlay is a client component. Class names are merged by `cn()` (clsx + tailwind-merge extended with our tokens), variants by `class-variance-authority`. Overlays animate with `tw-animate-css` on Radix `data-state`; Motion animates shared layout and presence inside `MotionProvider`. Plan B migrates every screen onto this.

**Tech Stack:** Next.js 16.3.6, React 19.2.8, Tailwind CSS 4.3, `radix-ui` 1.6.7, `motion` 13.4.4, `sonner` 2.0.8, `cmdk` 1.1.1, `lucide-react` 1.48.0, `class-variance-authority` 0.7.1, `clsx` 2.1.1, `tailwind-merge` 3.7.0, `tw-animate-css` 1.4.0, Vitest 5 (Node environment, `react-dom/server`).

**Spec:** `docs/superpowers/specs/2026-09-28-component-system-design.md` — read §3–§5, §7–§9 and §13 (the planning rulings, which win where they differ from earlier sections).

## Global Constraints

- Work only in `E:\APP2028\hackathon-project-ui` on branch `feat/component-system`. Never run commands in `E:\APP2028\hackathon-project`: another session uses that checkout.
- Read the relevant guide in `node_modules/next/dist/docs/` before writing Next code (`AGENTS.md`).
- New dependencies, exactly: `radix-ui@1.6.7 motion@13.4.4 sonner@2.0.8 cmdk@1.1.1 lucide-react@1.48.0 class-variance-authority@0.7.1 clsx@2.1.1 tailwind-merge@3.7.0`, and dev `tw-animate-css@1.4.0`. No others.
- `npm run verify` (lockfile check, typecheck, lint, tests) is green at every commit.
- Colours come only from the tokens in `globals.css` (`bg-agent`, `text-ink-3`, `border-line`, …, with `/opacity` allowed). No hex, `rgb()`, `hsl()` or `oklch()` in a `.tsx` file; `src/components/ui/tokens.ts` is the one TypeScript file allowed a colour literal. No Tailwind default palette (`red-500`, `zinc-200`, …) and no `white`/`black` utilities.
- Radius by role: `rounded-md` tags, chips, `Kbd`; `rounded-lg` menu items and `sm` controls; `rounded-xl` `md`/`lg` buttons and fields, callouts, menu surfaces; `rounded-2xl` cards and dialogs; `rounded-full` pills, avatars, progress tracks.
- Elevation: `shadow-control` (fields), `shadow-surface` (cards), `shadow-raised` (hovered interactive cards), `shadow-overlay` (menus, dialogs, sheets, toasts), `shadow-brand` (primary button).
- Motion: hover and press 150ms `ease-standard`; overlays in 200ms `ease-emphasized`, out 150ms `ease-exit`; sheets in 300ms, out 200ms. Values TypeScript needs come from `MOTION` in `src/components/ui/tokens.ts`.
- Touch: `md` controls are `h-11` below `sm` and `h-10` from `sm`; fields use `text-base` below `sm` and `text-sm` from `sm`.
- Imports are direct (`@/components/ui/Button`). No barrel file. Component files are PascalCase (`Button.tsx`); plain modules are lowercase (`cn.ts`, `tokens.ts`, `overlay.ts`, `chip.ts`, `motion-features.ts`, `useActionForm.ts`).
- The React Compiler lint rules are errors (`react-hooks/set-state-in-effect`, `react-hooks/refs`, `react-hooks/purity`, …): no synchronous `setState` in an effect body, no `ref.current` read during render.
- JSX text uses typographic apostrophes and quotes (’ “ ”); `react/no-unescaped-entities` is an error.
- Commit messages describe the change plainly (no mention of hackathons, judges or reviews) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A refused submission keeps what the person typed; a successful one clears every field, Radix Select and Checkbox included.** React resets a form after every `<form action>` submission whatever the result — `useActionForm` exists to stop that. Pinned by the form-lab checks in Task 8 (a browser check: it needs real DOM events).
2. **The submit button that was pressed is the one whose `name`/`value` reach the action, and only it shows the pending label.** Pinned by the `submittedBy` tests in Task 2 and the two-button form lab in Task 8.
3. **Radix Select and Checkbox values arrive in the action's `FormData`** (they submit through hidden native controls only when inside a form). Pinned by the form lab's echo in Task 8.
4. **Nothing is hidden before JavaScript runs**: `Reveal` adds no hidden state to the server's HTML and the default tab's panel is server-rendered. Pinned by tests in Task 6.
5. **A custom token survives class merging** (`text-reasoning` beside `text-ink`; a caller's `px-8` beating a variant's `px-4`). Pinned by tests in Tasks 1 and 2.

## File map

| File | Responsibility | Task |
|---|---|---|
| `package.json`, `package-lock.json` | the new dependencies | 1 |
| `vitest.config.mts` | runs `tests/**/*.test.tsx` too | 1 |
| `src/app/globals.css` | shadow, easing, animation tokens; `tw-animate-css`; `skeleton`; `Reveal` and `Disclosure` CSS | 1 |
| `src/components/ui/tokens.ts` | `THEME_COLOR`, `MOTION` — the CSS values TypeScript needs | 1 |
| `src/components/ui/cn.ts` | `cn()` | 1 |
| `src/components/ui/Spinner.tsx`, `Button.tsx`, `SubmitButton.tsx` | buttons | 2 |
| `src/components/ui/Badge.tsx`, `chip.ts`, `Card.tsx`, `Callout.tsx`, `Eyebrow.tsx`, `SectionHeader.tsx`, `EmptyState.tsx`, `Skeleton.tsx`, `ProgressBar.tsx`, `Kbd.tsx`, `Separator.tsx`, `Avatar.tsx`, `Table.tsx`, `Disclosure.tsx` | display | 3 |
| `src/components/ui/Field.tsx`, `Input.tsx`, `Select.tsx`, `Checkbox.tsx`, `FileInput.tsx`, `FormMessage.tsx`, `useActionForm.ts` | forms | 4 |
| `src/components/ui/overlay.ts`, `Tooltip.tsx`, `Dialog.tsx`, `ConfirmDialog.tsx`, `Sheet.tsx`, `DropdownMenu.tsx`, `Command.tsx` | overlays | 5 |
| `src/components/ui/MotionProvider.tsx`, `motion-features.ts`, `Tabs.tsx`, `Toaster.tsx`, `CopyButton.tsx`, `Reveal.tsx`; `src/app/layout.tsx` | motion, feedback, root wiring | 6 |
| `src/app/design/page.tsx`, `src/app/design/Demos.tsx`; `README.md` | the living reference | 7 |
| `tests/ui-*.test.ts(x)` | contracts | 1–6 |

---

### Task 1: Dependencies, tokens and `cn`

**Files:**
- Modify: `package.json`, `package-lock.json` (through npm)
- Modify: `vitest.config.mts`
- Modify: `src/app/globals.css`
- Create: `src/components/ui/tokens.ts`, `src/components/ui/cn.ts`
- Test: `tests/ui-tokens.test.ts`, `tests/ui-cn.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `THEME_COLOR: "#fffefa"` and `MOTION` from `@/components/ui/tokens`:
    `MOTION.ease.{standard,emphasized,exit}: readonly [number, number, number, number]`,
    `MOTION.duration.{micro,overlay,sheet,page,exit,reveal}: number` (seconds),
    `MOTION.spring: { type: "spring"; stiffness: 500; damping: 40 }`, `MOTION.stagger: number`.
  - `cn(...inputs: ClassValue[]): string` from `@/components/ui/cn`.
  - Tailwind utilities: `shadow-control|surface|raised|overlay|brand`, `drop-shadow-logo`, `ease-standard|emphasized|exit`, `animate-shimmer`, `skeleton`; `tw-animate-css`'s `animate-in`, `animate-out`, `fade-in-0`, `zoom-in-95`, `slide-in-from-*`, …; CSS for `[data-reveal]` and `details.disclosure`.

- [ ] **Step 1: Install the dependencies**

```bash
npm install radix-ui@1.6.7 motion@13.4.4 sonner@2.0.8 cmdk@1.1.1 lucide-react@1.48.0 class-variance-authority@0.7.1 clsx@2.1.1 tailwind-merge@3.7.0
npm install -D tw-animate-css@1.4.0
npm run check:lock
```

Expected: both installs succeed; `check:lock` prints that the lockfile describes `package.json`.

- [ ] **Step 2: Let Vitest run `.test.tsx` files**

Replace `vitest.config.mts` with:

```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Tests run in the `node` environment, not jsdom. Everything under test is
 * server-side treasury logic — hash chains, risk tiering, guardrails — or the
 * markup a UI primitive renders, which `react-dom/server` produces without a
 * DOM (the `*.test.tsx` files). Interaction is checked in the browser, on the
 * development-only /design page.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
    },
  },
});
```

- [ ] **Step 3: Write the failing tests**

`tests/ui-tokens.test.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MOTION, THEME_COLOR } from "@/components/ui/tokens";

/**
 * The few token values TypeScript needs are copies of CSS custom properties.
 * These tests read the stylesheet itself, so a change made to one side and not
 * the other fails here instead of drifting on screen.
 */

const css = readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");

function token(name: string): string | undefined {
  return new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1].trim();
}

describe("design tokens shared with TypeScript", () => {
  it("THEME_COLOR is the surface colour", () => {
    expect(token("color-surface")).toBe(THEME_COLOR);
  });

  it.each(Object.entries(MOTION.ease))("the %s easing matches its CSS token", (name, curve) => {
    expect(token(`ease-${name}`)).toBe(`cubic-bezier(${curve.join(", ")})`);
  });

  it.each(["control", "surface", "raised", "overlay", "brand"])("defines the %s elevation", (name) => {
    expect(token(`shadow-${name}`)).toBeDefined();
  });

  it("loads the overlay animation utilities", () => {
    expect(css).toMatch(/@import\s+"tw-animate-css";/);
  });
});
```

`tests/ui-cn.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cn } from "@/components/ui/cn";

describe("cn", () => {
  it("lets the later of two conflicting classes win", () => {
    expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
  });

  it("drops falsy inputs", () => {
    expect(cn("bg-agent", false, undefined, null, "text-on-agent")).toBe("bg-agent text-on-agent");
  });

  it("keeps the reasoning font size beside a text colour", () => {
    expect(cn("text-reasoning", "text-ink")).toBe("text-reasoning text-ink");
  });

  it("treats the reasoning size as a font size", () => {
    expect(cn("text-sm", "text-reasoning")).toBe("text-reasoning");
  });

  it("knows the elevations are one property", () => {
    expect(cn("shadow-surface", "shadow-overlay")).toBe("shadow-overlay");
  });

  it("knows the easing and animation tokens", () => {
    expect(cn("ease-standard", "ease-exit")).toBe("ease-exit");
    expect(cn("animate-arrive", "animate-shimmer")).toBe("animate-shimmer");
  });

  it("leaves the brand textures alone", () => {
    expect(cn("hatch", "border-dashed", "ledger-grid")).toBe("hatch border-dashed ledger-grid");
  });
});
```

- [ ] **Step 4: Run them to see them fail**

Run: `npx vitest run tests/ui-tokens.test.ts tests/ui-cn.test.ts`
Expected: FAIL — `Cannot find module '@/components/ui/tokens'` (and `cn`).

- [ ] **Step 5: Write `tokens.ts` and `cn.ts`**

`src/components/ui/tokens.ts`:

```ts
/**
 * The token values TypeScript needs, copied from `src/app/globals.css`.
 * `tests/ui-tokens.test.ts` reads both and fails if they drift apart.
 */

/** `--color-surface`: the browser chrome colour on phones. */
export const THEME_COLOR = "#fffefa";

export const MOTION = {
  /** `--ease-*`, as cubic-bezier control points. */
  ease: {
    standard: [0.2, 0.7, 0.2, 1],
    emphasized: [0.16, 1, 0.3, 1],
    exit: [0.4, 0, 1, 1],
  },
  /** Seconds, the unit Motion takes. */
  duration: {
    micro: 0.15,
    overlay: 0.2,
    sheet: 0.3,
    page: 0.42,
    exit: 0.18,
    reveal: 0.45,
  },
  /** Shared-layout indicators: quick to settle, no bounce. */
  spring: { type: "spring", stiffness: 500, damping: 40 },
  stagger: 0.06,
} as const;
```

`src/components/ui/cn.ts`:

```ts
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge knows Tailwind's default scale, not ours. Without these lists
 * it reads `text-reasoning` (a font size) as a colour and drops it beside
 * `text-ink`, and cannot tell that `shadow-surface` and `shadow-overlay` set
 * the same property.
 */
const merge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["reasoning"],
      shadow: ["control", "surface", "raised", "overlay", "brand"],
      "drop-shadow": ["logo"],
      ease: ["standard", "emphasized", "exit"],
      animate: ["arrive", "sweep", "drift", "shimmer"],
    },
  },
});

/** Joins class names; of two that set the same property, the later wins. */
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
```

- [ ] **Step 6: Add the tokens to the stylesheet**

In `src/app/globals.css`:

1. After the first line, `@import "tailwindcss";`, add `@import "tw-animate-css";`.
2. Replace the comment above `@theme` with:

```css
/*
 * Vestiarion's proof-first visual language: warm ledger paper, blue-black
 * ink, cobalt agent voice, jade proof, saffron waiting, vermilion refusal.
 * The palette is intentionally editorial rather than generic dashboard blue.
 *
 * Components take every colour, shadow and curve from the tokens below. The
 * few values TypeScript needs are mirrored in src/components/ui/tokens.ts,
 * and tests/ui-tokens.test.ts keeps the two equal.
 */
```

3. Inside `@theme`, after `--text-reasoning--line-height: 1.65;`, add:

```css
  /* Elevation: `surface` rests, `raised` is a card being hovered because it
     can be clicked, `overlay` floats above the page — menus, dialogs, toasts. */
  --shadow-control: 0 1px 2px rgb(24 33 28 / 0.05);
  --shadow-surface: 0 1px 0 rgb(24 33 28 / 0.04), 0 14px 40px rgb(43 54 47 / 0.07);
  --shadow-raised: 0 1px 0 rgb(24 33 28 / 0.05), 0 18px 48px rgb(43 54 47 / 0.12);
  --shadow-overlay: 0 2px 6px rgb(24 33 28 / 0.06), 0 24px 60px rgb(24 33 28 / 0.18);
  --shadow-brand: 0 12px 28px rgb(48 72 201 / 0.18), inset 0 1px 0 rgb(255 255 255 / 0.26);
  --drop-shadow-logo: 0 8px 14px rgb(48 72 201 / 0.2);

  /* Motion: `standard` for most movement, `emphasized` for what arrives,
     `exit` for what leaves. */
  --ease-standard: cubic-bezier(0.2, 0.7, 0.2, 1);
  --ease-emphasized: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-exit: cubic-bezier(0.4, 0, 1, 1);
```

4. After `--animate-drift: …;` add `--animate-shimmer: shimmer 1.8s ease-in-out infinite;`, and after the `drift` keyframes (still inside `@theme`) add:

```css
  @keyframes shimmer {
    from { background-position: 150% 0; }
    to { background-position: -50% 0; }
  }
```

5. After the `@utility logo-shadow { … }` block add:

```css
/* A loading placeholder: the raised colour with a slow band of light across it. */
@utility skeleton {
  background-color: var(--color-raised);
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--color-surface) 60%, transparent) 50%,
    transparent 100%
  );
  background-repeat: no-repeat;
  background-size: 200% 100%;
  animation: var(--animate-shimmer);
}
```

6. At the end of the `@layer components { … }` block (after the `@starting-style` rule), add:

```css
  /* `Reveal` (src/components/ui/Reveal.tsx) marks an element that started
     below the fold. Nothing is hidden in the server's HTML. */
  [data-reveal] {
    transition:
      opacity 450ms var(--ease-emphasized) var(--reveal-delay, 0ms),
      translate 450ms var(--ease-emphasized) var(--reveal-delay, 0ms);
  }

  [data-reveal="hidden"] {
    opacity: 0;
    translate: 0 12px;
  }
```

7. Before the `@media (prefers-reduced-motion: reduce)` block, add:

```css
/*
 * `Disclosure` (<details class="disclosure">) opens and closes smoothly where
 * the browser can animate to `height: auto`, and snaps elsewhere, as a
 * <details> always has.
 */
@supports (interpolate-size: allow-keywords) {
  :root {
    interpolate-size: allow-keywords;
  }

  details.disclosure::details-content {
    block-size: 0;
    overflow-y: clip;
    transition:
      block-size 220ms var(--ease-standard),
      content-visibility 220ms allow-discrete;
  }

  details.disclosure[open]::details-content {
    block-size: auto;
  }
}
```

Leave `surface-shadow`, `brand-shadow`, `logo-shadow` and `.nav-drawer` in place: existing screens still use them until Plan B.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/ui-tokens.test.ts tests/ui-cn.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 8: Build, and confirm the new CSS survives the build**

```bash
NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder SUPABASE_SERVICE_ROLE_KEY=ci-placeholder npm run build
grep -rlE "details-content" .next/static | head -1
grep -rlE "shadow-overlay|--ease-emphasized" .next/static | head -1
```

Expected: the build succeeds and each `grep` prints a CSS file. If the first `grep` prints nothing, the CSS optimiser dropped `::details-content`; if the build fails on that selector, delete the whole `@supports (interpolate-size …)` block. Either way, say so in your report: Plan A still works, and disclosures snap open instead of animating.

- [ ] **Step 9: Verify and commit**

```bash
npm run verify
git add package.json package-lock.json vitest.config.mts src/app/globals.css src/components/ui/tokens.ts src/components/ui/cn.ts tests/ui-tokens.test.ts tests/ui-cn.test.ts
git commit -m "feat(ui): design tokens, class merging and the UI libraries

Elevation, easing and animation tokens join the palette in globals.css,
with the values TypeScript needs mirrored in ui/tokens.ts and a test that
keeps both equal. cn() merges classes with tailwind-merge taught our custom
tokens. Adds Radix UI, Motion, Sonner, cmdk, lucide and tw-animate-css.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Buttons

**Files:**
- Create: `src/components/ui/Spinner.tsx`, `src/components/ui/Button.tsx`, `src/components/ui/SubmitButton.tsx`
- Test: `tests/ui-button.test.tsx`

**Interfaces:**
- Consumes: `cn` (Task 1).
- Produces:
  - `Spinner({ className?: string })` — decorative, `aria-hidden`.
  - `buttonVariants` (cva) and `Button(props: ButtonProps)` where `ButtonProps = ComponentProps<"button"> & { variant?: "primary" | "secondary" | "ghost" | "danger" | "danger-solid" | "inverse" | "link"; size?: "sm" | "md" | "lg" | "icon" | "icon-sm"; asChild?: boolean; loading?: boolean; icon?: ReactNode }`. Default `type="button"`.
  - `SubmitButton(props: SubmitButtonProps)` where `SubmitButtonProps = Omit<ButtonProps, "type" | "asChild"> & { pendingLabel?: string }`.
  - `submittedBy(data: FormData | null, name: string | undefined, value: ButtonProps["value"]): boolean`.

- [ ] **Step 1: Write the failing tests**

`tests/ui-button.test.tsx`:

```tsx
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/Button";
import { SubmitButton, submittedBy } from "@/components/ui/SubmitButton";

const html = (node: ReactElement) => renderToStaticMarkup(node);

describe("Button", () => {
  it("is a plain button unless told to submit", () => {
    expect(html(<Button>Save</Button>)).toMatch(/^<button type="button"/);
  });

  it("keeps an explicit type", () => {
    expect(html(<Button type="submit">Save</Button>)).toMatch(/^<button type="submit"/);
  });

  it("while loading is disabled, busy, and shows a spinner in the icon’s place", () => {
    const markup = html(
      <Button loading icon={<svg data-icon="" />}>
        Save
      </Button>
    );
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain("data-icon");
    expect(markup).toContain("animate-spin");
    expect(markup).toContain("Save");
  });

  it("renders its child instead of a button with asChild", () => {
    const markup = html(
      <Button asChild variant="secondary">
        <a href="/x">Open</a>
      </Button>
    );
    expect(markup).toMatch(/^<a /);
    expect(markup).toContain('href="/x"');
    expect(markup).not.toContain("<button");
    expect(markup).toContain("border-line-strong");
  });

  it("lets a caller’s class beat the variant’s", () => {
    const markup = html(<Button className="px-8">Wide</Button>);
    expect(markup).toContain("px-8");
    expect(markup).not.toMatch(/\bpx-4\b/);
  });

  it("complains in development when an icon-only button has no name", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    html(
      <Button size="icon">
        <svg />
      </Button>
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining("aria-label"));
    error.mockRestore();
  });

  it("stays quiet when an icon-only button is named", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    html(
      <Button size="icon" aria-label="Close">
        <svg />
      </Button>
    );
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("SubmitButton", () => {
  it("submits, and is idle outside a pending form", () => {
    const markup = html(<SubmitButton pendingLabel="Saving…">Save</SubmitButton>);
    expect(markup).toMatch(/^<button type="submit"/);
    expect(markup).toContain("Save");
    expect(markup).not.toContain("aria-busy");
  });

  it("can be marked busy by its owner", () => {
    const markup = html(
      <SubmitButton loading pendingLabel="Saving…">
        Save
      </SubmitButton>
    );
    expect(markup).toContain("Saving…");
    expect(markup).toContain('aria-busy="true"');
  });
});

describe("submittedBy — which submit button sent the form", () => {
  const data = new FormData();
  data.set("intent", "draft");

  it("is every button without a name", () => {
    expect(submittedBy(data, undefined, undefined)).toBe(true);
  });

  it("is the button whose name and value were sent, and no other", () => {
    expect(submittedBy(data, "intent", "draft")).toBe(true);
    expect(submittedBy(data, "intent", "submit")).toBe(false);
  });

  it("is no button while nothing is being submitted", () => {
    expect(submittedBy(null, "intent", "draft")).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/ui-button.test.tsx`
Expected: FAIL — `Cannot find module '@/components/ui/Button'`.

- [ ] **Step 3: Write the components**

`src/components/ui/Spinner.tsx`:

```tsx
import { cn } from "./cn";

/** Decorative: the control that shows it says what is happening. */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={cn("size-4 shrink-0 animate-spin", className)}>
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.75" />
      <path d="M14.25 8A6.25 6.25 0 0 0 8 1.75" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}
```

`src/components/ui/Button.tsx`:

```tsx
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";
import { Spinner } from "./Spinner";

/**
 * One button for the whole product. Variants name intent, not colour:
 * `primary` is the one thing a screen wants done, `danger` removes or
 * refuses, `inverse` sits on an agent-blue band, `link` reads as text.
 */
export const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap font-semibold",
    "transition duration-150 ease-standard",
    "disabled:pointer-events-none disabled:opacity-60 aria-busy:cursor-progress",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary: "bg-agent text-on-agent shadow-brand hover:-translate-y-px hover:bg-agent/95 active:translate-y-0 active:scale-[0.98]",
        secondary: "border border-line-strong bg-surface text-ink shadow-control hover:border-agent-line hover:text-agent active:scale-[0.98]",
        ghost: "text-ink-2 hover:bg-raised/70 hover:text-ink active:bg-raised",
        danger: "border border-refused-line bg-surface text-refused hover:bg-refused-soft active:scale-[0.98]",
        "danger-solid": "bg-refused text-on-agent shadow-control hover:bg-refused/90 active:scale-[0.98]",
        inverse: "bg-surface text-agent hover:-translate-y-px active:translate-y-0 active:scale-[0.98]",
        link: "gap-1 rounded-md text-sm font-medium text-agent underline-offset-4 hover:underline [&_svg]:size-3.5",
      },
      size: {
        sm: "h-8 rounded-lg px-3 text-xs [&_svg]:size-3.5",
        md: "h-11 rounded-xl px-4 text-sm sm:h-10 [&_svg]:size-4",
        lg: "h-12 rounded-xl px-5 text-[0.9375rem] [&_svg]:size-[1.125rem]",
        icon: "size-11 rounded-xl sm:size-10 [&_svg]:size-[1.125rem]",
        "icon-sm": "size-8 rounded-lg [&_svg]:size-4",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  }
);

export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Renders the child element — a `Link`, an `<a>` — with the button’s look instead of a `<button>`. */
    asChild?: boolean;
    /** Disables the button, marks it busy and shows a spinner in the leading icon’s place. */
    loading?: boolean;
    /** A leading icon. */
    icon?: ReactNode;
  };

const ICON_ONLY = new Set(["icon", "icon-sm"]);

export function Button({ className, variant, size, asChild = false, loading = false, icon, type, disabled, children, ...props }: ButtonProps) {
  const iconOnly = size != null && ICON_ONLY.has(size);
  if (process.env.NODE_ENV !== "production" && iconOnly && !props["aria-label"] && !props["aria-labelledby"]) {
    console.error("Button: an icon-only button needs an aria-label, or it has no accessible name.");
  }
  // A link reads as text: it takes no height or padding from a size.
  const classes = cn(buttonVariants({ variant, size: variant === "link" ? null : size }), className);

  if (asChild) {
    return (
      <Slot.Root className={classes} {...(props as ComponentProps<typeof Slot.Root>)}>
        {children}
      </Slot.Root>
    );
  }

  return (
    <button type={type ?? "button"} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading ? <Spinner /> : icon}
      {loading && iconOnly ? null : children}
    </button>
  );
}
```

`src/components/ui/SubmitButton.tsx`:

```tsx
"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "./Button";

/**
 * Whether the submission in `data` was sent by the button with this `name`
 * and `value`. A button without a name cannot be told apart, so it counts as
 * the sender of any submission.
 */
export function submittedBy(data: FormData | null, name: string | undefined, value: ButtonProps["value"]): boolean {
  if (!data) return false;
  if (name == null || value == null) return true;
  return data.get(name) === String(value);
}

export type SubmitButtonProps = Omit<ButtonProps, "type" | "asChild"> & {
  /** Replaces the label while this button’s submission runs: “Saving…”. */
  pendingLabel?: string;
};

/**
 * A form’s submit button. It learns from the form itself when a submission is
 * running — no `pending` prop to thread through. Of several submit buttons,
 * only the one pressed shows it; all of them stop taking clicks.
 */
export function SubmitButton({ pendingLabel, loading = false, disabled, name, value, children, ...props }: SubmitButtonProps) {
  const { pending, data } = useFormStatus();
  const busy = loading || (pending && submittedBy(data, name, value));
  return (
    <Button type="submit" name={name} value={value} loading={busy} disabled={disabled || pending} {...props}>
      {busy && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/ui-button.test.tsx`
Expected: PASS, 12 tests.

- [ ] **Step 5: Verify and commit**

```bash
npm run verify
git add src/components/ui/Spinner.tsx src/components/ui/Button.tsx src/components/ui/SubmitButton.tsx tests/ui-button.test.tsx
git commit -m "feat(ui): Button and SubmitButton

One button with intent-named variants, sizes that are 44px on touch
widths, a loading state that disables it and shows a spinner, and asChild
for links. SubmitButton reads its form's status, and of several submit
buttons only the one pressed shows the pending label.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Display primitives

**Files:**
- Create: `src/components/ui/Badge.tsx`, `chip.ts`, `Card.tsx`, `Callout.tsx`, `Eyebrow.tsx`, `SectionHeader.tsx`, `EmptyState.tsx`, `Skeleton.tsx`, `ProgressBar.tsx`, `Kbd.tsx`, `Separator.tsx`, `Avatar.tsx`, `Table.tsx`, `Disclosure.tsx` (all under `src/components/ui/`)
- Test: `tests/ui-display.test.tsx`

**Interfaces:**
- Consumes: `cn` (Task 1).
- Produces (all server-safe, no `"use client"`):
  - `Badge({ tone?: "neutral" | "agent" | "proof" | "held" | "refused" | "simulated"; size?: "sm" | "md"; shape?: "pill" | "tag"; dot?: boolean; icon?: ReactNode; title?: string; className?: string; children })`, `badgeVariants`.
  - `chipVariants({ selected?: boolean })`.
  - `Card({ tone?: "default" | "agent" | "held" | "refused" | "simulated"; interactive?: boolean; asChild?: boolean } & ComponentProps<"div">)`, `cardVariants`, and `CardHeader`, `CardTitle` (`h3`), `CardDescription`, `CardContent`, `CardFooter`.
  - `Callout({ tone?: "neutral" | "agent" | "proof" | "held" | "refused"; title?: ReactNode; icon?: ReactNode; role?: "alert" | "status"; className?: string; children? })`.
  - `Eyebrow({ children, className? })`, `SectionHeader({ title, meta?, action?, id?, className? })`.
  - `EmptyState({ title, body?, icon?, action?, compact?: boolean; titleAs?: "h2" | "h3"; className? })`.
  - `Skeleton({ className? })`, `ProgressBar({ value?: number; label: string; className? })`, `Kbd({ children, className? })`, `Separator({ orientation?: "horizontal" | "vertical"; className? })`.
  - `Avatar({ name: string; tone?: "ink" | "agent"; shape?: "circle" | "square"; size?: "sm" | "md" | "lg"; className? })`.
  - `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead` (`scope="col"`), `TableCell` — each takes its element’s props.
  - `Disclosure({ summary: ReactNode; children; defaultOpen?: boolean; variant?: "default" | "bare"; id?: string; className?; summaryClassName?; contentClassName? })`.

- [ ] **Step 1: Write the failing tests**

`tests/ui-display.test.tsx`:

```tsx
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";

const html = (node: ReactElement) => renderToStaticMarkup(node);

describe("Badge", () => {
  it("colours by tone and still says it in words", () => {
    const markup = html(<Badge tone="refused">Refused by guardrail</Badge>);
    expect(markup).toContain("text-refused");
    expect(markup).toContain("Refused by guardrail");
  });

  it("hatches what is simulated", () => {
    expect(html(<Badge tone="simulated">Simulated</Badge>)).toContain("hatch");
  });

  it("draws a dot in its tone when asked", () => {
    expect(html(<Badge tone="proof" dot>Live</Badge>)).toContain("bg-proof");
  });
});

describe("Callout", () => {
  it("draws its tone’s icon and takes the role it is given", () => {
    const markup = html(
      <Callout tone="refused" role="alert" title="Blocked by code">
        The guardrail refused it.
      </Callout>
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("<svg");
    expect(markup).toContain("Blocked by code");
  });

  it("has no role unless given one", () => {
    expect(html(<Callout>Standing information</Callout>)).not.toContain("role=");
  });
});

describe("ProgressBar", () => {
  it("reports a determinate value", () => {
    const markup = html(<ProgressBar value={42} label="Import" />);
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="42"');
  });

  it("leaves the value out while indeterminate", () => {
    const markup = html(<ProgressBar label="Running the cycle" />);
    expect(markup).not.toContain("aria-valuenow");
    expect(markup).toContain("animate-sweep");
  });

  it("clamps a value outside 0–100", () => {
    expect(html(<ProgressBar value={140} label="Import" />)).toContain('aria-valuenow="100"');
  });
});

describe("EmptyState", () => {
  it("titles itself at the level it is given", () => {
    expect(html(<EmptyState title="No invoices" titleAs="h2" />)).toContain("<h2");
    expect(html(<EmptyState title="No invoices" />)).toContain("<h3");
  });
});

describe("Avatar", () => {
  it("shows an initial and hides from screen readers", () => {
    const markup = html(<Avatar name="  acme treasury" />);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain(">a<");
  });

  it("falls back when the name is blank", () => {
    expect(html(<Avatar name="   " />)).toContain(">?<");
  });
});

describe("Disclosure", () => {
  it("is a details element the stylesheet can animate", () => {
    const markup = html(<Disclosure summary="Score inputs">Four clean payments</Disclosure>);
    expect(markup).toMatch(/^<details class="disclosure/);
    expect(markup).toContain("<summary");
    expect(markup).toContain("Four clean payments");
  });

  it("opens when asked", () => {
    expect(
      html(
        <Disclosure summary="Key" defaultOpen>
          PEM
        </Disclosure>
      )
    ).toMatch(/<details[^>]* open=""/);
  });

  it("draws no frame or chevron when bare", () => {
    const markup = html(
      <Disclosure variant="bare" summary="#0042">
        detail
      </Disclosure>
    );
    expect(markup).not.toContain("<svg");
    expect(markup).not.toContain("rounded-2xl");
  });
});

describe("Table", () => {
  it("scrolls sideways instead of widening the page", () => {
    const markup = html(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Email</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>ada@example.com</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );
    expect(markup).toMatch(/^<div class="[^"]*overflow-x-auto/);
    expect(markup).toContain('scope="col"');
  });
});

describe("Card", () => {
  it("renders a link with the card’s look through asChild", () => {
    const markup = html(
      <Card asChild interactive>
        <a href="#x">Open</a>
      </Card>
    );
    expect(markup).toMatch(/^<a /);
    expect(markup).toContain("hover:shadow-raised");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/ui-display.test.tsx`
Expected: FAIL — `Cannot find module '@/components/ui/Avatar'`.

- [ ] **Step 3: Write the components**

`src/components/ui/Badge.tsx`:

```tsx
import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "./cn";

export const badgeVariants = cva("inline-flex max-w-full items-center gap-1.5 whitespace-nowrap border font-semibold [&_svg]:shrink-0", {
  variants: {
    tone: {
      neutral: "border-line-strong bg-surface text-ink-2",
      agent: "border-agent-line bg-agent-soft text-agent",
      proof: "border-proof-line bg-proof-soft text-proof",
      held: "border-held-line bg-held-soft text-held",
      refused: "border-refused-line bg-refused-soft text-refused",
      simulated: "hatch border-dashed border-line-strong bg-surface/70 text-ink-2",
    },
    size: {
      sm: "rounded-full px-2 py-0.5 text-[0.6875rem] [&_svg]:size-3",
      md: "rounded-full px-2.5 py-1 text-xs [&_svg]:size-3.5",
    },
    shape: {
      pill: "",
      tag: "rounded-md",
    },
  },
  defaultVariants: { tone: "neutral", size: "md", shape: "pill" },
});

type Tone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

const DOT: Record<Tone, string> = {
  neutral: "bg-ink-3",
  agent: "bg-agent",
  proof: "bg-proof",
  held: "bg-held",
  refused: "bg-refused",
  simulated: "border border-dashed border-ink-3",
};

export type BadgeProps = VariantProps<typeof badgeVariants> & {
  children: ReactNode;
  /** A leading status dot in the badge’s tone. */
  dot?: boolean;
  /** A leading icon; takes the dot’s place. */
  icon?: ReactNode;
  title?: string;
  className?: string;
};

/** A status or a label. Tone carries meaning, so a badge always says it in words too. */
export function Badge({ tone, size, shape, dot = false, icon, title, className, children }: BadgeProps) {
  return (
    <span title={title} className={cn(badgeVariants({ tone, size, shape }), className)}>
      {icon ?? (dot ? <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[tone ?? "neutral"])} /> : null)}
      {children}
    </span>
  );
}
```

`src/components/ui/chip.ts`:

```ts
import { cva } from "class-variance-authority";

/** A filter pill that is a link. `selected` marks the filter in force; pair it with `aria-current`. */
export const chipVariants = cva(
  "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-standard sm:h-7 sm:px-2.5 [&_svg]:size-2.5 [&_svg]:shrink-0",
  {
    variants: {
      selected: {
        true: "border-ink-3 bg-raised text-ink",
        false: "border-line bg-surface/60 text-ink-2 hover:border-line-strong hover:text-ink",
      },
    },
    defaultVariants: { selected: false },
  }
);
```

`src/components/ui/Card.tsx`:

```tsx
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "./cn";

export const cardVariants = cva("rounded-2xl border bg-surface shadow-surface", {
  variants: {
    tone: {
      default: "border-line",
      agent: "border-agent-line",
      held: "border-held-line",
      refused: "border-refused-line",
      simulated: "border-dashed border-line-strong",
    },
    interactive: {
      true: "transition duration-200 ease-standard hover:-translate-y-0.5 hover:border-agent-line hover:shadow-raised active:translate-y-0",
      false: "",
    },
  },
  defaultVariants: { tone: "default", interactive: false },
});

export type CardProps = ComponentProps<"div"> & VariantProps<typeof cardVariants> & { asChild?: boolean };

/** A surface that holds one thing. `asChild` gives a `Link`, `article` or `li` the card’s look. */
export function Card({ tone, interactive, asChild = false, className, ...props }: CardProps) {
  const Comp = asChild ? Slot.Root : "div";
  return <Comp className={cn(cardVariants({ tone, interactive }), className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("flex flex-col gap-1 px-5 pt-5 sm:px-6 sm:pt-6", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 className={cn("text-base font-semibold leading-snug tracking-tight text-ink", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-sm leading-relaxed text-ink-2", className)} {...props} />;
}

/** The card’s body. Right after a header it sits closer, as the header’s continuation. */
export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("p-5 sm:p-6 [[data-slot=card-header]+&]:pt-4", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-wrap items-center gap-3 rounded-b-2xl border-t border-line bg-ground/40 px-5 py-3 sm:px-6", className)} {...props} />;
}
```

`src/components/ui/Callout.tsx`:

```tsx
import { cva, type VariantProps } from "class-variance-authority";
import { CircleCheck, CirclePause, Info, OctagonMinus, Sparkles, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

export const calloutVariants = cva("flex gap-3 rounded-xl border px-4 py-3 text-sm", {
  variants: {
    tone: {
      neutral: "border-line-strong bg-surface text-ink-2",
      agent: "border-agent-line bg-agent-soft text-ink",
      proof: "border-proof-line bg-proof-soft text-ink",
      held: "border-held-line bg-held-soft text-ink",
      refused: "border-refused-line bg-refused-soft text-ink",
    },
  },
  defaultVariants: { tone: "neutral" },
});

type Tone = NonNullable<VariantProps<typeof calloutVariants>["tone"]>;

// The same shapes as the outcome glyphs: a pause for held, an octagon for refused.
const TONE: Record<Tone, { icon: LucideIcon; accent: string }> = {
  neutral: { icon: Info, accent: "text-ink" },
  agent: { icon: Sparkles, accent: "text-agent" },
  proof: { icon: CircleCheck, accent: "text-proof" },
  held: { icon: CirclePause, accent: "text-held" },
  refused: { icon: OctagonMinus, accent: "text-refused" },
};

export type CalloutProps = {
  tone?: Tone;
  title?: ReactNode;
  /** Replaces the tone’s icon. */
  icon?: ReactNode;
  /** `alert` for something that went wrong just now, `status` for news, nothing for standing information. */
  role?: "alert" | "status";
  className?: string;
  children?: ReactNode;
};

/** A block that stands apart from the page: a refusal, a warning, a recommendation. */
export function Callout({ tone = "neutral", title, icon, role, className, children }: CalloutProps) {
  const { icon: Icon, accent } = TONE[tone];
  return (
    <div role={role} className={cn(calloutVariants({ tone }), className)}>
      <span aria-hidden className={cn("mt-0.5 shrink-0 [&_svg]:size-[1.125rem]", accent)}>
        {icon ?? <Icon />}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className={cn("font-semibold leading-snug", accent)}>{title}</p>}
        {children && <div className="leading-relaxed">{children}</div>}
      </div>
    </div>
  );
}
```

`src/components/ui/Eyebrow.tsx`:

```tsx
import type { ReactNode } from "react";
import { cn } from "./cn";

/** The small monospaced caption above a figure or a heading. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-ink-3", className)}>{children}</span>;
}
```

`src/components/ui/SectionHeader.tsx`:

```tsx
import type { ReactNode } from "react";
import { cn } from "./cn";

/** A section’s title, a quiet note beside it, and an action on the right. */
export function SectionHeader({ title, meta, action, id, className }: { title: ReactNode; meta?: ReactNode; action?: ReactNode; id?: string; className?: string }) {
  return (
    <div className={cn("mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1", className)}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={id} className="text-base font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {meta && <span className="text-[0.8125rem] text-ink-3">{meta}</span>}
      </div>
      {action}
    </div>
  );
}
```

`src/components/ui/EmptyState.tsx`:

```tsx
import type { ReactNode } from "react";
import { cn } from "./cn";

/** What an empty view says instead of nothing: what would be here, and how to get it there. */
export function EmptyState({
  title,
  body,
  icon,
  action,
  compact = false,
  titleAs: Title = "h3",
  className,
}: {
  title: ReactNode;
  body?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  titleAs?: "h2" | "h3";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "hatch flex flex-col items-start gap-4 rounded-2xl border border-dashed border-line-strong bg-surface/80",
        compact ? "px-4 py-6" : "px-5 py-8 sm:px-8 sm:py-10",
        className
      )}
    >
      {icon && (
        <span aria-hidden className="grid size-10 place-items-center rounded-full border border-line bg-surface text-ink-3 shadow-control [&_svg]:size-5">
          {icon}
        </span>
      )}
      <div className="space-y-1.5">
        <Title className="text-base font-semibold text-ink">{title}</Title>
        {body && <div className="max-w-prose text-sm leading-relaxed text-ink-2">{body}</div>}
      </div>
      {action}
    </div>
  );
}
```

`src/components/ui/Skeleton.tsx`:

```tsx
import { cn } from "./cn";

/** A placeholder in the shape of what is loading. Decorative: the region around it says it is busy. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton rounded-lg", className)} />;
}
```

`src/components/ui/ProgressBar.tsx`:

```tsx
import { cn } from "./cn";

/** Progress towards a known end (`value`, 0–100), or indeterminate work when there is no value. */
export function ProgressBar({ value, label, className }: { value?: number; label: string; className?: string }) {
  const percent = value == null ? null : Math.round(Math.min(100, Math.max(0, value)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className={cn("relative h-1 w-full overflow-hidden rounded-full bg-agent-soft", className)}
    >
      {percent == null ? (
        <span className="absolute inset-y-0 left-0 w-2/5 rounded-full bg-agent animate-sweep" />
      ) : (
        <span className="absolute inset-y-0 left-0 rounded-full bg-agent transition-[width] duration-300 ease-standard" style={{ width: `${percent}%` }} />
      )}
    </div>
  );
}
```

`src/components/ui/Kbd.tsx`:

```tsx
import type { ReactNode } from "react";
import { cn } from "./cn";

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-line-strong bg-surface px-1.5 font-mono text-[0.6875rem] font-medium text-ink-3 shadow-control", className)}>
      {children}
    </kbd>
  );
}
```

`src/components/ui/Separator.tsx`:

```tsx
import { cn } from "./cn";

/** A hairline between groups. Decorative: headings and lists carry the structure. */
export function Separator({ orientation = "horizontal", className }: { orientation?: "horizontal" | "vertical"; className?: string }) {
  return <div aria-hidden className={cn("shrink-0 bg-line", orientation === "horizontal" ? "h-px w-full" : "w-px self-stretch", className)} />;
}
```

`src/components/ui/Avatar.tsx`:

```tsx
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn";

const avatarVariants = cva("grid shrink-0 select-none place-items-center font-semibold uppercase", {
  variants: {
    tone: {
      ink: "bg-ink text-ground",
      agent: "border border-agent-line bg-agent-soft text-agent",
    },
    shape: {
      circle: "rounded-full",
      square: "rounded-lg",
    },
    size: {
      sm: "size-7 text-xs",
      md: "size-8 text-xs",
      lg: "size-9 text-sm",
    },
  },
  defaultVariants: { tone: "ink", shape: "circle", size: "md" },
});

/**
 * An initial in a shape: people are circles, workspaces are rounded squares.
 * Decorative — the name is always written beside it.
 */
export function Avatar({ name, tone, shape, size, className }: VariantProps<typeof avatarVariants> & { name: string; className?: string }) {
  return (
    <span aria-hidden="true" className={cn(avatarVariants({ tone, shape, size }), className)}>
      {name.trim().charAt(0) || "?"}
    </span>
  );
}
```

`src/components/ui/Table.tsx`:

```tsx
import type { ComponentProps } from "react";
import { cn } from "./cn";

/** A data table that scrolls sideways inside its own frame on a narrow screen. */
export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-left text-sm", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={cn("border-b border-line", className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={cn("divide-y divide-line [&>tr]:transition-colors [&>tr]:duration-150 [&>tr:hover]:bg-raised/40", className)} {...props} />;
}

export function TableRow(props: ComponentProps<"tr">) {
  return <tr {...props} />;
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return <th scope="col" className={cn("whitespace-nowrap px-4 py-3 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-ink-3", className)} {...props} />;
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("px-4 py-3 align-middle text-ink", className)} {...props} />;
}
```

`src/components/ui/Disclosure.tsx`:

```tsx
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * Show and hide, built on <details>: it works before JavaScript runs, opens for
 * find-in-page, and animates its height where the browser can (`.disclosure`
 * in globals.css). `bare` drops the frame and the chevron, for rows that draw
 * their own summary.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen,
  variant = "default",
  id,
  className,
  summaryClassName,
  contentClassName,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  variant?: "default" | "bare";
  id?: string;
  className?: string;
  summaryClassName?: string;
  contentClassName?: string;
}) {
  const framed = variant === "default";
  return (
    <details id={id} open={defaultOpen} className={cn("disclosure group/disclosure", framed && "rounded-2xl border border-line bg-surface shadow-surface", className)}>
      <summary
        className={cn(
          "cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden",
          framed && "flex items-center gap-2 rounded-2xl px-4 py-3 text-sm font-medium text-ink-2 transition-colors duration-150 hover:text-ink",
          summaryClassName
        )}
      >
        {framed && <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-3 transition-transform duration-200 ease-standard group-open/disclosure:rotate-90" />}
        {summary}
      </summary>
      <div className={cn(framed && "px-4 pb-4", contentClassName)}>{children}</div>
    </details>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/ui-display.test.tsx`
Expected: PASS, 16 tests.

- [ ] **Step 5: Verify and commit**

```bash
npm run verify
git add src/components/ui/Badge.tsx src/components/ui/chip.ts src/components/ui/Card.tsx src/components/ui/Callout.tsx src/components/ui/Eyebrow.tsx src/components/ui/SectionHeader.tsx src/components/ui/EmptyState.tsx src/components/ui/Skeleton.tsx src/components/ui/ProgressBar.tsx src/components/ui/Kbd.tsx src/components/ui/Separator.tsx src/components/ui/Avatar.tsx src/components/ui/Table.tsx src/components/ui/Disclosure.tsx tests/ui-display.test.tsx
git commit -m "feat(ui): display primitives

Badge, filter chips, Card, Callout, Eyebrow, SectionHeader, EmptyState,
Skeleton, ProgressBar, Kbd, Separator, Avatar, Table and a Disclosure built
on <details>. All render on the server; tone is always said in words or an
icon as well as colour.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Form primitives and `useActionForm`

**Files:**
- Create: `src/components/ui/Field.tsx`, `Input.tsx`, `Select.tsx`, `Checkbox.tsx`, `FileInput.tsx`, `FormMessage.tsx`, `useActionForm.ts` (under `src/components/ui/`)
- Create: `src/components/ui/overlay.ts` (the Select’s popover shares it with Task 5)
- Test: `tests/ui-forms.test.tsx`

**Interfaces:**
- Consumes: `cn` (Task 1).
- Produces:
  - `Field({ id: string; label: ReactNode; description?: ReactNode; error?: ReactNode; optional?: boolean; className?; children })` (client), `useField(): FieldState | null`, `useFieldControl(props: { id?: string; "aria-describedby"?: string; "aria-invalid"?: … }): { id; "aria-describedby"; "aria-invalid" }`.
  - `controlBase: string`, `controlVariants({ size?: "sm" | "md" })`, `Input(props: Omit<ComponentProps<"input">, "size"> & { size?: "sm" | "md" })`, `Textarea(props: ComponentProps<"textarea">)`.
  - `Select` (Radix Root), `SelectValue`, `SelectGroup`, `SelectTrigger({ size?: "sm" | "md", … })`, `SelectContent`, `SelectItem`.
  - `Checkbox({ label: ReactNode; description?: ReactNode; id?: string; name?; defaultChecked?; … })`.
  - `FileInput({ id: string; name?: string; accept?: string; label: string; description?: string; disabled?: boolean; onFile: (file: File | undefined) => void; inputRef?: RefObject<HTMLInputElement | null> })`.
  - `FormMessage({ tone?: "neutral" | "success" | "error"; children?; className? })` (server-safe).
  - `ActionResult = { ok: boolean; message: string }` and `useActionForm<State extends ActionResult>(action: (previous: State, formData: FormData) => Promise<State>, initial: State, options?: { resetOnSuccess?: boolean; toastOnSuccess?: boolean }): { state: State; pending: boolean; formProps: { ref; action; onSubmit } }`.
  - From `overlay.ts`: `overlaySurface`, `overlayMotion`, `overlayBackdrop`, `dialogPanel`, `dialogMotion`, `menuItemBase`, `menuItem` (class strings).

- [ ] **Step 1: Write the failing tests**

`tests/ui-forms.test.tsx`:

```tsx
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { FileInput } from "@/components/ui/FileInput";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input, Textarea } from "@/components/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";

const html = (node: ReactElement) => renderToStaticMarkup(node);

describe("Field", () => {
  it("labels its control and points it at the description", () => {
    const markup = html(
      <Field id="email" label="Email" description="Where the link goes">
        <Input name="email" />
      </Field>
    );
    expect(markup).toContain('<label for="email"');
    expect(markup).toContain('id="email"');
    expect(markup).toContain('aria-describedby="email-description"');
    expect(markup).toContain('id="email-description"');
    expect(markup).not.toContain("aria-invalid");
  });

  it("marks its control invalid and names the error", () => {
    const markup = html(
      <Field id="amount" label="Amount" description="USDC" error="Must be positive">
        <Input name="amount" />
      </Field>
    );
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('aria-describedby="amount-description amount-error"');
    expect(markup).toContain('id="amount-error"');
  });

  it("gives a select trigger the same wiring", () => {
    const markup = html(
      <Field id="role" label="Role">
        <Select name="role" defaultValue="viewer">
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="viewer">Viewer</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    );
    expect(markup).toMatch(/<button[^>]*id="role"/);
  });

  it("leaves a control outside a Field as it was given", () => {
    const markup = html(<Input id="own" aria-describedby="elsewhere" />);
    expect(markup).toContain('id="own"');
    expect(markup).toContain('aria-describedby="elsewhere"');
  });

  it("uses 16px text on phones, so iOS does not zoom into the field", () => {
    expect(html(<Input />)).toContain("text-base");
    expect(html(<Textarea />)).toContain("sm:text-sm");
  });
});

describe("Checkbox", () => {
  it("is a labelled checkbox", () => {
    const markup = html(<Checkbox id="received" name="goodsReceived" label="Goods received" />);
    expect(markup).toContain('role="checkbox"');
    expect(markup).toContain('<label for="received"');
  });
});

describe("FileInput", () => {
  it("keeps a real, focusable file input under its label", () => {
    const markup = html(<FileInput id="csv" name="csv" accept=".csv" label="Choose a CSV file" onFile={() => {}} />);
    expect(markup).toContain('<label for="csv"');
    expect(markup).toMatch(/<input[^>]*type="file"/);
    expect(markup).toContain('accept=".csv"');
    expect(markup).toContain("sr-only");
  });
});

describe("FormMessage", () => {
  it("is a live region that is there even while empty", () => {
    const markup = html(<FormMessage />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
  });

  it("says an error with an icon, not by colour alone", () => {
    const markup = html(<FormMessage tone="error">Amount must be positive</FormMessage>);
    expect(markup).toContain("text-refused");
    expect(markup).toContain("<svg");
    expect(markup).toContain("Amount must be positive");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/ui-forms.test.tsx`
Expected: FAIL — `Cannot find module '@/components/ui/Checkbox'`.

- [ ] **Step 3: Write the shared overlay classes**

`src/components/ui/overlay.ts`:

```ts
/**
 * The classes every floating surface shares, so a menu, a select and a dialog
 * open, close and sit above the page the same way. Radix sets `data-state` and
 * `data-side`; `tw-animate-css` turns them into motion.
 */

export const overlaySurface = "z-50 rounded-xl border border-line bg-surface text-ink shadow-overlay outline-hidden";

export const overlayMotion = [
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
  "data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1",
  "data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1",
  "duration-200 ease-emphasized data-[state=closed]:duration-150 data-[state=closed]:ease-exit",
].join(" ");

/** The dimmed page behind a dialog or a sheet. */
export const overlayBackdrop = [
  "fixed inset-0 z-50 bg-ink/40 backdrop-blur-[2px]",
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
  "duration-200 data-[state=closed]:duration-150",
].join(" ");

/** A panel in the middle of the screen: dialogs and confirmations. */
export const dialogPanel =
  "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-surface p-5 text-ink shadow-overlay outline-hidden sm:p-6";

export const dialogMotion = [
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
  "duration-200 ease-emphasized data-[state=closed]:duration-150 data-[state=closed]:ease-exit",
].join(" ");

/** A row in a menu, a select or the command palette. 44px tall on touch widths. */
export const menuItemBase =
  "relative flex min-h-11 cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 text-sm text-ink-2 outline-hidden transition-colors duration-150 sm:min-h-9 [&_svg]:size-4 [&_svg]:shrink-0 [&>svg]:text-ink-3";

/** A Radix menu or select row: Radix marks the row under the pointer or the arrow keys `data-highlighted`. */
export const menuItem = `${menuItemBase} data-[highlighted]:bg-raised/80 data-[highlighted]:text-ink data-[disabled]:pointer-events-none data-[disabled]:opacity-50`;
```

- [ ] **Step 4: Write the field components**

`src/components/ui/Field.tsx`:

```tsx
"use client";

import { CircleAlert } from "lucide-react";
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { cn } from "./cn";

export interface FieldState {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

const FieldContext = createContext<FieldState | null>(null);

/** The ids of the Field a control sits in, or null outside one. */
export function useField(): FieldState | null {
  return useContext(FieldContext);
}

type ControlProps = { id?: string; "aria-describedby"?: string; "aria-invalid"?: ComponentProps<"input">["aria-invalid"] };

/** What a control takes from the Field around it — unless it was given its own. */
export function useFieldControl(props: ControlProps) {
  const field = useField();
  return {
    id: props.id ?? field?.id,
    "aria-describedby": props["aria-describedby"] ?? field?.describedBy,
    "aria-invalid": props["aria-invalid"] ?? (field?.invalid ? true : undefined),
  };
}

export interface FieldProps {
  /** The control’s id: the label points at it and the description and error hang off it. */
  id: string;
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * A labelled control. The one control inside takes its id and
 * `aria-describedby` from here, so a description or an error is always
 * announced with the field it belongs to.
 */
export function Field({ id, label, description, error, optional = false, className, children }: FieldProps) {
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: Boolean(error) }}>
      <div className={cn("grid content-start gap-1.5", className)}>
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
          {optional && <span className="ml-1 font-normal text-ink-3">(optional)</span>}
        </label>
        {children}
        {description && (
          <p id={descriptionId} className="text-xs leading-relaxed text-ink-3">
            {description}
          </p>
        )}
        {error && (
          <p id={errorId} className="flex items-start gap-1.5 text-xs font-medium text-refused">
            <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}
```

`src/components/ui/Input.tsx`:

```tsx
"use client";

import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn";
import { useFieldControl } from "./Field";

/** The frame every text-like control shares — inputs, text areas, select triggers — without a height. */
export const controlBase = [
  "w-full min-w-0 border border-line-strong bg-surface text-base text-ink shadow-control outline-hidden sm:text-sm",
  "transition-[border-color,box-shadow] duration-150 ease-standard placeholder:text-ink-3",
  "focus-visible:border-agent focus-visible:ring-4 focus-visible:ring-agent-soft",
  "aria-invalid:border-refused aria-invalid:focus-visible:ring-refused-soft",
  "disabled:cursor-not-allowed disabled:opacity-60",
].join(" ");

export const controlVariants = cva(controlBase, {
  variants: {
    size: {
      sm: "h-9 rounded-lg px-2.5 sm:h-8",
      md: "h-11 rounded-xl px-3 sm:h-10",
    },
  },
  defaultVariants: { size: "md" },
});

export type InputProps = Omit<ComponentProps<"input">, "size"> & { size?: VariantProps<typeof controlVariants>["size"] };

export function Input({ className, size, ...props }: InputProps) {
  const control = useFieldControl(props);
  return <input className={cn(controlVariants({ size }), className)} {...props} {...control} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  const control = useFieldControl(props);
  return <textarea className={cn(controlBase, "min-h-24 resize-y rounded-xl px-3 py-2.5", className)} {...props} {...control} />;
}
```

`src/components/ui/Select.tsx`:

```tsx
"use client";

import { Check, ChevronDown } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "./cn";
import { useFieldControl } from "./Field";
import { controlVariants } from "./Input";
import { menuItem, overlayMotion, overlaySurface } from "./overlay";

/**
 * A select that looks the same on every system. Given a `name` inside a form,
 * Radix renders a hidden native select, so the value reaches the form’s
 * `FormData`, and it returns to `defaultValue` when the form resets.
 */
export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectGroup = SelectPrimitive.Group;

export function SelectTrigger({ className, size, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger> & { size?: "sm" | "md" }) {
  const control = useFieldControl(props);
  return (
    <SelectPrimitive.Trigger
      className={cn(controlVariants({ size }), "group/select flex cursor-pointer items-center justify-between gap-2 text-left data-[placeholder]:text-ink-3 [&>span]:truncate", className)}
      {...props}
      {...control}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown aria-hidden className="size-4 shrink-0 text-ink-3 transition-transform duration-200 ease-standard group-data-[state=open]/select:rotate-180" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({ className, children, position = "popper", ...props }: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        sideOffset={6}
        className={cn(
          overlaySurface,
          overlayMotion,
          "relative max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) origin-(--radix-select-content-transform-origin) overflow-y-auto overflow-x-hidden p-1",
          className
        )}
        {...props}
      >
        <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item className={cn(menuItem, "pr-9", className)} {...props}>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2.5 inline-flex">
        <Check aria-hidden className="text-agent" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}
```

`src/components/ui/Checkbox.tsx`:

```tsx
"use client";

import { Check } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "./cn";

export type CheckboxProps = Omit<ComponentProps<typeof CheckboxPrimitive.Root>, "children"> & {
  label: ReactNode;
  description?: ReactNode;
};

/**
 * A checkbox with its label. Inside a form it submits `name=on` when ticked,
 * like a native one, and returns to its default when the form resets.
 */
export function Checkbox({ label, description, id, className, ...props }: CheckboxProps) {
  const generated = useId();
  const checkboxId = id ?? generated;
  const descriptionId = description ? `${checkboxId}-description` : undefined;
  return (
    <div className={cn("flex items-start gap-3 has-[[data-disabled]]:opacity-60", className)}>
      <CheckboxPrimitive.Root
        id={checkboxId}
        aria-describedby={descriptionId}
        className="mt-0.5 grid size-5 shrink-0 cursor-pointer place-items-center rounded-md border border-line-strong bg-surface text-on-agent shadow-control outline-hidden transition-colors duration-150 ease-standard focus-visible:ring-4 focus-visible:ring-agent-soft disabled:cursor-not-allowed data-[state=checked]:border-agent data-[state=checked]:bg-agent"
        {...props}
      >
        <CheckboxPrimitive.Indicator className="duration-150 data-[state=checked]:animate-in data-[state=checked]:zoom-in-50">
          <Check aria-hidden strokeWidth={3} className="size-3.5" />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <div className="grid gap-0.5">
        <label htmlFor={checkboxId} className="cursor-pointer text-sm leading-6 text-ink">
          {label}
        </label>
        {description && (
          <p id={descriptionId} className="text-xs text-ink-3">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
```

`src/components/ui/FileInput.tsx`:

```tsx
"use client";

import { Upload } from "lucide-react";
import { useRef, useState, type DragEvent, type RefObject } from "react";
import { cn } from "./cn";

export interface FileInputProps {
  id: string;
  name?: string;
  accept?: string;
  label: string;
  description?: string;
  disabled?: boolean;
  /** Called with the chosen or dropped file, or undefined when the choice is cleared. */
  onFile: (file: File | undefined) => void;
  /** For the owner to clear the input after using its file. */
  inputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * A drop zone around a visually hidden file input. It is a real input — a
 * click, the keyboard and a dropped file all reach it — so the file is in the
 * form’s `FormData` however it was chosen.
 */
export function FileInput({ id, name, accept, label, description, disabled = false, onFile, inputRef }: FileInputProps) {
  const localRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? localRef;
  const [dragging, setDragging] = useState(false);

  function onDragOver(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (!disabled) setDragging(true);
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    if (ref.current) ref.current.files = event.dataTransfer.files;
    onFile(event.dataTransfer.files[0]);
  }

  return (
    <label
      htmlFor={id}
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        "group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong bg-surface/60 px-6 py-8 text-center",
        "transition-colors duration-150 ease-standard hover:border-agent-line hover:bg-agent-soft/40",
        "has-[input:focus-visible]:border-agent has-[input:focus-visible]:ring-4 has-[input:focus-visible]:ring-agent-soft",
        dragging && "border-agent bg-agent-soft/60",
        disabled && "pointer-events-none opacity-60"
      )}
    >
      <span aria-hidden className="grid size-10 place-items-center rounded-full bg-agent-soft text-agent transition-transform duration-200 ease-standard group-hover:-translate-y-0.5">
        <Upload className="size-5" />
      </span>
      <span className="text-sm font-semibold text-ink">{label}</span>
      {description && <span className="text-xs text-ink-3">{description}</span>}
      <input
        ref={ref}
        id={id}
        name={name}
        type="file"
        accept={accept}
        disabled={disabled}
        className="sr-only"
        onChange={(event) => onFile(event.currentTarget.files?.[0])}
      />
    </label>
  );
}
```

`src/components/ui/FormMessage.tsx`:

```tsx
import { CircleAlert, CircleCheck, Info, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

type Tone = "neutral" | "success" | "error";

const TONE: Record<Tone, { icon: LucideIcon; className: string }> = {
  neutral: { icon: Info, className: "text-ink-2" },
  success: { icon: CircleCheck, className: "text-proof" },
  error: { icon: CircleAlert, className: "text-refused" },
};

/**
 * Where a form says how its last submission went. The live region is in the
 * page from the start — empty until there is something to say — so a screen
 * reader announces each new message.
 */
export function FormMessage({ tone = "neutral", children, className }: { tone?: Tone; children?: ReactNode; className?: string }) {
  const { icon: Icon, className: toneClass } = TONE[tone];
  return (
    <p role="status" aria-live="polite" className={cn("flex min-h-5 items-start gap-1.5 text-sm", toneClass, className)}>
      {children ? (
        <>
          <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{children}</span>
        </>
      ) : null}
    </p>
  );
}
```

`src/components/ui/useActionForm.ts`:

```ts
"use client";

import { startTransition, useActionState, useEffect, useRef, type FormEvent } from "react";
import { toast } from "sonner";

export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface ActionFormOptions {
  /** Clears every field — Radix selects and checkboxes too — once the action succeeds. */
  resetOnSuccess?: boolean;
  /** Raises a toast with the result’s message once the action succeeds. */
  toastOnSuccess?: boolean;
}

/**
 * A form wired to a server action that keeps what the person typed when the
 * action refuses it.
 *
 * React resets a form after every submission through `<form action>`,
 * whatever the action returns — so a validation error used to wipe the very
 * fields it was about. Submitting from `onSubmit` inside a transition leaves
 * the fields alone; they are cleared only on success, and only when asked.
 * The `action` prop stays, so React still refuses a submission made before
 * the page hydrated instead of posting it to the page.
 *
 * `useFormStatus` keeps working inside the form: React marks the form pending
 * for as long as the transition started in `onSubmit` runs.
 */
export function useActionForm<State extends ActionResult>(
  action: (previous: State, formData: FormData) => Promise<State>,
  initial: State,
  { resetOnSuccess = false, toastOnSuccess = false }: ActionFormOptions = {}
) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, dispatch, pending] = useActionState(action, initial);
  // The result last acted on. Each submission produces a new state object, so
  // a result is reset-and-toasted once, however often the form re-renders.
  const handled = useRef(state);

  useEffect(() => {
    if (state === handled.current) return;
    handled.current = state;
    if (!state.ok) return;
    if (resetOnSuccess) formRef.current?.reset();
    if (toastOnSuccess && state.message) toast.success(state.message);
  }, [state, resetOnSuccess, toastOnSuccess]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The pressed button's name and value belong in the submission, as they would natively.
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const formData = new FormData(event.currentTarget, submitter);
    startTransition(() => dispatch(formData));
  }

  return { state, pending, formProps: { ref: formRef, action: dispatch, onSubmit } };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/ui-forms.test.tsx`
Expected: PASS, 9 tests.

- [ ] **Step 6: Verify and commit**

```bash
npm run verify
git add src/components/ui/overlay.ts src/components/ui/Field.tsx src/components/ui/Input.tsx src/components/ui/Select.tsx src/components/ui/Checkbox.tsx src/components/ui/FileInput.tsx src/components/ui/FormMessage.tsx src/components/ui/useActionForm.ts tests/ui-forms.test.tsx
git commit -m "feat(ui): form primitives and a form hook that keeps refused input

Field wires its label, description and error to the control inside it.
Input, Textarea, a Radix Select and Checkbox that submit through FormData,
a drop-zone FileInput and a FormMessage live region. useActionForm submits
inside a transition, so a refused submission no longer clears the form,
and clears it on success when asked.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Overlays

**Files:**
- Create: `src/components/ui/Tooltip.tsx`, `Dialog.tsx`, `ConfirmDialog.tsx`, `Sheet.tsx`, `DropdownMenu.tsx`, `Command.tsx` (under `src/components/ui/`)
- Test: `tests/ui-overlays.test.tsx`

**Interfaces:**
- Consumes: `cn` (Task 1); `Button` (Task 2); `Kbd` (Task 3); `overlay.ts` classes (Task 4).
- Produces (all client components):
  - `TooltipProvider` (Radix Provider), `Tooltip({ content: ReactNode; side?: "top" | "right" | "bottom" | "left"; children: ReactElement })`.
  - `Dialog`, `DialogTrigger`, `DialogClose` (Radix), `DialogContent({ title: ReactNode; description?: ReactNode; hideHeader?: boolean; showClose?: boolean; className?; children })`, `DialogFooter`.
  - `ConfirmDialog({ trigger: ReactElement; title: ReactNode; description: ReactNode; confirmLabel: string; cancelLabel?: string; tone?: "danger" | "primary"; formId?: string; onConfirm?: () => void })`.
  - `Sheet`, `SheetTrigger`, `SheetClose` (Radix Dialog), `SheetContent({ side?: "left" | "right" | "top" | "bottom"; title: ReactNode; description?; hideHeader?; showClose?; className?; children })`.
  - `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuGroup` (Radix), `DropdownMenuContent`, `DropdownMenuItem({ tone?: "default" | "danger", … })`, `DropdownMenuLabel`, `DropdownMenuSeparator`, `DropdownMenuShortcut`.
  - `Command`, `CommandDialog({ open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children })`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`, `CommandSeparator`, `CommandShortcut`.

- [ ] **Step 1: Write the failing tests**

`tests/ui-overlays.test.tsx`:

```tsx
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/Button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/Command";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/Sheet";
import { Tooltip, TooltipProvider } from "@/components/ui/Tooltip";

const html = (node: ReactElement) => renderToStaticMarkup(node);

describe("ConfirmDialog", () => {
  it("renders only its trigger until opened, announced as opening a dialog", () => {
    const markup = html(
      <ConfirmDialog trigger={<Button>Remove</Button>} title="Remove this member?" description="They lose access." confirmLabel="Remove member" formId="remove" />
    );
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Remove this member?");
  });
});

describe("DropdownMenu", () => {
  it("marks its trigger as opening a menu", () => {
    const markup = html(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary">Workspaces</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Founding</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).not.toContain("Founding");
  });
});

describe("Sheet", () => {
  it("marks its trigger as opening a dialog", () => {
    const markup = html(
      <Sheet>
        <SheetTrigger asChild>
          <Button size="icon" aria-label="Open navigation">
            <svg />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" title="Navigation">
          Links
        </SheetContent>
      </Sheet>
    );
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-label="Open navigation"');
  });
});

describe("Tooltip", () => {
  it("wraps its trigger and renders the tip only on demand", () => {
    const markup = html(
      <TooltipProvider>
        <Tooltip content="Copy the transaction hash">
          <Button size="icon-sm" aria-label="Copy">
            <svg />
          </Button>
        </Tooltip>
      </TooltipProvider>
    );
    expect(markup).toContain('aria-label="Copy"');
    expect(markup).not.toContain("Copy the transaction hash");
  });
});

describe("Command", () => {
  it("renders a searchable list of its items", () => {
    const markup = html(
      <Command label="Jump to">
        <CommandInput placeholder="Search" />
        <CommandList>
          <CommandGroup heading="Sections">
            <CommandItem>Treasury</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    );
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain("Treasury");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/ui-overlays.test.tsx`
Expected: FAIL — `Cannot find module '@/components/ui/Command'`.

- [ ] **Step 3: Write the overlays**

`src/components/ui/Tooltip.tsx`:

```tsx
"use client";

import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn";

/** One per app, in the root layout: it lets a second tooltip open without the first one’s delay. */
export const TooltipProvider = TooltipPrimitive.Provider;

// Radix marks an open tooltip `delayed-open` or `instant-open`, never `open`, so it animates in on mount.
const TOOLTIP_MOTION = [
  "animate-in fade-in-0 zoom-in-95 duration-150 ease-emphasized",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
  "data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1",
].join(" ");

/**
 * A short label for a control with no visible text — an icon button, a
 * truncated value. Never the only place something essential is said: touch
 * screens cannot hover.
 */
export function Tooltip({ content, side = "top", children }: { content: ReactNode; side?: "top" | "right" | "bottom" | "left"; children: ReactElement }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className={cn("z-50 max-w-xs rounded-lg bg-ink px-2.5 py-1.5 text-xs font-medium text-ground shadow-overlay", TOOLTIP_MOTION)}
        >
          {content}
          <TooltipPrimitive.Arrow width={10} height={5} className="fill-ink" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
```

`src/components/ui/Dialog.tsx`:

```tsx
"use client";

import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "./Button";
import { cn } from "./cn";
import { dialogMotion, dialogPanel, overlayBackdrop } from "./overlay";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export type DialogContentProps = Omit<ComponentProps<typeof DialogPrimitive.Content>, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  /** Keeps the title and description for screen readers only. */
  hideHeader?: boolean;
  showClose?: boolean;
};

/**
 * A modal panel in the middle of the screen. The title is required: it is what
 * a screen reader announces as the dialog opens.
 */
export function DialogContent({ title, description, hideHeader = false, showClose = true, className, children, ...props }: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlayBackdrop} />
      <DialogPrimitive.Content
        className={cn(dialogPanel, dialogMotion, "grid max-w-lg gap-5", className)}
        {...(description ? {} : { "aria-describedby": undefined })}
        {...props}
      >
        <div className={cn("space-y-1.5", showClose && "pr-10", hideHeader && "sr-only")}>
          <DialogPrimitive.Title className="text-lg font-semibold tracking-tight text-ink">{title}</DialogPrimitive.Title>
          {description && <DialogPrimitive.Description className="text-sm leading-relaxed text-ink-2">{description}</DialogPrimitive.Description>}
        </div>
        {children}
        {showClose && (
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Close" className="absolute right-3 top-3">
              <X />
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}
```

`src/components/ui/ConfirmDialog.tsx`:

```tsx
"use client";

import { TriangleAlert } from "lucide-react";
import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import type { ReactElement, ReactNode } from "react";
import { Button } from "./Button";
import { cn } from "./cn";
import { dialogMotion, dialogPanel, overlayBackdrop } from "./overlay";

export interface ConfirmDialogProps {
  /** The control that opens the dialog — usually a Button. */
  trigger: ReactElement;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  /**
   * The id of the form the confirm button submits. The dialog is rendered
   * outside that form, so the button names it with the `form` attribute.
   */
  formId?: string;
  /** For a confirmation that is not a form submission. */
  onConfirm?: () => void;
}

/**
 * Asks before something that cannot be taken back. A click outside does not
 * close it — the person chooses. Confirming closes it at once; the control
 * that opened it shows the work in progress.
 */
export function ConfirmDialog({ trigger, title, description, confirmLabel, cancelLabel = "Cancel", tone = "danger", formId, onConfirm }: ConfirmDialogProps) {
  const danger = tone === "danger";
  return (
    <AlertDialogPrimitive.Root>
      <AlertDialogPrimitive.Trigger asChild>{trigger}</AlertDialogPrimitive.Trigger>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className={overlayBackdrop} />
        <AlertDialogPrimitive.Content className={cn(dialogPanel, dialogMotion, "max-w-md")}>
          <div className="flex gap-4">
            {danger && (
              <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-refused-soft text-refused">
                <TriangleAlert className="size-5" />
              </span>
            )}
            <div className="min-w-0 space-y-1.5">
              <AlertDialogPrimitive.Title className="text-base font-semibold text-ink">{title}</AlertDialogPrimitive.Title>
              <AlertDialogPrimitive.Description className="text-sm leading-relaxed text-ink-2">{description}</AlertDialogPrimitive.Description>
            </div>
          </div>
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialogPrimitive.Cancel asChild>
              <Button variant="secondary">{cancelLabel}</Button>
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action asChild>
              <Button type={formId ? "submit" : "button"} form={formId} variant={danger ? "danger-solid" : "primary"} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
```

`src/components/ui/Sheet.tsx`:

```tsx
"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "./Button";
import { cn } from "./cn";
import { overlayBackdrop } from "./overlay";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

const sheetVariants = cva(
  [
    "fixed z-50 flex flex-col bg-surface text-ink shadow-overlay outline-hidden",
    "data-[state=open]:animate-in data-[state=closed]:animate-out duration-300 ease-emphasized data-[state=closed]:duration-200 data-[state=closed]:ease-exit",
  ],
  {
    variants: {
      side: {
        left: "inset-y-0 left-0 h-dvh w-[min(20rem,calc(100vw-3.5rem))] border-r border-line data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left",
        right: "inset-y-0 right-0 h-dvh w-[min(24rem,calc(100vw-3.5rem))] border-l border-line data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
        top: "inset-x-0 top-0 max-h-[85dvh] border-b border-line data-[state=open]:slide-in-from-top data-[state=closed]:slide-out-to-top",
        bottom: "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl border-t border-line data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
      },
    },
    defaultVariants: { side: "right" },
  }
);

export type SheetContentProps = Omit<ComponentProps<typeof DialogPrimitive.Content>, "title"> &
  VariantProps<typeof sheetVariants> & {
    title: ReactNode;
    description?: ReactNode;
    /** Keeps the title and description for screen readers only. */
    hideHeader?: boolean;
    showClose?: boolean;
  };

/**
 * A panel that slides in from an edge, over a dimmed page: the navigation
 * drawer, the landing menu. Radix traps focus inside, closes it on Escape or a
 * click outside, and returns focus to whatever opened it.
 */
export function SheetContent({ side, title, description, hideHeader = false, showClose = true, className, children, ...props }: SheetContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlayBackdrop} />
      <DialogPrimitive.Content className={cn(sheetVariants({ side }), className)} {...(description ? {} : { "aria-describedby": undefined })} {...props}>
        <div className={cn("shrink-0 space-y-1 border-b border-line px-5 py-4", showClose && "pr-14", hideHeader && "sr-only")}>
          <DialogPrimitive.Title className="text-base font-semibold tracking-tight text-ink">{title}</DialogPrimitive.Title>
          {description && <DialogPrimitive.Description className="text-sm text-ink-2">{description}</DialogPrimitive.Description>}
        </div>
        {children}
        {showClose && (
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="icon" aria-label="Close" className="absolute right-2 top-2.5">
              <X />
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
```

`src/components/ui/DropdownMenu.tsx`:

```tsx
"use client";

import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "./cn";
import { menuItem, overlayMotion, overlaySurface } from "./overlay";

/**
 * A menu of actions or places. Arrow keys, typeahead and Escape come from
 * Radix. An item can be a link: `<DropdownMenuItem asChild><Link …/></DropdownMenuItem>`.
 */
export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;

export function DropdownMenuContent({ className, sideOffset = 6, align = "start", ...props }: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cn(
          overlaySurface,
          overlayMotion,
          "max-h-(--radix-dropdown-menu-content-available-height) min-w-56 origin-(--radix-dropdown-menu-content-transform-origin) overflow-y-auto p-1.5",
          className
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({ className, tone = "default", ...props }: ComponentProps<typeof DropdownMenuPrimitive.Item> & { tone?: "default" | "danger" }) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(menuItem, tone === "danger" && "text-refused data-[highlighted]:bg-refused-soft data-[highlighted]:text-refused [&>svg]:text-refused", className)}
      {...props}
    />
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return <DropdownMenuPrimitive.Label className={cn("px-2.5 pb-1 pt-1.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-ink-3", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator className={cn("-mx-1.5 my-1.5 h-px bg-line", className)} {...props} />;
}

export function DropdownMenuShortcut({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("ml-auto font-mono text-[0.6875rem] tracking-wide text-ink-3", className)} {...props} />;
}
```

`src/components/ui/Command.tsx`:

```tsx
"use client";

import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";
import { Dialog, DialogContent } from "./Dialog";
import { Kbd } from "./Kbd";
import { menuItemBase } from "./overlay";

/** A filterable list driven by the keyboard, from cmdk. */
export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return <CommandPrimitive className={cn("flex w-full flex-col overflow-hidden text-ink", className)} {...props} />;
}

/**
 * The command palette: a dialog near the top of the screen with a search field
 * and a list beneath it. Escape or a click outside closes it.
 */
export function CommandDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        description={description}
        hideHeader
        showClose={false}
        className="top-[12dvh] max-w-xl translate-y-0 gap-0 overflow-hidden p-0 sm:top-[18dvh] sm:p-0"
      >
        <Command label={title} loop>
          {children}
        </Command>
        <div className="hidden items-center gap-3 border-t border-line bg-ground/60 px-4 py-2 text-[0.6875rem] text-ink-3 sm:flex">
          <span className="inline-flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> to move
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>↵</Kbd> to open
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>esc</Kbd> to close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CommandInput({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-3 border-b border-line px-4">
      <Search aria-hidden className="size-4 shrink-0 text-ink-3" />
      <CommandPrimitive.Input className={cn("h-13 min-w-0 flex-1 bg-transparent text-base text-ink outline-hidden placeholder:text-ink-3 sm:text-sm", className)} {...props} />
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List className={cn("max-h-[min(22rem,60dvh)] scroll-py-1.5 overflow-y-auto overscroll-contain p-1.5", className)} {...props} />;
}

export function CommandEmpty({ className, ...props }: ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className={cn("px-4 py-10 text-center text-sm text-ink-3", className)} {...props} />;
}

export function CommandGroup({ className, ...props }: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[0.625rem] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-group-heading]]:text-ink-3",
        className
      )}
      {...props}
    />
  );
}

/** cmdk marks the row under the pointer or the arrow keys `data-selected`. */
export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        menuItemBase,
        "data-[selected=true]:bg-raised/80 data-[selected=true]:text-ink data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        className
      )}
      {...props}
    />
  );
}

export function CommandSeparator({ className, ...props }: ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator className={cn("-mx-1.5 my-1.5 h-px bg-line", className)} {...props} />;
}

export function CommandShortcut({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("ml-auto font-mono text-[0.6875rem] tracking-wide text-ink-3", className)} {...props} />;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/ui-overlays.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Verify and commit**

```bash
npm run verify
git add src/components/ui/Tooltip.tsx src/components/ui/Dialog.tsx src/components/ui/ConfirmDialog.tsx src/components/ui/Sheet.tsx src/components/ui/DropdownMenu.tsx src/components/ui/Command.tsx tests/ui-overlays.test.tsx
git commit -m "feat(ui): tooltip, dialog, confirmation, sheet, menu and command palette

Radix overlays sharing one surface, backdrop and motion: each traps and
returns focus and closes on Escape. ConfirmDialog asks before something
irreversible and submits its form through the form attribute; the command
palette is cmdk inside the Dialog.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Motion, feedback and the root layout

**Files:**
- Create: `src/components/ui/MotionProvider.tsx`, `motion-features.ts`, `Tabs.tsx`, `Toaster.tsx`, `CopyButton.tsx`, `Reveal.tsx` (under `src/components/ui/`)
- Modify: `src/app/layout.tsx`
- Test: `tests/ui-motion.test.tsx`

**Interfaces:**
- Consumes: `cn`, `MOTION`, `THEME_COLOR` (Task 1); `Button` (Task 2); `Spinner` (Task 2); `Tooltip`, `TooltipProvider` (Task 5).
- Produces:
  - `MotionProvider({ children })` — `LazyMotion` (async `domMax`, `strict`) + `MotionConfig reducedMotion="user"`. Use `m.*` from `motion/react` inside it.
  - `Tabs({ defaultValue: string; onValueChange?; className?; children })`, `TabsList`, `TabsTrigger({ value, … })`, `TabsContent({ value, … })`.
  - `Toaster()` and `toast` (re-exported from Sonner) from `@/components/ui/Toaster`.
  - `CopyButton({ value: string; label?: string; children?: ReactNode; variant?; size?; className? })`.
  - `Reveal({ children; delay?: number (ms); className? })`.
  - Root layout renders `TooltipProvider` around the app and one `<Toaster />`; `viewport.themeColor` is `THEME_COLOR`.

- [ ] **Step 1: Write the failing tests**

`tests/ui-motion.test.tsx`:

```tsx
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CopyButton } from "@/components/ui/CopyButton";
import { Reveal } from "@/components/ui/Reveal";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { TooltipProvider } from "@/components/ui/Tooltip";

const html = (node: ReactElement) => renderToStaticMarkup(node);

describe("Reveal", () => {
  it("hides nothing in the server’s HTML", () => {
    const markup = html(
      <Reveal delay={120}>
        <p>Measured</p>
      </Reveal>
    );
    expect(markup).toContain("<p>Measured</p>");
    expect(markup).not.toContain("data-reveal");
    expect(markup).not.toContain("opacity");
  });
});

describe("Tabs", () => {
  const tabs = (
    <Tabs defaultValue="manual">
      <TabsList aria-label="Invoice intake">
        <TabsTrigger value="manual">Enter one invoice</TabsTrigger>
        <TabsTrigger value="csv">Import CSV</TabsTrigger>
      </TabsList>
      <TabsContent value="manual">Manual form</TabsContent>
      <TabsContent value="csv">CSV form</TabsContent>
    </Tabs>
  );

  it("renders the default tab’s panel on the server", () => {
    const markup = html(tabs);
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain("Manual form");
    expect(markup).not.toContain("CSV form");
  });

  it("marks exactly one tab as selected", () => {
    expect(html(tabs).match(/data-tab-indicator/g)).toHaveLength(1);
  });
});

describe("CopyButton", () => {
  it("names itself for screen readers when it is only an icon", () => {
    const markup = html(
      <TooltipProvider>
        <CopyButton value="0xabc" label="Copy transaction hash" />
      </TooltipProvider>
    );
    expect(markup).toContain('aria-label="Copy transaction hash"');
  });

  it("shows its text when it has some", () => {
    expect(html(<CopyButton value="https://example.com/invite">Copy link</CopyButton>)).toContain("Copy link");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/ui-motion.test.tsx`
Expected: FAIL — `Cannot find module '@/components/ui/CopyButton'`.

- [ ] **Step 3: Write the components**

`src/components/ui/motion-features.ts`:

```ts
import { domMax } from "motion/react";

/** Loaded on demand by MotionProvider. Layout animations need `domMax`, not the smaller `domAnimation`. */
export default domMax;
```

`src/components/ui/MotionProvider.tsx`:

```tsx
"use client";

import { LazyMotion, MotionConfig } from "motion/react";
import type { ReactNode } from "react";

const loadFeatures = () => import("./motion-features").then((module) => module.default);

/**
 * Motion for the parts of the app that animate layout and presence — the
 * workspace frame and /design, not every page. Its features load after the
 * page is interactive; `strict` keeps the heavier `motion.*` components out,
 * so use `m.*` inside. Under reduced motion Motion drops transforms and keeps
 * opacity.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
```

`src/components/ui/Tabs.tsx`:

```tsx
"use client";

import { LayoutGroup, m } from "motion/react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { createContext, useContext, useId, useState, type ComponentProps } from "react";
import { cn } from "./cn";
import { MOTION } from "./tokens";

const ActiveTab = createContext<string | undefined>(undefined);

export type TabsProps = Omit<ComponentProps<typeof TabsPrimitive.Root>, "value" | "defaultValue" | "onValueChange"> & {
  defaultValue: string;
  onValueChange?: (value: string) => void;
};

/**
 * Tabs whose selected marker glides to the tab chosen next. Two sets of tabs
 * on one page never trade markers: each has its own layout group.
 */
export function Tabs({ defaultValue, onValueChange, className, children, ...props }: TabsProps) {
  const [value, setValue] = useState(defaultValue);
  const group = useId();
  return (
    <ActiveTab.Provider value={value}>
      <LayoutGroup id={group}>
        <TabsPrimitive.Root
          value={value}
          onValueChange={(next) => {
            setValue(next);
            onValueChange?.(next);
          }}
          className={cn("flex flex-col gap-4", className)}
          {...props}
        >
          {children}
        </TabsPrimitive.Root>
      </LayoutGroup>
    </ActiveTab.Provider>
  );
}

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn("inline-flex h-11 w-full items-stretch gap-1 rounded-xl border border-line bg-raised/60 p-1 sm:h-10 sm:w-fit", className)} {...props} />;
}

export function TabsTrigger({ value, className, children, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  const active = useContext(ActiveTab) === value;
  return (
    <TabsPrimitive.Trigger
      value={value}
      className={cn(
        "relative inline-flex flex-1 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-medium text-ink-2 outline-hidden transition-colors duration-150 hover:text-ink focus-visible:ring-4 focus-visible:ring-agent-soft data-[state=active]:text-ink sm:flex-none [&_svg]:size-4",
        className
      )}
      {...props}
    >
      {active && (
        <m.span data-tab-indicator="" aria-hidden layoutId="tab-indicator" transition={MOTION.spring} className="absolute inset-0 rounded-lg border border-line bg-surface shadow-control" />
      )}
      <span className="relative inline-flex items-center gap-2">{children}</span>
    </TabsPrimitive.Trigger>
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("outline-hidden duration-200 ease-standard data-[state=active]:animate-in data-[state=active]:fade-in-0", className)} {...props} />;
}
```

`src/components/ui/Toaster.tsx`:

```tsx
"use client";

import { CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import { Toaster as Sonner } from "sonner";
import { Spinner } from "./Spinner";

export { toast } from "sonner";

/**
 * Where confirmations appear: bottom right, full width on a phone. Toasts
 * confirm what went right; an action’s error stays in the form that caused it.
 */
export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      gap={10}
      offset={20}
      mobileOffset={12}
      containerAriaLabel="Notifications"
      icons={{
        success: <CircleCheck className="size-[1.125rem] text-proof" />,
        error: <CircleX className="size-[1.125rem] text-refused" />,
        info: <Info className="size-[1.125rem] text-agent" />,
        warning: <TriangleAlert className="size-[1.125rem] text-held" />,
        loading: <Spinner className="size-[1.125rem] text-agent" />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: "flex w-(--width) items-start gap-3 rounded-xl border border-line bg-surface p-4 font-sans text-sm text-ink shadow-overlay",
          content: "min-w-0 flex-1",
          title: "font-semibold leading-5 text-ink",
          description: "mt-0.5 leading-5 text-ink-2",
          icon: "mt-px flex size-5 shrink-0 items-center justify-center",
          actionButton: "ml-auto h-8 shrink-0 cursor-pointer rounded-lg bg-agent px-3 text-xs font-semibold text-on-agent transition-colors hover:bg-agent/90",
          cancelButton: "h-8 shrink-0 cursor-pointer rounded-lg px-3 text-xs font-medium text-ink-2 transition-colors hover:bg-raised",
        },
      }}
    />
  );
}
```

`src/components/ui/CopyButton.tsx`:

```tsx
"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button, type ButtonProps } from "./Button";
import { Tooltip } from "./Tooltip";

export type CopyButtonProps = Omit<ButtonProps, "onClick" | "asChild" | "children" | "icon"> & {
  value: string;
  /** What is copied, for screen readers and the tooltip: “Copy transaction hash”. */
  label?: string;
  /** Visible text. Without it the button is an icon with a tooltip. */
  children?: ReactNode;
};

/** Copies `value`, says so for two seconds, and confirms with a toast. */
export function CopyButton({ value, label = "Copy", children, variant = "ghost", size, ...props }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast("Copied to the clipboard");
    } catch {
      // The text is still on screen to copy by hand; there is no form to put this error in.
      toast.error("Could not copy. Select the text and copy it instead.");
    }
  }

  const icon = copied ? <Check className="text-proof" /> : <Copy />;

  if (children) {
    return (
      <Button variant={variant} size={size ?? "sm"} icon={icon} onClick={copy} {...props}>
        {copied ? "Copied" : children}
      </Button>
    );
  }

  return (
    <Tooltip content={copied ? "Copied" : label}>
      <Button variant={variant} size={size ?? "icon-sm"} aria-label={label} onClick={copy} {...props}>
        {icon}
      </Button>
    </Tooltip>
  );
}
```

`src/components/ui/Reveal.tsx`:

```tsx
"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

/**
 * Fades and lifts an element into view the first time it scrolls in. Nothing
 * is hidden in the server’s HTML, nothing already on screen when the page
 * hydrates is touched, and nothing moves under reduced motion — so a page
 * whose script never runs still shows everything. The transition is CSS
 * (`[data-reveal]` in globals.css); `delay` staggers siblings, in ms.
 */
export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (element.getBoundingClientRect().top < window.innerHeight) return;
    element.dataset.reveal = "hidden";
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        element.dataset.reveal = "shown";
        observer.disconnect();
      },
      { rootMargin: "0px 0px -8% 0px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={className} style={delay ? ({ "--reveal-delay": `${delay}ms` } as CSSProperties) : undefined}>
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Wire the root layout**

In `src/app/layout.tsx`:

1. Add imports:

```tsx
import { Toaster } from "@/components/ui/Toaster";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { THEME_COLOR } from "@/components/ui/tokens";
```

2. Replace `themeColor: "#fffefa",` with `themeColor: THEME_COLOR,`.
3. Replace `{children}` inside `<body>` (after the skip link) with:

```tsx
        <TooltipProvider delayDuration={300} skipDelayDuration={150}>
          {children}
        </TooltipProvider>
        <Toaster />
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/ui-motion.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 6: Verify, build and commit**

```bash
npm run verify
NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder SUPABASE_SERVICE_ROLE_KEY=ci-placeholder npm run build
git add src/components/ui/MotionProvider.tsx src/components/ui/motion-features.ts src/components/ui/Tabs.tsx src/components/ui/Toaster.tsx src/components/ui/CopyButton.tsx src/components/ui/Reveal.tsx src/app/layout.tsx tests/ui-motion.test.tsx
git commit -m "feat(ui): tabs, toasts, copy, reveal, and the root providers

MotionProvider loads Motion's layout features on demand; Tabs' selected
marker glides between tabs. Sonner toasts in the brand's style, a
CopyButton, and a Reveal that never hides content before scripts run.
The root layout adds the tooltip provider and the toaster and takes its
theme colour from the tokens.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: verify and build both succeed.

---

### Task 7: The `/design` page

**Files:**
- Create: `src/app/design/page.tsx`, `src/app/design/Demos.tsx`
- Modify: `README.md` (the source-layout list)

**Interfaces:**
- Consumes: every primitive from Tasks 1–6.
- Produces: `/design` in development (`notFound()` in production); client demos `FormLab`, `OverlayDemo`, `FeedbackDemo`, `TabsDemo` exported from `src/app/design/Demos.tsx`.

- [ ] **Step 1: Write the client demos**

`src/app/design/Demos.tsx`:

```tsx
"use client";

import { AnimatePresence, m } from "motion/react";
import {
  ChartLine,
  Check,
  ChevronsUpDown,
  FileText,
  Flag,
  Landmark,
  LogOut,
  Play,
  Plus,
  ScrollText,
  ShieldCheck,
  UserCog,
  Users,
} from "lucide-react";
import { useState } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/Command";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyButton } from "@/components/ui/CopyButton";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { Field } from "@/components/ui/Field";
import { FileInput } from "@/components/ui/FileInput";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input, Textarea } from "@/components/ui/Input";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/Sheet";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { toast } from "@/components/ui/Toaster";
import { MOTION } from "@/components/ui/tokens";
import { useActionForm, type ActionResult } from "@/components/ui/useActionForm";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface LabState extends ActionResult {
  entries: Array<[string, string]>;
}

const LAB_INITIAL: LabState = { ok: false, message: "", entries: [] };

/** Stands in for a server action: it echoes what arrived, and refuses an amount that is not above zero. */
async function echo(_previous: LabState, formData: FormData): Promise<LabState> {
  await wait(700);
  const entries = [...formData.entries()].map(([key, value]): [string, string] => [key, typeof value === "string" ? value : `${value.name} · ${value.size} bytes`]);
  if (!(Number(formData.get("amount")) > 0)) {
    return { ok: false, message: "Amount must be above zero. Everything you typed is still in the form.", entries };
  }
  return { ok: true, message: `The action received ${entries.length} fields.`, entries };
}

/**
 * The check that every control reaches a server action: Radix’s select and
 * checkbox, the pressed button’s name and value, a chosen or dropped file. A
 * refusal must keep the fields; a success clears them.
 */
export function FormLab() {
  const { state, formProps } = useActionForm(echo, LAB_INITIAL, { resetOnSuccess: true, toastOnSuccess: true });
  const refused = !state.ok && state.message !== "";
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <form {...formProps} className="grid gap-4 rounded-2xl border border-line bg-surface p-5 shadow-surface sm:grid-cols-2 sm:p-6">
        <Field id="lab-name" label="Legal or trading name">
          <Input name="name" required autoComplete="organization" />
        </Field>
        <Field id="lab-role" label="Role">
          <Select name="role" defaultValue="vendor">
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="vendor">Vendor</SelectItem>
              <SelectItem value="contractor">Contractor</SelectItem>
              <SelectItem value="client">Client</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field id="lab-amount" label="Amount (USDC)" description="Enter 0 to see a refusal keep your input" error={refused ? "Enter an amount above zero" : undefined}>
          <Input name="amount" inputMode="decimal" placeholder="1250.00" />
        </Field>
        <Field id="lab-due" label="Due date">
          <Input name="dueDate" type="date" />
        </Field>
        <Field id="lab-memo" label="Memo" optional className="sm:col-span-2">
          <Textarea name="memo" rows={3} />
        </Field>
        <Checkbox name="goodsReceived" label="Goods or services received" description="Submits “on” when ticked, like a native checkbox" className="sm:col-span-2" />
        <div className="sm:col-span-2">
          <FileInput id="lab-file" name="attachment" accept=".csv,text/csv" label="Choose a CSV file, or drop one here" description="Nothing is uploaded until you submit" onFile={() => {}} />
        </div>
        <div className="flex flex-col gap-3 sm:col-span-2 sm:flex-row sm:items-center sm:justify-between">
          <FormMessage tone={state.message ? (state.ok ? "success" : "error") : "neutral"}>{state.message}</FormMessage>
          <div className="flex shrink-0 gap-2">
            <SubmitButton name="intent" value="draft" variant="secondary" pendingLabel="Saving…">
              Save draft
            </SubmitButton>
            <SubmitButton name="intent" value="submit" pendingLabel="Submitting…">
              Submit
            </SubmitButton>
          </div>
        </div>
      </form>
      <Card>
        <CardHeader>
          <CardTitle>What the action received</CardTitle>
          <CardDescription>The last submission’s FormData, field by field.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 sm:px-0">
          {state.entries.length === 0 ? (
            <p className="px-5 text-sm text-ink-3 sm:px-6">Nothing submitted yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.entries.map(([key, value], index) => (
                  <TableRow key={`${key}-${index}`}>
                    <TableCell className="font-mono text-xs text-ink-2">{key}</TableCell>
                    <TableCell className="break-all">{value || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const PEOPLE = ["ada@example.com", "grace@example.com", "alan@example.com"];

/** A member list whose rows ask before removal and fade out once removed. */
function RemoveDemo() {
  const [people, setPeople] = useState(PEOPLE);
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-line rounded-xl border border-line">
        <AnimatePresence initial={false}>
          {people.map((email) => (
            <m.li
              key={email}
              layout
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: MOTION.duration.exit, ease: MOTION.ease.exit }}
              className="flex items-center gap-3 px-3 py-2.5"
            >
              <PersonRow email={email} onRemoved={() => setPeople((list) => list.filter((person) => person !== email))} />
            </m.li>
          ))}
        </AnimatePresence>
      </ul>
      {people.length < PEOPLE.length && (
        <Button variant="link" onClick={() => setPeople(PEOPLE)}>
          Bring them back
        </Button>
      )}
    </div>
  );
}

const REMOVE_INITIAL: ActionResult = { ok: false, message: "" };

function PersonRow({ email, onRemoved }: { email: string; onRemoved: () => void }) {
  const formId = `remove-${email.replace(/[^a-z]/g, "")}`;
  const { pending, formProps } = useActionForm(
    async (_previous: ActionResult, formData: FormData): Promise<ActionResult> => {
      await wait(700);
      onRemoved();
      return { ok: true, message: `${String(formData.get("email"))} was removed.` };
    },
    REMOVE_INITIAL,
    { toastOnSuccess: true }
  );
  return (
    <form id={formId} {...formProps} className="flex min-w-0 flex-1 items-center gap-3">
      <input type="hidden" name="email" value={email} />
      <Avatar name={email} size="sm" />
      <span className="min-w-0 flex-1 truncate text-sm">{email}</span>
      <ConfirmDialog
        formId={formId}
        trigger={
          <Button variant="danger" size="sm" loading={pending}>
            Remove
          </Button>
        }
        title={`Remove ${email}?`}
        description="They lose access to this workspace at once. You can invite them again later."
        confirmLabel="Remove member"
      />
    </form>
  );
}

const SECTIONS = [
  { label: "Treasury", icon: Landmark, shortcut: "G T" },
  { label: "Insights", icon: ChartLine, shortcut: "G I" },
  { label: "AP / AR", icon: FileText, shortcut: "G P" },
  { label: "Counterparties", icon: Users, shortcut: "G C" },
  { label: "Contractors", icon: Flag, shortcut: "G K" },
  { label: "Compliance", icon: ShieldCheck, shortcut: "G S" },
  { label: "Audit log", icon: ScrollText, shortcut: "G A" },
  { label: "Members", icon: UserCog, shortcut: "G M" },
] as const;

export function OverlayDemo() {
  const [paletteOpen, setPaletteOpen] = useState(false);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Dialog</CardTitle>
          <CardDescription>A modal panel with a required title. Escape, the close button or a click outside closes it.</CardDescription>
        </CardHeader>
        <CardContent>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="secondary" icon={<Plus />}>
                Add a counterparty
              </Button>
            </DialogTrigger>
            <DialogContent title="Add a counterparty" description="Screening runs as soon as it is saved.">
              <Field id="dialog-name" label="Legal or trading name">
                <Input name="name" autoComplete="organization" />
              </Field>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="secondary">Cancel</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button>Add and screen</Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Confirmation, then presence</CardTitle>
          <CardDescription>Removal asks first; a removed row fades out and the list closes the gap.</CardDescription>
        </CardHeader>
        <CardContent>
          <RemoveDemo />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sheet</CardTitle>
          <CardDescription>A panel from any edge — the navigation drawer is the left one.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {(["left", "right", "top", "bottom"] as const).map((side) => (
            <Sheet key={side}>
              <SheetTrigger asChild>
                <Button variant="secondary" size="sm" className="capitalize">
                  {side}
                </Button>
              </SheetTrigger>
              <SheetContent side={side} title={`A ${side} sheet`} description="Focus stays inside until it closes.">
                <div className="space-y-3 p-5 text-sm text-ink-2">
                  <p>Escape, the close button or a click on the dimmed page closes it, and focus returns to the button that opened it.</p>
                </div>
              </SheetContent>
            </Sheet>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Dropdown menu</CardTitle>
          <CardDescription>Arrow keys, typeahead and Escape. Items can be links.</CardDescription>
        </CardHeader>
        <CardContent>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" icon={<Avatar name="Founding" tone="agent" shape="square" size="sm" />}>
                Founding workspace
                <ChevronsUpDown className="text-ink-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
              <DropdownMenuItem>
                <Avatar name="Founding" tone="agent" shape="square" size="sm" />
                <span className="flex-1">Founding</span>
                <Check className="text-agent" />
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Avatar name="Note One" tone="agent" shape="square" size="sm" />
                <span className="flex-1">Note One</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                <Plus />
                Create workspace
                <DropdownMenuShortcut>N</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem tone="danger">
                <LogOut />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle>Command palette</CardTitle>
          <CardDescription>Type to filter; arrow keys and Enter to go. In the product, ⌘K or Ctrl K opens it from anywhere in a workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="secondary" onClick={() => setPaletteOpen(true)}>
            Open the command palette
          </Button>
          <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen} title="Command palette" description="Jump to a section or run an action">
            <CommandInput placeholder="Jump to a section, workspace or action…" />
            <CommandList>
              <CommandEmpty>Nothing matches.</CommandEmpty>
              <CommandGroup heading="Sections">
                {SECTIONS.map(({ label, icon: Icon, shortcut }) => (
                  <CommandItem
                    key={label}
                    onSelect={() => {
                      setPaletteOpen(false);
                      toast(`Would open ${label}`);
                    }}
                  >
                    <Icon />
                    {label}
                    <CommandShortcut>{shortcut}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Account">
                <CommandItem onSelect={() => setPaletteOpen(false)}>
                  <LogOut />
                  Sign out
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </CommandDialog>
        </CardContent>
      </Card>
    </div>
  );
}

/** The agent-controls pattern: a busy button, an indeterminate bar, a toast at the end. */
function RunDemo() {
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    await wait(2200);
    setRunning(false);
    toast.success("Day 27 complete", { description: "The agent logged 5 entries." });
  }

  return (
    <div className="max-w-sm space-y-2">
      <Button icon={<Play />} loading={running} onClick={run}>
        {running ? "Running day 27…" : "Run day 27"}
      </Button>
      {running && <ProgressBar label="Running the cycle" />}
      <p aria-live="polite" className="min-h-4 text-xs text-ink-2">
        {running ? "Agent is reading invoices · screening counterparties · checking milestones." : ""}
      </p>
    </div>
  );
}

export function FeedbackDemo() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Toasts</CardTitle>
          <CardDescription>For what went right. An action’s error stays in its form.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => toast.success("Invitation sent to ada@example.com")}>
            Success
          </Button>
          <Button variant="secondary" size="sm" onClick={() => toast("Copied to the clipboard")}>
            Plain
          </Button>
          <Button variant="secondary" size="sm" onClick={() => toast.info("The next cycle runs at 18:17 UTC")}>
            Info
          </Button>
          <Button variant="secondary" size="sm" onClick={() => toast.warning("Screening is using the bundled list")}>
            Warning
          </Button>
          <Button variant="secondary" size="sm" onClick={() => toast.error("The cycle failed at AP")}>
            Error
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => toast.promise(wait(1500), { loading: "Checking every signature…", success: "Chain intact — 163 signatures verified", error: "Not checked" })}
          >
            Promise
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => toast.success("Counterparty added", { description: "Screened against OpenSanctions: clear.", action: { label: "View", onClick: () => {} } })}
          >
            With an action
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Long-running work and copying</CardTitle>
          <CardDescription>The busy state stays on the control that started it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <RunDemo />
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-xs text-ink-2">0x3f5c…9a1e</span>
            <CopyButton value="0x3f5c9a8e7d6b5a4c3f2e1d0c9b8a7f6e5d4c9a1e" label="Copy transaction hash" />
            <CopyButton value="https://www.vestiarion.xyz/invite/example" variant="secondary">
              Copy link
            </CopyButton>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function TabsDemo() {
  return (
    <Tabs defaultValue="manual">
      <TabsList aria-label="Invoice intake">
        <TabsTrigger value="manual">Enter one invoice</TabsTrigger>
        <TabsTrigger value="csv">Import CSV</TabsTrigger>
        <TabsTrigger value="api">Through the API</TabsTrigger>
      </TabsList>
      <TabsContent value="manual">
        <Callout tone="agent" title="The agent evaluates it on the next cycle">
          One invoice, typed in: direction, counterparty, amount, due date.
        </Callout>
      </TabsContent>
      <TabsContent value="csv">
        <Callout title="Nothing is imported until you confirm the preview">Up to 200 rows from a CSV, checked row by row first.</Callout>
      </TabsContent>
      <TabsContent value="api">
        <Callout tone="proof" title="Read-only for now">
          The v1 API reads invoices; writing them stays in the console.
        </Callout>
      </TabsContent>
    </Tabs>
  );
}
```

- [ ] **Step 2: Write the page**

`src/app/design/page.tsx`:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ArrowRight, ExternalLink, Inbox, Play, Plus, Trash2 } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/Card";
import { chipVariants } from "@/components/ui/chip";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Kbd } from "@/components/ui/Kbd";
import { MotionProvider } from "@/components/ui/MotionProvider";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Reveal } from "@/components/ui/Reveal";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Separator } from "@/components/ui/Separator";
import { Skeleton } from "@/components/ui/Skeleton";
import { Spinner } from "@/components/ui/Spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { Tooltip } from "@/components/ui/Tooltip";
import { FeedbackDemo, FormLab, OverlayDemo, TabsDemo } from "./Demos";

export const metadata: Metadata = {
  title: "Design system",
  robots: { index: false, follow: false },
};

const SECTIONS = [
  ["foundations", "Foundations"],
  ["buttons", "Buttons"],
  ["badges", "Badges and chips"],
  ["surfaces", "Cards and callouts"],
  ["states", "Empty and loading"],
  ["data", "Tables and disclosure"],
  ["forms", "Forms"],
  ["overlays", "Overlays"],
  ["feedback", "Feedback and motion"],
] as const;

// Full class names, so Tailwind sees each one in the source.
const COLOURS = [
  ["ground", "bg-ground"],
  ["surface", "bg-surface"],
  ["raised", "bg-raised"],
  ["line", "bg-line"],
  ["line-strong", "bg-line-strong"],
  ["ink", "bg-ink"],
  ["ink-2", "bg-ink-2"],
  ["ink-3", "bg-ink-3"],
  ["agent", "bg-agent"],
  ["agent-soft", "bg-agent-soft"],
  ["agent-line", "bg-agent-line"],
  ["proof", "bg-proof"],
  ["proof-soft", "bg-proof-soft"],
  ["proof-line", "bg-proof-line"],
  ["held", "bg-held"],
  ["held-soft", "bg-held-soft"],
  ["held-line", "bg-held-line"],
  ["refused", "bg-refused"],
  ["refused-soft", "bg-refused-soft"],
  ["refused-line", "bg-refused-line"],
] as const;

const SHADOWS = [
  ["control", "shadow-control", "fields"],
  ["surface", "shadow-surface", "cards at rest"],
  ["raised", "shadow-raised", "a card being hovered"],
  ["overlay", "shadow-overlay", "menus, dialogs, toasts"],
  ["brand", "shadow-brand", "the primary button"],
] as const;

const RADII = [
  ["rounded-md", "tags, chips, keys"],
  ["rounded-lg", "menu items, small controls"],
  ["rounded-xl", "buttons, fields, callouts"],
  ["rounded-2xl", "cards, dialogs"],
  ["rounded-full", "pills, avatars"],
] as const;

const BUTTON_VARIANTS = ["primary", "secondary", "ghost", "danger", "danger-solid", "link"] as const;
const TONES = ["neutral", "agent", "proof", "held", "refused", "simulated"] as const;
const CALLOUT_TONES = ["neutral", "agent", "proof", "held", "refused"] as const;

function Section({ id, title, description, children }: { id: string; title: string; description: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} id={id} className="scroll-mt-8">
      <SectionHeader id={`${id}-title`} title={title} meta={description} />
      <div className="mt-4 space-y-6">{children}</div>
    </section>
  );
}

function Specimen({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Eyebrow>{label}</Eyebrow>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

/**
 * Every primitive in src/components/ui, in every state, on one page: the
 * reference for building a screen and the place to check a change by eye.
 * Development only — production answers 404.
 */
export default function DesignPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <MotionProvider>
      <div className="min-h-dvh">
        <header className="border-b border-line bg-surface/80">
          <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
            <Eyebrow className="text-agent">Vestiarion design system</Eyebrow>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em] text-ink sm:text-4xl">Every primitive, in every state</h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-2">
              Radix UI for behaviour, Motion and CSS for movement, Sonner for toasts — all styled from the tokens in{" "}
              <code className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-xs">globals.css</code>. Import each piece from{" "}
              <code className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-xs">@/components/ui</code>. This page exists in development only.
            </p>
            <nav aria-label="Sections" className="mt-6 flex flex-wrap gap-1.5">
              {SECTIONS.map(([id, label]) => (
                <a key={id} href={`#${id}`} className={chipVariants()}>
                  {label}
                </a>
              ))}
            </nav>
          </div>
        </header>

        <main id="main" className="mx-auto max-w-6xl space-y-16 px-4 py-10 sm:px-6 lg:py-14">
          <Section id="foundations" title="Foundations" description="colour, elevation, shape, type">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
              {COLOURS.map(([name, background]) => (
                <div key={name} className="overflow-hidden rounded-xl border border-line bg-surface">
                  <div className={`h-14 ${background}`} />
                  <p className="px-3 py-2 font-mono text-xs text-ink-2">{name}</p>
                </div>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {SHADOWS.map(([name, shadow, use]) => (
                <div key={name} className={`rounded-2xl border border-line bg-surface p-4 ${shadow}`}>
                  <p className="font-mono text-xs font-semibold text-ink">shadow-{name}</p>
                  <p className="mt-1 text-xs text-ink-3">{use}</p>
                </div>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {RADII.map(([radius, use]) => (
                <div key={radius} className="flex items-center gap-3">
                  <span className={`size-12 shrink-0 border border-agent-line bg-agent-soft ${radius}`} />
                  <div>
                    <p className="font-mono text-xs font-semibold text-ink">{radius}</p>
                    <p className="text-xs text-ink-3">{use}</p>
                  </div>
                </div>
              ))}
            </div>
            <Card>
              <CardContent className="space-y-4">
                <Eyebrow>Geist Mono · captions and figures</Eyebrow>
                <p className="text-3xl font-semibold tracking-[-0.03em] text-ink">Money moves. Evidence remains.</p>
                <p className="max-w-[70ch] font-serif text-reasoning text-ink">
                  Newsreader carries the agent’s reasoning: “Paid INV-204 for 1,250.00 USDC because the purchase order matched and the counterparty screened clear on day 26.”
                </p>
                <p className="text-sm text-ink-2">Geist Sans carries the interface.</p>
              </CardContent>
            </Card>
          </Section>

          <Section id="buttons" title="Buttons" description="variant names intent; size md is 44px tall on phones">
            <Specimen label="Variants">
              {BUTTON_VARIANTS.map((variant) => (
                <Button key={variant} variant={variant}>
                  {variant}
                </Button>
              ))}
            </Specimen>
            <Specimen label="Sizes">
              <Button size="sm">Small</Button>
              <Button>Medium</Button>
              <Button size="lg">Large</Button>
              <Tooltip content="Add a counterparty">
                <Button size="icon" variant="secondary" aria-label="Add a counterparty">
                  <Plus />
                </Button>
              </Tooltip>
              <Tooltip content="Remove">
                <Button size="icon-sm" variant="ghost" aria-label="Remove">
                  <Trash2 />
                </Button>
              </Tooltip>
            </Specimen>
            <Specimen label="States">
              <Button icon={<Play />}>Run day 27</Button>
              <Button loading icon={<Play />}>
                Running day 27…
              </Button>
              <Button variant="secondary" disabled>
                Disabled
              </Button>
              <Button asChild variant="secondary">
                <a href="#buttons">
                  A link that looks like a button <ArrowRight />
                </a>
              </Button>
              <Button variant="link">
                Full audit log <ExternalLink />
              </Button>
            </Specimen>
            <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-agent p-5">
              <Button variant="inverse">Open console</Button>
              <span className="text-sm text-on-agent/80">The inverse button sits on an agent-blue band.</span>
            </div>
          </Section>

          <Section id="badges" title="Badges and chips" description="tone is always said in words too">
            <Specimen label="Tones">
              {TONES.map((tone) => (
                <Badge key={tone} tone={tone} dot>
                  {tone}
                </Badge>
              ))}
            </Specimen>
            <Specimen label="Small, and tags">
              <Badge size="sm" tone="agent" className="font-mono uppercase tracking-wide">
                llm
              </Badge>
              <Badge size="sm" tone="held" shape="tag" className="font-mono uppercase tracking-wider">
                risk changed
              </Badge>
              <Badge shape="tag">PO-100</Badge>
            </Specimen>
            <Specimen label="Filter chips (links)">
              <a href="#badges" aria-current="page" className={chipVariants({ selected: true })}>
                All
              </a>
              <a href="#badges" className={chipVariants()}>
                Payables
              </a>
              <a href="#badges" className={chipVariants()}>
                Treasury
              </a>
            </Specimen>
          </Section>

          <Section id="surfaces" title="Cards and callouts" description="one surface per thing; callouts stand apart">
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <Eyebrow>Cash forecast · next 14 days</Eyebrow>
                  <CardTitle>Projected 18,420.00 USDC</CardTitle>
                  <CardDescription>A card with a header, a body and a footer.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ProgressBar value={64} label="Liquid share of obligations" />
                </CardContent>
                <CardFooter>
                  <Button variant="link">
                    Full audit log <ArrowRight />
                  </Button>
                </CardFooter>
              </Card>
              <Card asChild interactive>
                <a href="#surfaces" className="block p-5 sm:p-6">
                  <Eyebrow>Decisions logged</Eyebrow>
                  <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">163</p>
                  <p className="mt-2 text-sm text-ink-2">An interactive card lifts on hover.</p>
                </a>
              </Card>
              {(["held", "refused", "simulated", "agent"] as const).map((tone) => (
                <Card key={tone} tone={tone}>
                  <CardContent>
                    <p className="text-sm font-semibold text-ink capitalize">{tone}</p>
                    <p className="mt-1 text-sm text-ink-2">A card toned by what it holds.</p>
                  </CardContent>
                </Card>
              ))}
            </div>
            <div className="grid gap-3">
              {CALLOUT_TONES.map((tone) => (
                <Callout key={tone} tone={tone} title={`A ${tone} callout`}>
                  Blocks that stand apart from the page: a refusal, a warning, a recommendation.
                </Callout>
              ))}
            </div>
          </Section>

          <Section id="states" title="Empty and loading" description="what a view says before it has data">
            <EmptyState
              icon={<Inbox />}
              title="No invoices here"
              body="Add one by hand or import a CSV; the agent evaluates new invoices on its next cycle."
              action={<Button icon={<Plus />}>Add an invoice</Button>}
            />
            <Card>
              <CardContent className="space-y-3" aria-busy="true">
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-5 w-3/5" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
              </CardContent>
            </Card>
            <Specimen label="Progress, spinners, keys, avatars">
              <div className="w-48 space-y-2">
                <ProgressBar label="Indeterminate" />
                <ProgressBar value={42} label="Determinate" />
              </div>
              <Spinner className="text-agent" />
              <span className="inline-flex items-center gap-1">
                <Kbd>⌘</Kbd>
                <Kbd>K</Kbd>
              </span>
              <Separator orientation="vertical" className="h-8" />
              <Avatar name="ada@example.com" />
              <Avatar name="Founding" tone="agent" shape="square" size="lg" />
            </Specimen>
          </Section>

          <Section id="data" title="Tables and disclosure" description="tables scroll inside their frame; disclosure is <details>">
            <Card className="overflow-hidden">
              <Table className="min-w-[32rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Joined</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[
                    ["ada@example.com", "Owner", "Sep 24, 2026"],
                    ["grace@example.com", "Admin", "Sep 27, 2026"],
                    ["alan@example.com", "Viewer", "Sep 28, 2026"],
                  ].map(([email, role, joined]) => (
                    <TableRow key={email}>
                      <TableCell>
                        <span className="flex items-center gap-2.5">
                          <Avatar name={email} size="sm" />
                          {email}
                        </span>
                      </TableCell>
                      <TableCell>{role}</TableCell>
                      <TableCell className="text-ink-2">{joined}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
            <Disclosure summary="Score inputs">
              <p className="text-sm leading-relaxed text-ink-2">4 clean payments · 1 information request · 0 held or flagged. Pulled toward 50% until there is enough history to leave it.</p>
            </Disclosure>
            <Disclosure summary="Ledger signing public key · 9b03458d9a617871" defaultOpen>
              <pre className="overflow-x-auto rounded-lg bg-ground p-3 font-mono text-xs text-ink-2">-----BEGIN PUBLIC KEY-----{"\n"}MCowBQYDK2VwAyEA…{"\n"}-----END PUBLIC KEY-----</pre>
            </Disclosure>
          </Section>

          <Section id="forms" title="Forms" description="a refusal keeps your input; the echo shows exactly what arrived">
            <FormLab />
          </Section>

          <Section id="overlays" title="Overlays" description="focus is trapped and returned; Escape closes">
            <OverlayDemo />
          </Section>

          <Section id="feedback" title="Feedback and motion" description="toasts, tabs, and content that rises into view">
            <FeedbackDemo />
            <TabsDemo />
            <div className="grid gap-4 md:grid-cols-3">
              {["Observe", "Reason", "Enforce"].map((step, index) => (
                <Reveal key={step} delay={index * 60}>
                  <Card>
                    <CardContent>
                      <Eyebrow className="text-agent">0{index + 1}</Eyebrow>
                      <p className="mt-2 font-semibold text-ink">{step}</p>
                      <p className="mt-1 text-sm text-ink-2">Revealed once, as it scrolls into view.</p>
                    </CardContent>
                  </Card>
                </Reveal>
              ))}
            </div>
          </Section>
        </main>
      </div>
    </MotionProvider>
  );
}
```

- [ ] **Step 3: Document the folder**

In `README.md`, in the source-layout block, insert these lines immediately above the line that starts `src/components/vx/`:

```
src/components/ui/        The design system: Radix-based primitives styled from
                           the tokens in globals.css — buttons, fields, menus,
                           dialogs, sheets, tabs, toasts, the command palette.
                           /design shows every one in development
```

- [ ] **Step 4: Verify and build**

```bash
npm run verify
NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder SUPABASE_SERVICE_ROLE_KEY=ci-placeholder npm run build
```

Expected: both succeed; the build lists `/design`.

- [ ] **Step 5: Commit**

```bash
git add src/app/design/page.tsx src/app/design/Demos.tsx README.md
git commit -m "feat(ui): a /design page showing every primitive in every state

Development only. Foundations, buttons, badges, cards, callouts, empty and
loading states, tables, disclosure, a form lab that echoes what reached
the action, overlays, toasts, tabs and reveal.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Browser verification (run by the controller, not a subagent)

The preview pane is shared with the partner, so this task is done in the main session. Nothing here changes code unless a check fails; a failure goes back to the task that owns the component.

- [ ] **Step 1:** Start the dev server from the worktree with `preview_start` (`name: "dev"`; `autoPort` picks a free port if 3000 is taken) and open `/design`.
- [ ] **Step 2:** `read_console_messages` with `onlyErrors`: expect no errors and no hydration warnings.
- [ ] **Step 3 (Review Focus 1, 3):** In the form lab, fill every field, pick “Contractor”, tick the checkbox, choose any file, enter amount `0`, press **Submit**. Expect: “Submitting…” on Submit only, then an error message, the amount field marked invalid, and every field — select and checkbox included — still holding its value; the echo table lists `role=contractor`, `goodsReceived=on`, `intent=submit` and the file.
- [ ] **Step 4 (Review Focus 1, 2):** Change amount to `12`, press **Save draft**. Expect: “Saving…” on Save draft only, a success toast, the echo listing `intent=draft`, and every field back to its default (role “Vendor”, checkbox clear, file cleared).
- [ ] **Step 5:** Keyboard: Tab to the role select, open it with Enter, move with arrows, choose with Enter; open the dropdown menu, the dialog, a sheet and the command palette with the keyboard and close each with Escape — focus returns to the opening button every time. The confirmation ignores a click on the dimmed page and closes on Cancel.
- [ ] **Step 6:** Remove a person in the confirmation demo: the row’s button shows its spinner, a toast confirms, the row fades out and the list closes the gap. Switch tabs: the marker glides.
- [ ] **Step 7:** Scroll to the bottom: the three reveal cards rise into view once. Reload while scrolled to the bottom: they are simply visible.
- [ ] **Step 8:** `resize_window` to `mobile`: buttons and fields are 44px tall, the sheet from the left is 20rem wide at most, toasts are full width at the bottom, nothing scrolls sideways except the table inside its frame. Reset with `preset: "desktop"`.
- [ ] **Step 9:** Screenshot the page top, the form lab after a refusal, and an open overlay, for the PR.
- [ ] **Step 10:** Record the build’s route table (First Load JS where Next prints it) for `/`, `/login` and `/design` against `main`, for the PR description.
