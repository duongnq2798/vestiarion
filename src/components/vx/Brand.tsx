export function BrandMark({ className = "size-9" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M20 2.25c1.39 0 2.61.33 3.82 1.03l9.04 5.22a7.64 7.64 0 0 1 3.82 6.62v9.76a7.64 7.64 0 0 1-3.82 6.62l-9.04 5.22a7.64 7.64 0 0 1-7.64 0L7.14 31.5a7.64 7.64 0 0 1-3.82-6.62v-9.76A7.64 7.64 0 0 1 7.14 8.5l9.04-5.22A7.64 7.64 0 0 1 20 2.25Z"
      />
      <path
        d="m10.6 12.25 6.8 15.05c.68 1.5 2.77 1.67 3.68.29l8.32-12.58"
        fill="none"
        stroke="var(--color-on-agent, #fffefa)"
        strokeWidth="3.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="29.45" cy="10.7" r="2.35" fill="var(--color-proof, #13845f)" />
    </svg>
  );
}
