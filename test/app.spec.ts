import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src";
import type { TelegramOidcClient } from "../src/modules/identity-access";
import type {
  ExternalIdentityProfile,
  LoginFlow,
} from "../src/modules/identity-access/application/model";
import { AesGcmLoginFlowCodec } from "../src/modules/identity-access/infrastructure/aes-gcm-login-flow-codec";
import { TelegramOidcHttpClient } from "../src/modules/identity-access/infrastructure/telegram-oidc-client";

const APP_ORIGIN = "https://free-hosting-starter.example.workers.dev";
const FLOW_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const telegramBindings: CloudflareBindings = {
  ...env,
  APP_ORIGIN,
  AUTH_FLOW_SECRET: FLOW_SECRET,
  AUTH_MODE: "telegram",
  AUTH_SUCCESS_REDIRECT_URL: `${APP_ORIGIN}/api/auth/me`,
  BUILD_REVISION: "production",
  TELEGRAM_OIDC_CLIENT_ID: "123456789",
  TELEGRAM_OIDC_CLIENT_SECRET: "test-only-secret",
};

class FakeTelegramOidcClient implements TelegramOidcClient {
  buildAuthorizationUrl(input: {
    codeChallenge: string;
    nonce: string;
    redirectUri: string;
    state: string;
  }): string {
    const url = new URL("https://telegram.test/authorize");
    url.search = new URLSearchParams(input).toString();
    return url.toString();
  }

  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    nonce: string;
    now: number;
    redirectUri: string;
  }): Promise<ExternalIdentityProfile> {
    expect(input.codeVerifier).toHaveLength(43);
    expect(input.nonce).toHaveLength(43);
    expect(input.redirectUri).toBe(`${APP_ORIGIN}/api/auth/telegram/callback`);
    expect(input.now).toBeGreaterThan(0);
    return {
      issuer: "https://oauth.telegram.org",
      subject: input.code,
      displayName: `User ${input.code}`,
      username: input.code,
      photoUrl: null,
    };
  }
}

const app = createApp({
  identity: { createTelegramOidcClient: () => new FakeTelegramOidcClient() },
});

function cookieValue(response: Response, name: string): string {
  const header = response.headers.get("Set-Cookie") ?? "";
  const value = new RegExp(`(?:^|,\\s*)${name}=([^;]+)`, "u").exec(header)?.[1];
  if (!value) throw new Error(`Missing ${name} cookie in ${header}`);
  return value;
}

async function login(subject: string): Promise<string> {
  const start = await app.request(
    `${APP_ORIGIN}/api/auth/telegram/start`,
    undefined,
    telegramBindings,
  );
  expect(start.status).toBe(302);
  const flowSetCookie = start.headers.get("Set-Cookie") ?? "";
  expect(flowSetCookie).toContain("HttpOnly");
  expect(flowSetCookie).toContain("Secure");
  expect(flowSetCookie).toContain("SameSite=Lax");
  expect(flowSetCookie).toContain("Path=/");
  expect(flowSetCookie).toContain("Max-Age=600");
  expect(flowSetCookie).not.toContain("Domain=");
  const flowCookie = cookieValue(start, "__Host-telegram-flow");
  const authorizationUrl = new URL(start.headers.get("Location") ?? "");
  expect(authorizationUrl.origin).toBe("https://telegram.test");
  expect(authorizationUrl.searchParams.get("codeChallenge")).toHaveLength(43);

  const state = authorizationUrl.searchParams.get("state");
  expect(state).toBeTruthy();
  const callback = await app.request(
    `${APP_ORIGIN}/api/auth/telegram/callback?code=${subject}&state=${state}`,
    { headers: { Cookie: `__Host-telegram-flow=${flowCookie}` } },
    telegramBindings,
  );
  expect(callback.status).toBe(302);
  expect(callback.headers.get("Location")).toBe(`${APP_ORIGIN}/api/auth/me`);
  const sessionSetCookie = callback.headers.get("Set-Cookie") ?? "";
  expect(sessionSetCookie).toContain("__Host-session=");
  expect(sessionSetCookie).toContain("HttpOnly");
  expect(sessionSetCookie).toContain("Secure");
  expect(sessionSetCookie).toContain("SameSite=Lax");
  expect(sessionSetCookie).toContain("Path=/");
  expect(sessionSetCookie).toContain("Max-Age=2592000");
  expect(sessionSetCookie).not.toContain("Domain=");
  return cookieValue(callback, "__Host-session");
}

