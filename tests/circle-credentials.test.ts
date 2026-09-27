import { describe, expect, it } from "vitest";
import { circleCredentialsFrom } from "../scripts/lib/circle-credentials";

/**
 * The Circle credentials a script acts with for one organization. They come
 * from that organization's own configuration, never from the environment, so
 * these cases build the organization's chain config by hand.
 */

const API_KEY = "test-circle-api-key";
const ENTITY_SECRET = "test-circle-entity-secret";

describe("circleCredentialsFrom", () => {
  it("returns the organization's API key and entity secret", () => {
    expect(circleCredentialsFrom({ circleApiKey: API_KEY, circleEntitySecret: ENTITY_SECRET }, "founding")).toEqual({
      apiKey: API_KEY,
      entitySecret: ENTITY_SECRET,
    });
  });

  it("refuses credentials that are stored but could not be read, naming the organization and the reason", () => {
    const chain = { circleApiKey: API_KEY, credentialsUnreadable: "circle_entity_secret_enc is stored, but VESTIARION_MASTER_KEYS is not set" };
    expect(() => circleCredentialsFrom(chain, "founding")).toThrow(/founding/);
    expect(() => circleCredentialsFrom(chain, "founding")).toThrow(/could not be read.*VESTIARION_MASTER_KEYS is not set/);
  });

  it("refuses unreadable credentials even when both values are present", () => {
    const chain = { circleApiKey: API_KEY, circleEntitySecret: ENTITY_SECRET, credentialsUnreadable: "unsupported state" };
    expect(() => circleCredentialsFrom(chain, "founding")).toThrow(/could not be read/);
  });

  it.each([
    ["API key", { circleEntitySecret: ENTITY_SECRET }, /missing its Circle API key\./],
    ["entity secret", { circleApiKey: API_KEY }, /missing its Circle entity secret\./],
    ["API key and entity secret", {}, /missing its Circle API key and entity secret\./],
  ])("refuses an organization missing its %s, naming it and what is missing", (_label, chain, missing) => {
    expect(() => circleCredentialsFrom(chain, "northstar")).toThrow(/northstar/);
    expect(() => circleCredentialsFrom(chain, "northstar")).toThrow(missing);
  });

  it("says where the credentials come from, and never falls back to this environment's", () => {
    expect(() => circleCredentialsFrom({}, "northstar")).toThrow(/stored encrypted on the organization/);
    expect(() => circleCredentialsFrom({}, "northstar")).toThrow(/org:adopt-env/);
  });

  it("never echoes a credential it was given", () => {
    const messages = [
      { circleApiKey: API_KEY },
      { circleEntitySecret: ENTITY_SECRET },
      { circleApiKey: API_KEY, circleEntitySecret: ENTITY_SECRET, credentialsUnreadable: "unsupported state" },
    ].map((chain) => {
      try {
        circleCredentialsFrom(chain, "northstar");
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    });
    for (const message of messages) {
      expect(message).not.toBe("");
      expect(message).not.toContain(API_KEY);
      expect(message).not.toContain(ENTITY_SECRET);
    }
  });
});
