import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type RuntimeConfigBindings,
  readRuntimeConfig,
} from "../src/platform/config/runtime-config";

const APP_ORIGIN = "https://free-hosting-starter.example.workers.dev";
const AUTH_FLOW_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const baseBindings: RuntimeConfigBindings = {
  ...env,
  APP_ORIGIN,
  AUTH_MODE: "disabled",
  AUTH_SUCCESS_REDIRECT_URL: `${APP_ORIGIN}/api/auth/me`,
  BUILD_REVISION: "local",
  TELEGRAM_BOT_MODE: "disabled",
};

function bindings(overrides: Partial<RuntimeConfigBindings> = {}): RuntimeConfigBindings {
  return { ...baseBindings, ...overrides };
}

function authBindings(): Pick<
  RuntimeConfigBindings,
  "AUTH_FLOW_SECRET" | "TELEGRAM_OIDC_CLIENT_ID" | "TELEGRAM_OIDC_CLIENT_SECRET"
> {
  return {
    AUTH_FLOW_SECRET,
    TELEGRAM_OIDC_CLIENT_ID: "123456789",
    TELEGRAM_OIDC_CLIENT_SECRET: "oidc-secret",
  };
}

function botBindings(): Pick<
  RuntimeConfigBindings,
  "TELEGRAM_BOT_TOKEN" | "TELEGRAM_BOT_WEBHOOK_SECRET"
> {
  return {
    TELEGRAM_BOT_TOKEN: "123456:opaque-token",
    TELEGRAM_BOT_WEBHOOK_SECRET: "webhook_secret-01",
  };
}

describe("runtime configuration capability matrix", () => {
  it.each([
    {
      authMode: "disabled",
      botMode: "disabled",
      overrides: {} as const,
      expected: {
        appOrigin: APP_ORIGIN,
        authMode: "disabled",
        authSuccessRedirectUrl: `${APP_ORIGIN}/api/auth/me`,
        buildRevision: "local",
        telegramBotMode: "disabled",
      },
    },
    {
      authMode: "development",
      botMode: "disabled",
      overrides: { AUTH_MODE: "development" } as const,
      expected: {
        appOrigin: APP_ORIGIN,
        authMode: "development",
        authSuccessRedirectUrl: `${APP_ORIGIN}/api/auth/me`,
        buildRevision: "local",
        telegramBotMode: "disabled",
      },
    },
    {
      authMode: "telegram",
      botMode: "disabled",
      overrides: { AUTH_MODE: "telegram", ...authBindings() } as const,
      expected: {
        appOrigin: APP_ORIGIN,
        authFlowSecret: AUTH_FLOW_SECRET,
        authMode: "telegram",
        authSuccessRedirectUrl: `${APP_ORIGIN}/api/auth/me`,
        buildRevision: "local",
        telegramBotMode: "disabled",
        telegramClientId: "123456789",
        telegramClientSecret: "oidc-secret",
      },
    },
    {
      authMode: "disabled",
      botMode: "webhook",
      overrides: { TELEGRAM_BOT_MODE: "webhook", ...botBindings() } as const,
      expected: {
        appOrigin: APP_ORIGIN,
        authMode: "disabled",
        authSuccessRedirectUrl: `${APP_ORIGIN}/api/auth/me`,
        buildRevision: "local",
        telegramBotMode: "webhook",
        telegramBotToken: "123456:opaque-token",
        telegramBotWebhookSecret: "webhook_secret-01",
      },
    },
    {
      authMode: "telegram",
      botMode: "webhook",
      overrides: {
        AUTH_MODE: "telegram",
        TELEGRAM_BOT_MODE: "webhook",
        ...authBindings(),
        ...botBindings(),
      } as const,
      expected: {
        appOrigin: APP_ORIGIN,
        authFlowSecret: AUTH_FLOW_SECRET,
        authMode: "telegram",
        authSuccessRedirectUrl: `${APP_ORIGIN}/api/auth/me`,
        buildRevision: "local",
        telegramBotMode: "webhook",
        telegramBotToken: "123456:opaque-token",
        telegramBotWebhookSecret: "webhook_secret-01",
        telegramClientId: "123456789",
        telegramClientSecret: "oidc-secret",
      },
    },
  ])("parses auth=$authMode and bot=$botMode independently", ({ overrides, expected }) => {
    const config = readRuntimeConfig(bindings(overrides));
    expect(config).toEqual(expected);
  });

  it("does not require disabled capability secrets", () => {
    expect(
      readRuntimeConfig(
        bindings({
          AUTH_FLOW_SECRET: "invalid",
          TELEGRAM_BOT_TOKEN: "",
          TELEGRAM_BOT_WEBHOOK_SECRET: "not valid",
        } as const),
      ),
    ).toMatchObject({ authMode: "disabled", telegramBotMode: "disabled" });
  });

  it("rejects development auth outside the local runtime", () => {
    expect(() =>
      readRuntimeConfig(
        bindings({ AUTH_MODE: "development", BUILD_REVISION: "production" } as const),
      ),
    ).toThrow("AUTH_MODE=development is only permitted with BUILD_REVISION=local");
  });

  it.each([
    { name: "AUTH_FLOW_SECRET", overrides: { AUTH_MODE: "telegram" } as const },
    {
      name: "TELEGRAM_OIDC_CLIENT_ID",
      overrides: {
        AUTH_MODE: "telegram",
        ...authBindings(),
        TELEGRAM_OIDC_CLIENT_ID: "0",
      } as const,
    },
    {
      name: "TELEGRAM_OIDC_CLIENT_SECRET",
      overrides: {
        AUTH_MODE: "telegram",
        ...authBindings(),
        TELEGRAM_OIDC_CLIENT_SECRET: " ",
      } as const,
    },
  ])("fails closed when enabled auth secret $name is missing or invalid", ({ overrides }) => {
    expect(() => readRuntimeConfig(bindings(overrides))).toThrow();
  });

  it.each([
    { name: "TELEGRAM_BOT_TOKEN", overrides: { TELEGRAM_BOT_MODE: "webhook" } as const },
    {
      name: "TELEGRAM_BOT_WEBHOOK_SECRET",
      overrides: {
        TELEGRAM_BOT_MODE: "webhook",
        ...botBindings(),
        TELEGRAM_BOT_WEBHOOK_SECRET: "bad secret",
      } as const,
    },
    {
      name: "TELEGRAM_BOT_WEBHOOK_SECRET",
      overrides: {
        TELEGRAM_BOT_MODE: "webhook",
        ...botBindings(),
        TELEGRAM_BOT_WEBHOOK_SECRET: "x".repeat(257),
      } as const,
    },
  ])("fails closed when enabled bot secret $name is missing or invalid", ({ overrides }) => {
    expect(() => readRuntimeConfig(bindings(overrides))).toThrow();
  });
});
