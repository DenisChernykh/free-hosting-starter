import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { TelegramRuntimeConfig } from "../../../platform/config/runtime-config";
import { readRuntimeConfig } from "../../../platform/config/runtime-config";
import type { WorkerHttpEnv } from "../../../platform/http/environment";
import { applicationErrorToResponse, problem } from "../../../platform/http/problem-details";
import { problemDetailsSchema } from "../../../platform/http/problem-details-schema";
import { ApplicationError } from "../../../shared/application/application-error";
import type {
  IdentitySessionRepository,
  LoginFlowCodec,
  TelegramOidcClient,
} from "../application/ports";
import {
  AuthenticateSession,
  CompleteTelegramLogin,
  FindDevelopmentSession,
  Logout,
  StartDevelopmentSession,
  StartTelegramLogin,
  ValidateTelegramLoginFlow,
} from "../application/use-cases";
import {
  type AuthenticatedUser,
  type IdentityContextVariables,
  SESSION_COOKIE_NAME,
} from "../public-contracts";

const FLOW_COOKIE_NAME = "__Host-telegram-flow";
const CALLBACK_PATH = "/api/auth/telegram/callback";
const FLOW_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

type IdentityHttpEnv = WorkerHttpEnv<IdentityContextVariables>;

export type IdentityHttpDependencies = {
  createFlowCodec(secret: string): LoginFlowCodec;
  createOidcClient(config: TelegramRuntimeConfig): TelegramOidcClient;
  createRepository(database: D1Database): IdentitySessionRepository;
};

const userSchema = z
  .object({
    id: z.uuid(),
    displayName: z.string().nullable(),
    username: z.string().nullable(),
    photoUrl: z.url().nullable(),
  })
  .openapi("AuthenticatedUser");

const internalErrorResponse = {
  500: {
    description: "Unexpected server failure",
    content: { "application/problem+json": { schema: problemDetailsSchema } },
  },
} as const;

const startRoute = createRoute({
  method: "get",
  path: "/api/auth/telegram/start",
  tags: ["Authentication"],
  responses: {
    302: { description: "Redirect to Telegram authorization" },
    404: {
      description: "Telegram authentication is disabled",
      content: { "application/problem+json": { schema: problemDetailsSchema } },
    },
    ...internalErrorResponse,
  },
});

const callbackRoute = createRoute({
  method: "get",
  path: CALLBACK_PATH,
  tags: ["Authentication"],
  request: {
    query: z
      .object({
        code: z.string().min(1).max(4096).optional(),
        error: z.string().min(1).max(256).optional(),
        error_description: z.string().max(1024).optional(),
        state: z.string().min(1).max(256),
      })
      .strict(),
  },
  responses: {
    302: { description: "Session created; redirect to configured success URL" },
    400: {
      description: "Invalid or declined login flow",
      content: { "application/problem+json": { schema: problemDetailsSchema } },
    },
    404: {
      description: "Telegram authentication is disabled",
      content: { "application/problem+json": { schema: problemDetailsSchema } },
    },
    503: {
      description: "Telegram is unavailable or returned an invalid token",
      content: { "application/problem+json": { schema: problemDetailsSchema } },
    },
    ...internalErrorResponse,
  },
});

const meRoute = createRoute({
  method: "get",
  path: "/api/auth/me",
  tags: ["Authentication"],
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      description: "Current authenticated user",
      content: { "application/json": { schema: z.object({ user: userSchema }) } },
    },
    401: {
      description: "Missing, expired, or invalid session",
      content: { "application/problem+json": { schema: problemDetailsSchema } },
    },
    404: {
      description: "Telegram authentication is disabled",
      content: { "application/problem+json": { schema: problemDetailsSchema } },
    },
    ...internalErrorResponse,
  },
});

const logoutRoute = createRoute({
  method: "post",
  path: "/api/auth/logout",
  tags: ["Authentication"],
  responses: {
    204: { description: "Session revoked when present" },
    403: {
      description: "Untrusted Origin",
      content: { "application/problem+json": { schema: problemDetailsSchema } },
    },
    404: {
      description: "Telegram authentication is disabled",
      content: { "application/problem+json": { schema: problemDetailsSchema } },
    },
    ...internalErrorResponse,
  },
});

