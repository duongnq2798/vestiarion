import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/telegram` (Telegram bot design R1, R2): off without the settings, closed without Telegram's secret
 * header, and once authenticated always 200, so Telegram never redelivers an update in a loop. `handleUpdate` is
 * stubbed; its behaviour is covered by tests/telegram-updates.test.ts.
 */

const { handleUpdateMock } = vi.hoisted(() => ({ handleUpdateMock: vi.fn() }));
vi.mock("@/lib/telegram/updates", () => ({ handleUpdate: handleUpdateMock }));

const { POST, maxDuration } = await import("@/app/api/telegram/route");

const SECRET = "s3cret_webhook-value-0123";
const ENV = { TELEGRAM_BOT_TOKEN: "123456:AAH-secret-bot-token", TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: "vestiarion_bot" };
const saved = Object.fromEntries(Object.keys(ENV).map((name) => [name, process.env[name]]));

beforeEach(() => {
  Object.assign(process.env, ENV);
  handleUpdateMock.mockReset();
  handleUpdateMock.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.restoreAllMocks();
});

const UPDATE = { update_id: 901, message: { message_id: 1, date: 1, chat: { id: 5550001, type: "private" }, text: "the invoice for Quill & Co" } };

function post(body: unknown, secret: string | null = SECRET) {
  return POST(
    new Request("https://www.vestiarion.xyz/api/telegram", {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret === null ? {} : { "x-telegram-bot-api-secret-token": secret }) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

describe("POST /api/telegram", () => {
  it("has a minute to answer, for a PDF read by the model", () => {
    expect(maxDuration).toBe(60);
  });

  it("is not there when the bot is not configured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const response = await post(UPDATE);
    expect(response.status).toBe(404);
    expect(handleUpdateMock).not.toHaveBeenCalled();
  });

  it.each([
    ["no secret header", null],
    ["a wrong secret", "s3cret_webhook-value-0124"],
    ["a secret of another length", "short"],
  ])("refuses a request with %s, and handles nothing", async (_label, secret) => {
    const response = await post(UPDATE, secret);
    expect(response.status).toBe(401);
    expect(handleUpdateMock).not.toHaveBeenCalled();
  });

  it("hands an authenticated update to the handler once, and answers 200", async () => {
    const response = await post(UPDATE);
    expect(response.status).toBe(200);
    expect(handleUpdateMock).toHaveBeenCalledTimes(1);
    expect(handleUpdateMock.mock.calls[0][0]).toEqual(UPDATE);
  });

  it("answers 200 to a body that is not JSON, and handles nothing", async () => {
    const response = await post("{not json");
    expect(response.status).toBe(200);
    expect(handleUpdateMock).not.toHaveBeenCalled();
  });

  it("answers 200 when handling throws, logging the update's id and never its text", async () => {
    handleUpdateMock.mockRejectedValue(new Error("database unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await post(UPDATE);

    expect(response.status).toBe(200);
    const lines = JSON.stringify(logged.mock.calls);
    expect(lines).toContain("901");
    expect(lines).not.toContain("Quill");
  });
});