async function apiRequest(
  pathname: string,
  sessionToken: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", `__Host-session=${sessionToken}`);
  if (!["GET", "HEAD"].includes(init.method ?? "GET")) {
    headers.set("Origin", APP_ORIGIN);
  }
  return app.request(`${APP_ORIGIN}${pathname}`, { ...init, headers }, telegramBindings);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM notes"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM external_identities"),
    env.DB.prepare("DELETE FROM users"),
  ]);
});

describe("public Worker contract", () => {
  it("serves health and OpenAPI while local auth is disabled", async () => {
    const disabledBindings = { ...env, BUILD_REVISION: "local" } satisfies CloudflareBindings;
    const health = await app.request("http://localhost:8787/health", undefined, disabledBindings);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", revision: "local" });

    const specification = await app.request(
      "http://localhost:8787/openapi.json",
      undefined,
      disabledBindings,
    );
    expect(specification.status).toBe(200);
    const document = (await specification.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        "/health",
        "/api/auth/telegram/start",
        "/api/auth/telegram/callback",
        "/api/auth/me",
        "/api/auth/logout",
        "/api/notes",
        "/api/notes/{noteId}",
      ]),
    );

    const disabledAuth = await app.request(
      "http://localhost:8787/api/auth/telegram/start",
      undefined,
      disabledBindings,
    );
    expect(disabledAuth.status).toBe(404);
    const disabledLogout = await app.request(
      "http://localhost:8787/api/auth/logout",
      { method: "POST" },
      disabledBindings,
    );
    expect(disabledLogout.status).toBe(404);
  });
});

describe("Telegram session and owned Notes reference", () => {
  it("rejects a mismatched callback state without consuming the flow cookie", async () => {
    const start = await app.request(
      `${APP_ORIGIN}/api/auth/telegram/start`,
      undefined,
      telegramBindings,
    );
    const flowCookie = cookieValue(start, "__Host-telegram-flow");
    const callback = await app.request(
      `${APP_ORIGIN}/api/auth/telegram/callback?code=unused&state=${"x".repeat(43)}`,
      { headers: { Cookie: `__Host-telegram-flow=${flowCookie}` } },
      telegramBindings,
    );
    expect(callback.status).toBe(400);
    expect(callback.headers.get("Set-Cookie")).toBeNull();
  });

  it("covers login, CRUD, owner isolation, CSRF, and logout", async () => {
    const firstSession = await login("first-user");
    const me = await apiRequest("/api/auth/me", firstSession);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: { username: "first-user" } });

    const rawSessionRows = await env.DB.prepare("SELECT token_hash FROM sessions").all<{
      token_hash: string;
    }>();
    expect(rawSessionRows.results).toHaveLength(1);
    expect(rawSessionRows.results[0]?.token_hash).not.toBe(firstSession);

    const firstUser = await env.DB.prepare("SELECT id FROM users LIMIT 1").first<{
      id: string;
    }>();
    if (!firstUser) throw new Error("Expected a user after login");
    await env.DB.prepare(
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
      .bind("expired-test-token", firstUser.id, 1, 2)
      .run();

    const rejectedOrigin = await app.request(
      `${APP_ORIGIN}/api/notes`,
      {
        method: "POST",
        headers: {
          Cookie: `__Host-session=${firstSession}`,
          "Content-Type": "application/json",
          Origin: "https://attacker.example",
        },
        body: JSON.stringify({ title: "Private", body: "Body" }),
      },
      telegramBindings,
    );
    expect(rejectedOrigin.status).toBe(403);

    const missingContentType = await apiRequest("/api/notes", firstSession, {
      method: "POST",
      body: JSON.stringify({ title: "Private", body: "Body" }),
    });
    expect(missingContentType.status).toBe(415);

    const oversizedJson = JSON.stringify({ title: "Large", body: "x".repeat(70 * 1024) });
    const oversizedRequest = new Request(`${APP_ORIGIN}/api/notes`, {
      method: "POST",
      headers: {
        Cookie: `__Host-session=${firstSession}`,
        "Content-Type": "application/json",
        Origin: APP_ORIGIN,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversizedJson));
          controller.close();
        },
      }),
    });
    const oversized = await app.fetch(oversizedRequest, telegramBindings);
    expect(oversized.status).toBe(413);

    const created = await apiRequest("/api/notes", firstSession, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "  MVP note  ", body: "Body" }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { note: { id: string; title: string } };
    expect(createdBody.note.title).toBe("MVP note");

    const listed = await apiRequest("/api/notes?limit=10", firstSession);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ notes: [{ id: createdBody.note.id }] });

    const secondSession = await login("second-user");
    const expiredSession = await env.DB.prepare(
      "SELECT token_hash FROM sessions WHERE token_hash = ?",
    )
      .bind("expired-test-token")
      .first();
    expect(expiredSession).toBeNull();
    const hiddenFromOtherOwner = await apiRequest(
      `/api/notes/${createdBody.note.id}`,
      secondSession,
    );
    expect(hiddenFromOtherOwner.status).toBe(404);

    const updated = await apiRequest(`/api/notes/${createdBody.note.id}`, firstSession, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Updated" }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ note: { body: "Updated" } });

    const deleted = await apiRequest(`/api/notes/${createdBody.note.id}`, firstSession, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);

    const logout = await apiRequest("/api/auth/logout", firstSession, { method: "POST" });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("Set-Cookie")).toContain("__Host-session=");
    const rejectedSession = await apiRequest("/api/auth/me", firstSession);
    expect(rejectedSession.status).toBe(401);
  });
});

