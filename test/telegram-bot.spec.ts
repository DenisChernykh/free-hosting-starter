import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src";
import type { TelegramWebhookHandler } from "../src/modules/telegram-bot";
import { createTelegramWebhookHandler } from "../src/modules/telegram-bot/bot";
import type { RuntimeConfigBindings } from "../src/platform/config/runtime-config";
import type { ProblemDetails } from "../src/platform/http/problem-details";

const APP_ORIGIN = "https://free-hosting-starter.example.workers.dev";
const WEBHOOK_SECRET = "webhook_secret-01";
const BOT_TOKEN = "123456:opaque-token";

const disabledBindings = {
  ...env,
  APP_ORIGIN,
  AUTH_MODE: "disabled",
  AUTH_SUCCESS_REDIRECT_URL: `${APP_ORIGIN}/api/auth/me`,
  BUILD_REVISION: "local",
  TELEGRAM_BOT_MODE: "disabled",
} satisfies RuntimeConfigBindings;

const webhookBindings = {
  ...disabledBindings,
  TELEGRAM_BOT_MODE: "webhook",
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_BOT_WEBHOOK_SECRET: WEBHOOK_SECRET,
} satisfies RuntimeConfigBindings;

function problemResponse(response: Response): Promise<ProblemDetails> {
  expect(response.headers.get("Content-Type")).toMatch(/^application\/problem\+json\b/u);
  return response.json() as Promise<ProblemDetails>;
}

function request(
  app: ReturnType<typeof createApp>,
  bindings: RuntimeConfigBindings,
  init: RequestInit = {},
): Promise<Response> {
  return Promise.resolve(app.request(`${APP_ORIGIN}/telegram/webhook`, init, bindings));
}

function fakeHandler(): {
  factory: ReturnType<
    typeof vi.fn<(config: { telegramBotToken: string }) => TelegramWebhookHandler>
  >;
  seen: Record<string, unknown>[];
} {
  const seen: Record<string, unknown>[] = [];
  const handler: TelegramWebhookHandler = async (webhookRequest) => {
    seen.push((await webhookRequest.json()) as Record<string, unknown>);
    return new Response(null, { status: 200 });
  };
  const factory = vi.fn(() => handler);
  return { factory, seen };
}

