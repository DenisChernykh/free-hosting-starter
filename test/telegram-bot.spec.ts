import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src";
import type {
  TelegramWebhookHandler,
  TelegramWebhookRequestContext,
} from "../src/modules/telegram-bot";
import { TELEGRAM_BOT_INITIALIZATION_TIMEOUT_MS } from "../src/modules/telegram-bot";
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
    let attempts = 0;
    const factory = vi.fn(() => {
      const handler: TelegramWebhookHandler = async () => {
        attempts += 1;
        throw new Error("private handler failure");
      };
      return handler;
    });
    const app = createApp({ telegramBot: { createWebhookHandler: factory } });
    for (const updateId of [43, 44]) {
      const response = await request(app, webhookBindings, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
        },
        body: JSON.stringify({ update_id: updateId }),
      });

      expect(response.status).toBe(500);
      const body = await problemResponse(response);
      expect(body.code).toBe("INTERNAL_ERROR");
      expect(JSON.stringify(body)).not.toContain("private handler failure");
    }
    expect(attempts).toBe(2);
    expect(factory).toHaveBeenCalledOnce();
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

  it("initializes bot metadata once per isolate and handles unsupported updates promptly", async () => {
    const token = "123456:metadata-cache-test";
    let getMeCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/getMe")) {
        getMeCalls += 1;
        return Response.json({
          ok: true,
          result: { id: 123, is_bot: true, first_name: "Test", username: "test_bot" },
        });
      }
      throw new Error(`Unexpected Telegram API request: ${url} ${String(init?.body)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const first = createTelegramWebhookHandler({ telegramBotToken: token });
      const second = createTelegramWebhookHandler({ telegramBotToken: token });
      const update = JSON.stringify({ update_id: 501, edited_channel_post: { text: "ignored" } });
      const requestFor = () =>
        new Request("https://example.test/telegram/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: update,
        });

      const [firstResponse, secondResponse] = await Promise.all([
        first(requestFor()),
        second(requestFor()),
      ]);

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      expect(getMeCalls).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["stalled", "server-error"])(
    "bounds %s bot initialization and permits a later retry",
    async (failureMode) => {
      const token = `123456:init-timeout-${failureMode}`;
      const bindings = { ...webhookBindings, TELEGRAM_BOT_TOKEN: token };
      let attempts = 0;
      let allowSuccess = false;
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          attempts += 1;
          if (allowSuccess) {
            return Response.json({
              ok: true,
              result: { id: 123, is_bot: true, first_name: "Test", username: "test_bot" },
            });
          }
          if (failureMode === "stalled") {
            return await new Promise<Response>((_resolve, reject) => {
              const rejectAborted = () => reject(new Error("provider stalled with token"));
              if (init?.signal?.aborted) rejectAborted();
              else init?.signal?.addEventListener("abort", rejectAborted, { once: true });
            });
          }
          return Response.json({
            ok: false,
            error_code: 500,
            description: "provider failure with secret",
          });
        },
      );
      const logs: string[] = [];
      const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
        logs.push(args.map((value) => String(value)).join(" "));
      });
      vi.stubGlobal("fetch", fetchMock);

      try {
        const app = createApp();
        const failedRequest = request(app, bindings, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
          },
          body: JSON.stringify({ update_id: 601, edited_channel_post: { text: "hidden" } }),
        });
        const failedResponse = await failedRequest;

        expect(failedResponse.status).toBe(500);
        expect((await problemResponse(failedResponse)).code).toBe("INTERNAL_ERROR");
        expect(logs.join("\n")).toContain('"category":"initialization_failure"');
        expect(logs.join("\n")).not.toContain(token);

        allowSuccess = true;
        const retriedResponse = await request(app, bindings, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
          },
          body: JSON.stringify({ update_id: 602, edited_channel_post: { text: "hidden" } }),
        });

        expect(retriedResponse.status).toBe(200);
        expect(attempts).toBeGreaterThan(1);
      } finally {
        errorSpy.mockRestore();
        vi.unstubAllGlobals();
      }
    },
    TELEGRAM_BOT_INITIALIZATION_TIMEOUT_MS + 10_000,
  );

  it("propagates safe request context and redacts provider data from failure logs", async () => {
    const logs: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      logs.push(args.map((value) => String(value)).join(" "));
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map((value) => String(value)).join(" "));
    });
    const contexts: TelegramWebhookRequestContext[] = [];
    const factory = vi.fn(() => {
      const handler: TelegramWebhookHandler = async (_request, context) => {
        if (context) contexts.push(context);
        throw new Error("provider token webhook_secret-01 cookie-secret message text query-secret");
      };
      return handler;
    });
    const app = createApp({ telegramBot: { createWebhookHandler: factory } });

    try {
      const response = await app.request(
        `${APP_ORIGIN}/telegram/webhook?query=query-secret`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: "session=cookie-secret",
            "CF-Ray": "request-id-01",
            "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
          },
          body: JSON.stringify({
            update_id: 777,
            message: { text: "message text", token: BOT_TOKEN, secret: WEBHOOK_SECRET },
          }),
        },
        webhookBindings,
      );

      expect(response.status).toBe(500);
      expect(contexts).toEqual([
        { path: "/telegram/webhook", requestId: "request", updateId: 777 },
      ]);
      const serializedLogs = logs.join("\n");
      expect(serializedLogs).toContain('"event":"telegram_webhook_failure"');
      expect(serializedLogs).toContain('"category":"handler_failure"');
      expect(serializedLogs).toContain('"path":"/telegram/webhook"');
      expect(serializedLogs).toContain('"update_id":777');
      for (const secret of [
        BOT_TOKEN,
        WEBHOOK_SECRET,
        "cookie-secret",
        "query-secret",
        "message text",
      ]) {
        expect(serializedLogs).not.toContain(secret);
      }
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
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