describe("production Telegram OIDC adapter", () => {
  it("accepts a valid RS256 token and rejects one without exp", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    Object.assign(jwk, { alg: "RS256", kid: "test-key", use: "sig" });
    const now = Math.floor(Date.now() / 1000);
    const signToken = (includeExpiration: boolean) => {
      let token = new SignJWT({
        nonce: "expected-nonce",
        name: "Telegram User",
        preferred_username: "telegram_user",
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer("https://oauth.telegram.org")
        .setAudience("123456789")
        .setSubject("telegram-subject")
        .setIssuedAt(now);
      if (includeExpiration) {
        token = token.setExpirationTime(now + 60);
      }
      return token.sign(privateKey);
    };
    let idToken = await signToken(true);

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "https://oauth.telegram.org/token") {
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("Authorization")).toMatch(/^Basic /u);
        return Response.json({ id_token: idToken });
      }
      if (url === "https://oauth.telegram.org/.well-known/jwks.json") {
        return Response.json({ keys: [jwk] });
      }
      throw new Error(`Unexpected test request to ${url}`);
    });

    try {
      const client = new TelegramOidcHttpClient("123456789", "client-secret");
      const input = {
        code: "authorization-code",
        codeVerifier: "v".repeat(43),
        nonce: "expected-nonce",
        now: now * 1000,
        redirectUri: `${APP_ORIGIN}/api/auth/telegram/callback`,
      };
      await expect(client.exchangeCode(input)).resolves.toMatchObject({
        issuer: "https://oauth.telegram.org",
        subject: "telegram-subject",
        username: "telegram_user",
      });

      idToken = await signToken(false);
      await expect(client.exchangeCode(input)).rejects.toMatchObject({
        code: "DEPENDENCY_UNAVAILABLE",
      });
      expect(warning).toHaveBeenCalledOnce();
      const diagnostic = String(warning.mock.calls[0]?.[0]);
      expect(JSON.parse(diagnostic)).toEqual({
        event: "telegram_oidc_exchange_failed",
        providerStatus: 200,
        stage: "claims",
      });
      expect(diagnostic).not.toContain("authorization-code");
      expect(diagnostic).not.toContain("client-secret");
      expect(diagnostic).not.toContain(idToken);
    } finally {
      warning.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe("encrypted login flow", () => {
  it("uses a fresh IV and rejects tampering or another key", async () => {
    const flow: LoginFlow = {
      version: 1,
      issuer: "https://oauth.telegram.org",
      clientId: "123456789",
      redirectUri: `${APP_ORIGIN}/api/auth/telegram/callback`,
      state: "s".repeat(43),
      nonce: "n".repeat(43),
      codeVerifier: "v".repeat(43),
      issuedAt: 1,
    };
    const codec = new AesGcmLoginFlowCodec(FLOW_SECRET);
    const [first, second] = await Promise.all([codec.seal(flow), codec.seal(flow)]);
    expect(first).not.toBe(second);
    await expect(codec.open(first)).resolves.toEqual(flow);

    const [version, iv, ciphertext] = first.split(".") as [string, string, string];
    const tamperedCiphertext = `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`;
    const tampered = `${version}.${iv}.${tamperedCiphertext}`;
    await expect(codec.open(tampered)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const anotherSecret = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
    await expect(new AesGcmLoginFlowCodec(anotherSecret).open(first)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });
});