describe("Telegram Bot webhook", () => {
  it("returns the safe not-found response when disabled", async () => {
    const fake = fakeHandler();
    const app = createApp({ telegramBot: { createWebhookHandler: fake.factory } });
    const response = await request(app, disabledBindings, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
      },
      body: JSON.stringify({ update_id: 1 }),
    });

    expect(response.status).toBe(404);
    expect((await problemResponse(response)).code).toBe("NOT_FOUND");
    expect(fake.factory).not.toHaveBeenCalled();
  });

  it("keeps unsupported methods as the safe not-found response", async () => {
    const app = createApp();
    const response = await request(app, webhookBindings, { method: "GET" });

    expect(response.status).toBe(404);
    expect((await problemResponse(response)).code).toBe("NOT_FOUND");
  });

  it("rejects a missing or incorrect secret before parsing the update", async () => {
    const fake = fakeHandler();
    const app = createApp({ telegramBot: { createWebhookHandler: fake.factory } });
    for (const secret of [undefined, "wrong-secret"]) {
      const headers = new Headers({ "Content-Type": "application/json" });
      if (secret) headers.set("X-Telegram-Bot-Api-Secret-Token", secret);
      const response = await request(app, webhookBindings, {
        method: "POST",
        headers,
        body: "not-json",
      });

      expect(response.status).toBe(401);
      expect((await problemResponse(response)).code).toBe("UNAUTHENTICATED");
    }
    expect(fake.factory).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON content type", async () => {
    const fake = fakeHandler();
    const app = createApp({ telegramBot: { createWebhookHandler: fake.factory } });
    const response = await request(app, webhookBindings, {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET, "Content-Type": "text/plain" },
      body: "{}",
    });

    expect(response.status).toBe(415);
    expect((await problemResponse(response)).code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(fake.factory).not.toHaveBeenCalled();
  });

  it.each(["{", "[]", "null"])("rejects an invalid update envelope: %s", async (body) => {
    const fake = fakeHandler();
    const app = createApp({ telegramBot: { createWebhookHandler: fake.factory } });
    const response = await request(app, webhookBindings, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
      },
      body,
    });

    expect(response.status).toBe(400);
    expect((await problemResponse(response)).code).toBe("VALIDATION_FAILED");
    expect(fake.factory).not.toHaveBeenCalled();
  });

  it("passes a valid provider-owned update to the injected handler", async () => {
    const fake = fakeHandler();
    const app = createApp({ telegramBot: { createWebhookHandler: fake.factory } });
    const update = { update_id: 42, message: { chat: { id: 7 }, text: "/start" } };
    const response = await request(app, webhookBindings, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
      },
      body: JSON.stringify(update),
    });

    expect(response.status).toBe(200);
    expect(fake.factory).toHaveBeenCalledOnce();
    expect(fake.factory).toHaveBeenCalledWith({ telegramBotToken: BOT_TOKEN });
    expect(fake.seen).toEqual([update]);
  });

  it("turns an injected handler failure into a retryable 500", async () => {
    const factory = vi.fn(() => {
      const handler: TelegramWebhookHandler = async () => {
        throw new Error("private handler failure");
      };
      return handler;
    });
    const app = createApp({ telegramBot: { createWebhookHandler: factory } });
    const response = await request(app, webhookBindings, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
      },
      body: JSON.stringify({ update_id: 43 }),
    });

    expect(response.status).toBe(500);
    const body = await problemResponse(response);
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("private handler failure");
  });

  it("registers the deterministic /start handler without a real Telegram request", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push(url);
      if (url.endsWith("/getMe")) {
        return Response.json({
          ok: true,
          result: { id: 123, is_bot: true, first_name: "Test", username: "test_bot" },
        });
      }
      if (url.endsWith("/sendMessage")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ chat_id: 7, text: "Bot is ready." });
        return Response.json({
          ok: true,
          result: {
            message_id: 1,
            date: 1,
            chat: { id: 7, type: "private" },
            text: "Bot is ready.",
          },
        });
      }
      throw new Error(`Unexpected Telegram API request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const handler = createTelegramWebhookHandler({ telegramBotToken: BOT_TOKEN });
      const response = await handler(
        new Request("https://example.test/telegram/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            update_id: 42,
            message: { message_id: 1, date: 1, chat: { id: 7, type: "private" }, text: "/start" },
          }),
        }),
      );

      expect(response.status).toBe(200);
      expect(calls).toEqual(expect.arrayContaining([expect.stringContaining("/getMe")]));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("documents the provider body, response statuses, and header security", async () => {
    const app = createApp();
    const response = await app.request(
      "http://localhost:8787/openapi.json",
      undefined,
      disabledBindings,
    );
    const document = (await response.json()) as {
      components: { securitySchemes: Record<string, { in?: string; name?: string }> };
      paths: Record<
        string,
        { post?: { requestBody?: unknown; responses: Record<string, unknown>; security?: unknown } }
      >;
    };

    expect(document.paths["/telegram/webhook"]?.post?.responses).toEqual(
      expect.objectContaining({
        200: expect.anything(),
        400: expect.anything(),
        401: expect.anything(),
        415: expect.anything(),
        500: expect.anything(),
      }),
    );
    expect(document.paths["/telegram/webhook"]?.post?.requestBody).toEqual(expect.anything());
    expect(document.paths["/telegram/webhook"]?.post?.security).toEqual([
      { telegramWebhookSecret: [] },
    ]);
    expect(document.components.securitySchemes.telegramWebhookSecret).toMatchObject({
      in: "header",
      name: "X-Telegram-Bot-Api-Secret-Token",
    });
  });
});
