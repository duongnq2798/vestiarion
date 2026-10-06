-- The network column's comment after 0078 (docs/superpowers/specs/2026-10-06-mainnet-limits-design.md L8): a
-- workspace's network is chosen when it is created and fixed once it has an account, not only once it went live or
-- holds a Circle wallet (0075). A comment only; idempotent.

comment on column public.orgs.network is
  'The network the workspace pays on: arc-testnet or arc-mainnet. Chosen when it is created, and fixed once it has an account (0078).';