function telegramConfig(env: CloudflareBindings): TelegramRuntimeConfig | null {
  const config = readRuntimeConfig(env);
  return config.authMode === "telegram" ? config : null;
}

function callbackUrl(config: TelegramRuntimeConfig): string {
  return new URL(CALLBACK_PATH, config.appOrigin).toString();
}

function isLocalDevelopmentRequest(requestUrl: string, appOrigin: string): boolean {
  return new URL(requestUrl).origin === appOrigin;
}

function setPrivateResponseHeaders(c: { header(name: string, value: string): void }): void {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
}

function setFlowCookie(c: Parameters<typeof setCookie>[0], value: string): void {
  setCookie(c, FLOW_COOKIE_NAME, value, {
    httpOnly: true,
    maxAge: FLOW_TTL_SECONDS,
    path: "/",
    sameSite: "Lax",
    secure: true,
  });
}

function clearFlowCookie(c: Parameters<typeof deleteCookie>[0]): void {
  deleteCookie(c, FLOW_COOKIE_NAME, { path: "/", secure: true });
}

function setSessionCookie(c: Parameters<typeof setCookie>[0], value: string): void {
  setCookie(c, SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
    sameSite: "Lax",
    secure: true,
  });
}

function clearSessionCookie(c: Parameters<typeof deleteCookie>[0]): void {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/", secure: true });
}

function assertStrictCallbackQuery(url: URL): {
  code?: string;
  error?: string;
  state: string;
} {
  const allowed = new Set(["code", "error", "error_description", "state"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new ApplicationError("INVALID_REQUEST", "The callback query is invalid.");
    }
  }
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");
  if (!state || state.length > 256 || Boolean(code) === Boolean(oauthError)) {
    throw new ApplicationError("INVALID_REQUEST", "The callback query is invalid.");
  }
  if ((code?.length ?? 0) > 4096 || (oauthError?.length ?? 0) > 256) {
    throw new ApplicationError("INVALID_REQUEST", "The callback query is invalid.");
  }
  return { code: code ?? undefined, error: oauthError ?? undefined, state };
}

