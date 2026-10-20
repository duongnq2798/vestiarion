/**
 * The agent tick's schedule in `supabase/cron/watches.sql`: 17 minutes past every sixth hour, UTC. The due-work watch
 * reads it to tell a scheduled cycle the tick missed (docs/superpowers/specs/2026-10-21-due-work-watch-design.md DW4),
 * and tests/supabase-cron.test.ts holds the two equal: a tick run at another time would make the watch run a second
 * scheduled cycle every period. No imports, so the test reads it without loading the agent.
 */
export const TICK_MINUTE = 17;
export const TICK_EVERY_HOURS = 6;
