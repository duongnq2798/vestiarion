import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import styles from "./PublicMain.module.css";

/** Presentation only: token readers, form state and focus stay with the page and its existing components. */
export function PublicMain({ children, width = "form" }: { children: ReactNode; width?: "form" | "record" }) {
  return <main id="main" className={`${styles.main} focus-default`}><div className={cn(styles.content, width === "record" && styles.record)}>{children}</div></main>;
}
