import { describe, expect, it } from "vitest";
import { connectionStatus, syncErrorWords, type ConnectionFacts } from "@/lib/connectors/status";

/**
 * The connection's status in business words (docs/superpowers/specs/2026-10-12-xero-connector-design.md X15): never
 * "connected" while the last sync failed, a reconnect asked for in words a person acts on, and the time of the next try.
 */

const NOW = Date.parse("2026-10-12T14:00:00.000Z");

const connected: ConnectionFacts = {
  providerLabel: "Xero",
  status: "connected",
  externalOrgName: "Demo Company (Global)",
  lastSyncedAt: "2026-10-12T13:55:00.000Z",
  lastError: null,
  lastErrorAt: null,
  syncing: null,
};

describe("connectionStatus", () => {
  it("says connected, to which organisation, and when it last synced", () => {
    expect(connectionStatus(connected, NOW)).toEqual({
      tone: "ok",
      title: "Connected to Demo Company (Global)",
      detail: ["Last synced 5 minutes ago."],
      reconnect: false,
    });
  });

  it("says a connection never synced will be shortly", () => {
    expect(connectionStatus({ ...connected, lastSyncedAt: null }, NOW).detail).toEqual(["Not synced yet. The first sync starts in a moment."]);
  });

  it("says how far a sync under way has read", () => {
    expect(connectionStatus({ ...connected, syncing: { pagesRead: 2 } }, NOW).detail).toEqual([
      "Last synced 5 minutes ago.",
      "Syncing: 2 of Xero's pages read so far.",
    ]);
    expect(connectionStatus({ ...connected, syncing: { pagesRead: 1 } }, NOW).detail[1]).toBe("Syncing: 1 of Xero's pages read so far.");
  });

  it("never says connected when the last sync failed after the last success", () => {
    const failed = { ...connected, lastError: "Xero did not answer. Vestiarion tries again at 14:05 UTC.", lastErrorAt: "2026-10-12T13:58:00.000Z" };
    expect(connectionStatus(failed, NOW)).toEqual({
      tone: "error",
      title: "The last sync with Xero failed",
      detail: ["Xero did not answer. Vestiarion tries again at 14:05 UTC.", "Last synced 5 minutes ago."],
      reconnect: false,
    });
    expect(connectionStatus({ ...failed, lastSyncedAt: null }, NOW).detail[1]).toBe("Not synced yet.");
  });

  it("asks to reconnect when the provider no longer takes the connection", () => {
    expect(connectionStatus({ ...connected, status: "needs_reconnect", lastError: null }, NOW)).toEqual({
      tone: "error",
      title: "Xero needs you to reconnect",
      detail: ["Xero no longer accepts this connection. Reconnect Xero to go on bringing its bills in."],
      reconnect: true,
    });
  });

  it("says a disconnected connection reads nothing more and keeps what was added", () => {
    expect(connectionStatus({ ...connected, status: "revoked" }, NOW)).toEqual({
      tone: "off",
      title: "Disconnected from Demo Company (Global)",
      detail: ["Bills already added stay in Vestiarion. Nothing more is read from Xero."],
      reconnect: false,
    });
  });

  it("counts time in minutes, hours and days", () => {
    const at = (iso: string) => connectionStatus({ ...connected, lastSyncedAt: iso }, NOW).detail[0];
    expect(at("2026-10-12T13:59:40.000Z")).toBe("Last synced just now.");
    expect(at("2026-10-12T13:59:00.000Z")).toBe("Last synced 1 minute ago.");
    expect(at("2026-10-12T11:00:00.000Z")).toBe("Last synced 3 hours ago.");
    expect(at("2026-10-12T13:00:00.000Z")).toBe("Last synced 1 hour ago.");
    expect(at("2026-10-09T14:00:00.000Z")).toBe("Last synced 3 days ago.");
  });
});

