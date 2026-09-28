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
