import { z } from "@hono/zod-openapi";

export const problemDetailsSchema = z
  .object({
    type: z.url(),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    detail: z.string(),
    instance: z.string().regex(/^\//),
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    requestId: z.string().min(1),
  })
  .openapi("ProblemDetails");