describe("syncErrorWords", () => {
  const at = "2026-10-12T14:05:00.000Z";

  it("says why and when the next try is, in business words", () => {
    expect(syncErrorWords("rate_limited", "Xero", at)).toBe("Xero asked Vestiarion to slow down. Syncing again at 14:05 UTC.");
    expect(syncErrorWords("unavailable", "Xero", at)).toBe("Xero did not answer. Vestiarion tries again at 14:05 UTC.");
    expect(syncErrorWords("bad_response", "Xero", at)).toBe("Xero's answer could not be read. Vestiarion tries again at 14:05 UTC.");
    expect(syncErrorWords("failed", "Xero", at)).toBe("The sync stopped on an error. Vestiarion tries again at 14:05 UTC.");
  });

  it("names the day when the next try is not today", () => {
    expect(syncErrorWords("rate_limited", "Xero", "2026-10-13T08:00:00.000Z", NOW)).toBe(
      "Xero asked Vestiarion to slow down. Syncing again at 08:00 UTC on Oct 13."
    );
  });

  it("asks for a reconnect when the provider refused the connection", () => {
    expect(syncErrorWords("reconnect", "Xero", null)).toBe(
      "Xero no longer accepts this connection: it was disconnected in Xero, or not used for 60 days. Reconnect Xero to go on bringing its bills in."
    );
  });
});

describe("QuickBooks's words (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q15)", () => {
  const quickbooks: ConnectionFacts = { ...connected, providerLabel: "QuickBooks", externalOrgName: "Sandbox Company_US_1" };

  it("names the company, and never says connected while the last sync failed", () => {
    expect(connectionStatus(quickbooks, NOW).title).toBe("Connected to Sandbox Company_US_1");
    expect(connectionStatus({ ...quickbooks, externalOrgName: null, status: "revoked" }, NOW).title).toBe("Disconnected from your QuickBooks company");
    const failed = { ...quickbooks, lastError: syncErrorWords("rate_limited", "QuickBooks", "2026-10-12T14:01:00.000Z"), lastErrorAt: "2026-10-12T13:59:00.000Z" };
    expect(connectionStatus(failed, NOW)).toMatchObject({
      tone: "error",
      title: "The last sync with QuickBooks failed",
      detail: ["QuickBooks asked Vestiarion to slow down. Syncing again at 14:01 UTC.", "Last synced 5 minutes ago."],
    });
  });

  it("asks for a reconnect after QuickBooks' own 100 days", () => {
    expect(syncErrorWords("reconnect", "QuickBooks", null)).toBe(
      "QuickBooks no longer accepts this connection: it was disconnected in QuickBooks, or not used for 100 days. Reconnect QuickBooks to go on bringing its bills in."
    );
  });
});

describe("a CRM's status words (HubSpot connector H16)", () => {
  const hubspot: ConnectionFacts = { ...connected, providerLabel: "HubSpot", externalOrgName: "example.com" };

  it("says connected to the HubSpot account, in the same words as an accounting tool", () => {
    expect(connectionStatus(hubspot, NOW)).toEqual({ tone: "ok", title: "Connected to example.com", detail: ["Last synced 5 minutes ago."], reconnect: false });
    expect(connectionStatus({ ...hubspot, externalOrgName: null }, NOW).title).toBe("Connected to your HubSpot account");
  });

  it("speaks of deals, not bills, when disconnected or asked to reconnect", () => {
    expect(connectionStatus({ ...hubspot, status: "revoked" }, NOW).detail).toEqual(["Deals already planned stay in Vestiarion. Nothing more is read from HubSpot."]);
    expect(syncErrorWords("reconnect", "HubSpot", null)).toBe(
      "HubSpot no longer accepts this connection: the app was uninstalled in HubSpot, or its access was removed. Reconnect HubSpot to go on bringing its deals in."
    );
    expect(connectionStatus({ ...hubspot, status: "needs_reconnect", lastError: null }, NOW).detail).toEqual([
      "HubSpot no longer accepts this connection. Reconnect HubSpot to go on bringing its deals in.",
    ]);
  });
});
