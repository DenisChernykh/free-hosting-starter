import type { MiddlewareHandler } from "hono";
import { readRuntimeConfig } from "../config/runtime-config";
import { randomBase64Url } from "../crypto/secure-values";
import type { WorkerHttpEnv } from "./environment";
import { problem } from "./problem-details";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const requestContext: MiddlewareHandler<WorkerHttpEnv> = async (c, next) => {
  const incomingRequestId = c.req.header("CF-Ray")?.split("-")[0];
  const requestId = incomingRequestId || randomBase64Url(12);
  c.set("requestId", requestId);

  const startedAt = Date.now();
  await next();

  c.header("X-Request-Id", requestId);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");

  console.log(
    JSON.stringify({
      durationMs: Date.now() - startedAt,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      requestId,
      status: c.res.status,
    }),
  );
};

export const requireTrustedOrigin: MiddlewareHandler<WorkerHttpEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) {
    await next();
    return;
  }

  const config = readRuntimeConfig(c.env);
  if (config.authMode === "disabled") {
    await next();
    return;
  }
  if (
    c.req.header("Origin") !== config.appOrigin ||
    c.req.header("Sec-Fetch-Site") === "cross-site"
  ) {
    c.res = problem(c, {
      code: "UNTRUSTED_ORIGIN",
      type: "https://free-hosting-starter.dev/problems/untrusted-origin",
      title: "Forbidden",
      status: 403,
      detail: "The request Origin does not match APP_ORIGIN.",
    });
    return;
  }

  await next();
};
