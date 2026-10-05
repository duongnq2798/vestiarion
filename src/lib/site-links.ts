/**
 * Where Vestiarion lives on GitHub (spec §2, F3). Support and Contact are both
 * the repository's Issues, so every link to either is built from here and
 * changes in one place.
 */

export const GITHUB_URL = "https://github.com/duongnq2798/vestiarion";

/** Support, contact and account requests: the repository's GitHub Issues. */
export const ISSUES_URL = `${GITHUB_URL}/issues`;

/** The MIT License the code is released under. */
export const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE`;

/** The project's account on X: the footer links it, and pages name it as their `twitter:site`. */
export const X_HANDLE = "@vestiarionhq";

export const X_URL = `https://x.com/${X_HANDLE.slice(1)}`;

/** Vestiarion's page on Product Hunt, launched 2026-10-05. */
export const PRODUCT_HUNT_URL = "https://www.producthunt.com/products/vestiarion";

/**
 * Product Hunt's "Featured" badge, as its embed code gives it, in the light
 * theme. Product Hunt draws the image, upvote count included, and the link
 * carries its own campaign tags.
 */
export const PRODUCT_HUNT_BADGE = {
  href: `${PRODUCT_HUNT_URL}?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-vestiarion`,
  src: "https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1269583&theme=light",
  alt: "Vestiarion - AI treasury operations for invoices, freelancers and GitHub | Product Hunt",
  width: 250,
  height: 54,
} as const;