export function createIdentityHttp(dependencies: IdentityHttpDependencies): {
  authentication: MiddlewareHandler<IdentityHttpEnv>;
  router: OpenAPIHono<IdentityHttpEnv>;
} {
  const router = new OpenAPIHono<IdentityHttpEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return problem(c, {
          code: "VALIDATION_FAILED",
          type: "https://free-hosting-starter.dev/problems/validation-error",
          title: "Validation failed",
          status: 400,
          detail: "The request does not match the API contract.",
        });
      }
    },
  });

  const authentication: MiddlewareHandler<IdentityHttpEnv> = async (c, next) => {
    if (c.get("authenticatedUser")) {
      await next();
      return;
    }

    const config = readRuntimeConfig(c.env);
    if (
      config.authMode === "disabled" ||
      (config.authMode === "development" && !isLocalDevelopmentRequest(c.req.url, config.appOrigin))
    ) {
      c.res = problem(c, {
        code: "NOT_FOUND",
        type: "https://free-hosting-starter.dev/problems/not-found",
        title: "Not found",
        status: 404,
        detail: "The requested resource was not found.",
      });
      return;
    }

    const sessionToken = getCookie(c, SESSION_COOKIE_NAME);
    const repository = dependencies.createRepository(c.env.DB);

    if (config.authMode === "development") {
      let user: AuthenticatedUser | null = null;
      if (sessionToken) {
        user = await new FindDevelopmentSession(repository).execute({
          now: Date.now(),
          sessionToken,
        });
        if (!user) {
          clearSessionCookie(c);
        }
      }

      if (!user) {
        const developmentSession = await new StartDevelopmentSession(repository).execute(
          Date.now(),
        );
        user = developmentSession.user;
        setSessionCookie(c, developmentSession.sessionToken);
      }

      c.set("authenticatedUser", user);
      setPrivateResponseHeaders(c);
      await next();
      return;
    }

    if (!sessionToken) {
      c.res = applicationErrorToResponse(
        c,
        new ApplicationError("UNAUTHENTICATED", "A valid session is required."),
      );
      return;
    }

    try {
      const user = await new AuthenticateSession(repository).execute({
        now: Date.now(),
        sessionToken,
      });
      c.set("authenticatedUser", user);
      setPrivateResponseHeaders(c);
      await next();
    } catch (error) {
      clearSessionCookie(c);
      if (error instanceof ApplicationError) {
        c.res = applicationErrorToResponse(c, error);
        return;
      }
      throw error;
    }
  };

  router.openapi(startRoute, async (c) => {
    const config = telegramConfig(c.env);
    if (!config) {
      return problem(c, {
        code: "NOT_FOUND",
        type: "https://free-hosting-starter.dev/problems/not-found",
        title: "Not found",
        status: 404,
        detail: "The requested resource was not found.",
      });
    }
    const flowCodec = dependencies.createFlowCodec(config.authFlowSecret);
    const oidcClient = dependencies.createOidcClient(config);
    const result = await new StartTelegramLogin(oidcClient, flowCodec).execute({
      clientId: config.telegramClientId,
      now: Date.now(),
      redirectUri: callbackUrl(config),
    });
    setPrivateResponseHeaders(c);
    setFlowCookie(c, result.flowCookie);
    return c.redirect(result.authorizationUrl, 302);
  });

  router.openapi(callbackRoute, async (c) => {
    const config = telegramConfig(c.env);
    if (!config) {
      return problem(c, {
        code: "NOT_FOUND",
        type: "https://free-hosting-starter.dev/problems/not-found",
        title: "Not found",
        status: 404,
        detail: "The requested resource was not found.",
      });
    }
    setPrivateResponseHeaders(c);
    const query = assertStrictCallbackQuery(new URL(c.req.url));
    const flowCookie = getCookie(c, FLOW_COOKIE_NAME);
    if (!flowCookie) {
      throw new ApplicationError("INVALID_REQUEST", "The Telegram login flow is missing.");
    }

    const redirectUri = callbackUrl(config);
    const flowCodec = dependencies.createFlowCodec(config.authFlowSecret);
    const flow = await new ValidateTelegramLoginFlow(flowCodec).execute({
      clientId: config.telegramClientId,
      flowCookie,
      now: Date.now(),
      redirectUri,
      state: query.state,
    });

    try {
      if (query.error || !query.code) {
        throw new ApplicationError("INVALID_REQUEST", "Telegram login was declined.");
      }
      const result = await new CompleteTelegramLogin(
        dependencies.createOidcClient(config),
        dependencies.createRepository(c.env.DB),
      ).execute({ code: query.code, flow, now: Date.now(), redirectUri });
      setSessionCookie(c, result.sessionToken);
      return c.redirect(config.authSuccessRedirectUrl, 302);
    } finally {
      clearFlowCookie(c);
    }
  });

  router.use(meRoute.getRoutingPath(), authentication);
  router.openapi(meRoute, (c) => {
    const user = c.get("authenticatedUser");
    if (!user) {
      throw new ApplicationError("UNAUTHENTICATED", "A valid session is required.");
    }
    return c.json({ user }, 200);
  });

  router.openapi(logoutRoute, async (c) => {
    const config = readRuntimeConfig(c.env);
    if (
      config.authMode === "disabled" ||
      (config.authMode === "development" && !isLocalDevelopmentRequest(c.req.url, config.appOrigin))
    ) {
      return problem(c, {
        code: "NOT_FOUND",
        type: "https://free-hosting-starter.dev/problems/not-found",
        title: "Not found",
        status: 404,
        detail: "The requested resource was not found.",
      });
    }
    await new Logout(dependencies.createRepository(c.env.DB)).execute(
      getCookie(c, SESSION_COOKIE_NAME),
    );
    clearSessionCookie(c);
    setPrivateResponseHeaders(c);
    return c.body(null, 204);
  });

  return { authentication, router };
}
