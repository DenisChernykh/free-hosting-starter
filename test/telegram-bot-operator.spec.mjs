import { describe, expect, it } from "vitest";
import { REDACTED_WEBHOOK_URL, runTelegramOperator } from "../scripts/telegram-bot-operator.mjs";
import fixture from "./fixtures/telegram-update.json";

const TOKEN = "123456:operator-test-token";
const WEBHOOK_SECRET = "operator_webhook-secret";
const WEBHOOK_URL = "https://example.workers.dev/telegram/webhook";

function output() {
  let value = "";
  return {
    write(chunk) {
      value += String(chunk);
    },
    text() {
      return value;
    },
  };
}

function fakeBotApi(result) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ input: String(input), init });
    return Response.json({ ok: true, result });
  };
  return { calls, fetchImpl };
}

describe("Telegram operator workflow", () => {
  it("inspects webhook info through a fake Bot API without printing the token", async () => {
    const api = fakeBotApi({
      url: WEBHOOK_URL,
      pending_update_count: 0,
      allowed_updates: ["message"],
      last_error_message: `provider diagnostic ${TOKEN} ${WEBHOOK_SECRET}`,
    });
    const stdout = output();
    const stderr = output();

    const exitCode = await runTelegramOperator({
      args: ["info"],
      environment: {
        TELEGRAM_BOT_TOKEN: TOKEN,
        TELEGRAM_BOT_WEBHOOK_SECRET: WEBHOOK_SECRET,
      },
      stdout,
      stderr,
      fetchImpl: api.fetchImpl,
    });

    expect(exitCode).toBe(0);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].input).toContain(`/bot${TOKEN}/getWebhookInfo`);
    expect(JSON.parse(stdout.text())).toMatchObject({
      url: WEBHOOK_URL,
      pending_update_count: 0,
      allowed_updates: ["message"],
    });
    expect(stdout.text()).not.toContain(TOKEN);
    expect(stdout.text()).not.toContain(WEBHOOK_SECRET);
    expect(stderr.text()).toBe("");
  });

  it.each([
    ["userinfo", `https://operator:${WEBHOOK_SECRET}@example.workers.dev/telegram/webhook`],
    ["query credential", `https://example.workers.dev/telegram/webhook?credential=${TOKEN}`],
    ["fragment", `https://example.workers.dev/telegram/webhook#${WEBHOOK_SECRET}`],
    ["unexpected path", `https://example.workers.dev/${WEBHOOK_SECRET}`],
  ])("redacts unsafe %s webhook URLs from inspection output", async (_caseName, url) => {
    const api = fakeBotApi({ url });
    const stdout = output();
    const stderr = output();

    const exitCode = await runTelegramOperator({
      args: ["info"],
      environment: {
        TELEGRAM_BOT_TOKEN: TOKEN,
        TELEGRAM_BOT_WEBHOOK_SECRET: WEBHOOK_SECRET,
      },
      stdout,
      stderr,
      fetchImpl: api.fetchImpl,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text()).url).toBe(REDACTED_WEBHOOK_URL);
    expect(stdout.text()).not.toContain(TOKEN);
    expect(stdout.text()).not.toContain(WEBHOOK_SECRET);
    expect(stderr.text()).toBe("");
  });

  it("sets a webhook with message updates and keeps pending updates by default", async () => {
    const api = fakeBotApi(true);
    const stdout = output();
    const stderr = output();

    const exitCode = await runTelegramOperator({
      args: ["set", WEBHOOK_URL],
      environment: {
        TELEGRAM_BOT_TOKEN: TOKEN,
        TELEGRAM_BOT_WEBHOOK_SECRET: WEBHOOK_SECRET,
      },
      stdout,
      stderr,
      fetchImpl: api.fetchImpl,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(api.calls[0].init.body)).toEqual({
      url: WEBHOOK_URL,
      allowed_updates: ["message"],
      drop_pending_updates: false,
      secret_token: WEBHOOK_SECRET,
    });
    expect(stdout.text()).toBe("Telegram webhook set.\n");
    expect(stdout.text()).not.toContain(TOKEN);
    expect(stdout.text()).not.toContain(WEBHOOK_SECRET);
    expect(stderr.text()).toBe("");
  });

  it("requires an explicit flag and warns before dropping pending updates", async () => {
    const api = fakeBotApi(true);
    const stdout = output();
    const stderr = output();

    const exitCode = await runTelegramOperator({
      args: ["set", "--drop-pending-updates", "--url", WEBHOOK_URL],
      environment: {
        TELEGRAM_BOT_TOKEN: TOKEN,
        TELEGRAM_BOT_WEBHOOK_SECRET: WEBHOOK_SECRET,
      },
      stdout,
      stderr,
      fetchImpl: api.fetchImpl,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(api.calls[0].init.body).drop_pending_updates).toBe(true);
    expect(stderr.text()).toContain("permanently discard pending Telegram updates");
    expect(stderr.text()).not.toContain(TOKEN);
    expect(stderr.text()).not.toContain(WEBHOOK_SECRET);
  });

  it("clears the webhook with setWebhook and does not drop pending updates by default", async () => {
    const api = fakeBotApi(true);
    const stdout = output();

    const exitCode = await runTelegramOperator({
      args: ["clear"],
      environment: {
        TELEGRAM_BOT_TOKEN: TOKEN,
      },
      stdout,
      fetchImpl: api.fetchImpl,
    });

    expect(exitCode).toBe(0);
    expect(api.calls[0].input).toContain(`/bot${TOKEN}/setWebhook`);
    expect(JSON.parse(api.calls[0].init.body)).toEqual({
      url: "",
      drop_pending_updates: false,
    });
    expect(stdout.text()).toBe("Telegram webhook cleared.\n");
  });

  it("reads both secrets from newline-delimited stdin when env is absent", async () => {
    const api = fakeBotApi(true);
    const stdout = output();
    const stderr = output();

    const exitCode = await runTelegramOperator({
      args: ["set", WEBHOOK_URL],
      environment: {},
      input: `${TOKEN}\n${WEBHOOK_SECRET}\n`,
      stdout,
      stderr,
      fetchImpl: api.fetchImpl,
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).not.toContain(TOKEN);
    expect(stdout.text()).not.toContain(WEBHOOK_SECRET);
    expect(stderr.text()).toBe("");
  });

  it("rejects secret-looking CLI arguments without echoing them", async () => {
    const api = fakeBotApi(true);
    const stdout = output();
    const stderr = output();

    const exitCode = await runTelegramOperator({
      args: ["set", WEBHOOK_URL, `--token=${TOKEN}`],
      environment: {
        TELEGRAM_BOT_TOKEN: TOKEN,
        TELEGRAM_BOT_WEBHOOK_SECRET: WEBHOOK_SECRET,
      },
      stdout,
      stderr,
      fetchImpl: api.fetchImpl,
    });

    expect(exitCode).toBe(1);
    expect(api.calls).toHaveLength(0);
    expect(stdout.text()).not.toContain(TOKEN);
    expect(stderr.text()).not.toContain(TOKEN);
  });

  it("rejects webhook URLs with query parameters", async () => {
    const api = fakeBotApi(true);
    const stderr = output();

    const exitCode = await runTelegramOperator({
      args: ["set", `${WEBHOOK_URL}?secret=not-a-secret`],
      environment: {
        TELEGRAM_BOT_TOKEN: TOKEN,
        TELEGRAM_BOT_WEBHOOK_SECRET: WEBHOOK_SECRET,
      },
      stderr,
      fetchImpl: api.fetchImpl,
    });

    expect(exitCode).toBe(1);
    expect(api.calls).toHaveLength(0);
    expect(stderr.text()).not.toContain("not-a-secret");
  });

  it("rejects a webhook secret outside Telegram's provider character contract", async () => {
    const api = fakeBotApi(true);
    const stderr = output();

    const exitCode = await runTelegramOperator({
      args: ["set", WEBHOOK_URL],
      environment: {
        TELEGRAM_BOT_TOKEN: TOKEN,
        TELEGRAM_BOT_WEBHOOK_SECRET: "secret with spaces",
      },
      stderr,
      fetchImpl: api.fetchImpl,
    });

    expect(exitCode).toBe(1);
    expect(api.calls).toHaveLength(0);
    expect(stderr.text()).not.toContain("secret with spaces");
  });

  it("keeps a deterministic fake update fixture for local requests", () => {
    expect(fixture).toMatchObject({
      update_id: expect.any(Number),
      message: { text: "/start", chat: { type: "private" } },
    });
  });
});
