"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Treasury" },
  { href: "/invoices", label: "AP / AR" },
  { href: "/contractors", label: "Contractors" },
  { href: "/compliance", label: "Compliance" },
  { href: "/audit", label: "Audit Log" },
];

export default function Nav() {
  const pathname = usePathname();
  return (
    <nav className="border-b border-neutral-800 bg-neutral-950/80 backdrop-blur sticky top-0 z-10">
      <div className="mx-auto flex max-w-6xl items-center gap-1 px-4 py-3 sm:px-6">
        <span className="mr-4 font-semibold tracking-tight text-neutral-50">
          Vestiarion
        </span>
        {links.map((l) => {
          const active = pathname === l.href;
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                active
                  ? "bg-neutral-100 text-neutral-900"
                  : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
              }`}
            >
              {l.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
