import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  createIdentityAccessModule,
  type IdentityAccessModuleOptions,
} from "../modules/identity-access";
import type { IdentityContextVariables } from "../modules/identity-access/public-contracts";
import { createNotesModule } from "../modules/notes";
import {
  createTelegramBotModule,
  TELEGRAM_WEBHOOK_SECURITY_SCHEME,
  type TelegramBotModuleOptions,
} from "../modules/telegram-bot";
import { readRuntimeConfig } from "../platform/config/runtime-config";
import type { WorkerHttpEnv } from "../platform/http/environment";
import { applicationErrorToResponse, problem } from "../platform/http/problem-details";
import { problemDetailsSchema } from "../platform/http/problem-details-schema";
import { requestContext, requireTrustedOrigin } from "../platform/http/request-pipeline";
import { ApplicationError } from "../shared/application/application-error";

type AppEnv = WorkerHttpEnv<IdentityContextVariables>;

export type AppOptions = {
  identity?: IdentityAccessModuleOptions;
  telegramBot?: TelegramBotModuleOptions;
};

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["System"],
  responses: {
    200: {
      description: "Worker is available; D1 is intentionally not queried",
      content: {
        "application/json": {
          schema: z.object({ status: z.literal("ok"), revision: z.string() }),
        },
      },
    },
    500: {
      description: "Unexpected server failure",
      content: { "application/problem+json": { schema: problemDetailsSchema } },
    },
  },
});

export function createApp(options: AppOptions = {}): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();
  const identity = createIdentityAccessModule(options.identity);
  const notes = createNotesModule();
  const telegramBot = createTelegramBotModule(options.telegramBot);

  app.use("*", requestContext);
  app.use("/api/*", requireTrustedOrigin);

  app.openapi(healthRoute, (c) => {
    const config = readRuntimeConfig(c.env);
    return c.json({ status: "ok" as const, revision: config.buildRevision }, 200);
  });

  app.route("/", identity.router);
  app.route("/", telegramBot.router);
  app.use("/api/notes", identity.authentication);
  app.use("/api/notes/*", identity.authentication);
  app.route("/", notes.router);

  app.openAPIRegistry.registerComponent("securitySchemes", "sessionCookie", {
    type: "apiKey",
    in: "cookie",
    name: "__Host-session",
  });

  app.openAPIRegistry.registerComponent("securitySchemes", TELEGRAM_WEBHOOK_SECURITY_SCHEME, {
    type: "apiKey",
    in: "header",
    name: "X-Telegram-Bot-Api-Secret-Token",
  });

  app.get("/openapi.json", (c) =>
    c.json(
      app.getOpenAPI31Document({
        openapi: "3.1.0",
        info: {
          title: "Free Hosting Starter API",
          version: "0.1.0",
          description: "Cloudflare Workers and D1 starter for small MVP APIs.",
        },
      }),
    ),
  );

  app.notFound((c) =>
    problem(c, {
      code: "NOT_FOUND",
      type: "https://free-hosting-starter.dev/problems/not-found",
      title: "Not found",
      status: 404,
      detail: "The requested resource was not found.",
    }),
  );

  app.onError((error, c) => {
    if (error instanceof ApplicationError) {
      return applicationErrorToResponse(c, error);
    }

    console.error(
      JSON.stringify({
        error: error.name,
        event: "unhandled_request_error",
        path: new URL(c.req.url).pathname,
        requestId: c.get("requestId"),
      }),
    );
    return problem(c, {
      code: "INTERNAL_ERROR",
      type: "https://free-hosting-starter.dev/problems/internal-server-error",
      title: "Internal server error",
      status: 500,
      detail: "The request could not be completed.",
    });
  });

  return app;
}
