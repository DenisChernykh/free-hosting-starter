import type { Context } from "hono";
import { problem } from "../../../platform/http/problem-details";

export function telegramWebhookNotFound(c: Context): Response {
  return problem(c, {
    code: "NOT_FOUND",
    type: "https://free-hosting-starter.dev/problems/not-found",
    title: "Not found",
    status: 404,
    detail: "The requested resource was not found.",
  });
}

export function telegramWebhookUnauthorized(c: Context): Response {
  return problem(c, {
    code: "UNAUTHENTICATED",
    type: "https://free-hosting-starter.dev/problems/unauthenticated",
    title: "Unauthenticated",
    status: 401,
    detail: "The webhook request is not authorized.",
  });
}

export function telegramWebhookUnsupportedMediaType(c: Context): Response {
  return problem(c, {
    code: "UNSUPPORTED_MEDIA_TYPE",
    type: "https://free-hosting-starter.dev/problems/unsupported-media-type",
    title: "Unsupported media type",
    status: 415,
    detail: "This endpoint requires an application/json request body.",
  });
}

export function telegramWebhookInvalidBody(c: Context): Response {
  return problem(c, {
    code: "VALIDATION_FAILED",
    type: "https://free-hosting-starter.dev/problems/validation-error",
    title: "Validation failed",
    status: 400,
    detail: "The request does not match the Telegram webhook contract.",
  });
}
