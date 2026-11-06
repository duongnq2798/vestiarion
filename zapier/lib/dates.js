'use strict';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A day as `YYYY-MM-DD`, from a date a Zap maps: `2026-11-30`, `2026-11-30T00:00:00Z`, or what Zapier's date field gives. */
function dayOf(value) {
  const raw = String(value == null ? '' : value).trim();
  if (raw === '') return null;
  if (DAY.test(raw)) return raw;
  const head = raw.slice(0, 10);
  if (DAY.test(head) && /^\d{4}-\d{2}-\d{2}[T ]/.test(raw)) return head;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

module.exports = { dayOf };
