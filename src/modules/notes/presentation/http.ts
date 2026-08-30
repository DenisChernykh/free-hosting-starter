import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { WorkerHttpEnv } from "../../../platform/http/environment";
import { problem } from "../../../platform/http/problem-details";
import { problemDetailsSchema } from "../../../platform/http/problem-details-schema";
import { ApplicationError } from "../../../shared/application/application-error";
import type { IdentityContextVariables } from "../../identity-access/public-contracts";
import type { NotesRepository } from "../application/ports";
import { CreateNote, DeleteNote, GetNote, ListNotes, UpdateNote } from "../application/use-cases";
import { mapNotesError, noteResourceNotFoundProblemSchema } from "./problems";

type NotesHttpEnv = WorkerHttpEnv<IdentityContextVariables>;

export type NotesHttpDependencies = {
  createRepository(database: D1Database): NotesRepository;
};

const noteSchema = z
  .object({
    id: z.uuid(),
    ownerId: z.uuid(),
    title: z.string().min(1).max(120),
    body: z.string().max(10_000),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .openapi("Note");

const requireJsonBody: MiddlewareHandler<NotesHttpEnv> = async (c, next) => {
  if (c.req.method !== "POST" && c.req.method !== "PATCH") {
    await next();
    return;
  }
  if (
    !/^application\/(?:[a-z0-9.!#$&^_-]+\+)?json(?:\s*;|$)/iu.test(
      c.req.header("Content-Type") ?? "",
    )
  ) {
    c.res = problem(c, {
      code: "UNSUPPORTED_MEDIA_TYPE",
      type: "https://free-hosting-starter.dev/problems/unsupported-media-type",
      title: "Unsupported media type",
      status: 415,
      detail: "This endpoint requires an application/json request body.",
    });
    return;
  }
  await next();
};

const limitNoteBody = bodyLimit({
  maxSize: 64 * 1024,
  onError: (c) =>
    problem(c, {
      code: "PAYLOAD_TOO_LARGE",
      type: "https://free-hosting-starter.dev/problems/content-too-large",
      title: "Content too large",
      status: 413,
      detail: "The request body exceeds the accepted size.",
    }),
});

const noteIdParameter = z.object({
  noteId: z.uuid().openapi({ param: { name: "noteId", in: "path" } }),
});
const noteInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    body: z.string().max(10_000),
  })
  .strict();
const notePatchSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    body: z.string().max(10_000).optional(),
  })
  .strict()
  .refine((input) => input.title !== undefined || input.body !== undefined, {
    message: "At least one note field is required",
  });

const commonErrors = {
  400: {
    description: "Request validation failed",
    content: { "application/problem+json": { schema: problemDetailsSchema } },
  },
  401: {
    description: "Authentication required",
    content: { "application/problem+json": { schema: problemDetailsSchema } },
  },
  403: {
    description: "Untrusted Origin",
    content: { "application/problem+json": { schema: problemDetailsSchema } },
  },
  404: {
    description: "Note not found or authentication feature disabled",
    content: { "application/problem+json": { schema: problemDetailsSchema } },
  },
  413: {
    description: "Request body is too large",
    content: { "application/problem+json": { schema: problemDetailsSchema } },
  },
  415: {
    description: "JSON Content-Type is required",
    content: { "application/problem+json": { schema: problemDetailsSchema } },
  },
  500: {
    description: "Unexpected server failure",
    content: { "application/problem+json": { schema: problemDetailsSchema } },
  },
} as const;

const noteResourceNotFound = {
  404: {
    description: "Owned note not found or authentication feature disabled",
    content: { "application/problem+json": { schema: noteResourceNotFoundProblemSchema } },
  },
} as const;

const listRoute = createRoute({
  method: "get",
  path: "/api/notes",
  tags: ["Notes"],
  security: [{ sessionCookie: [] }],
  request: {
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
  },
  responses: {
    200: {
      description: "Newest owned notes",
      content: { "application/json": { schema: z.object({ notes: z.array(noteSchema) }) } },
    },
    ...commonErrors,
  },
});

const createNoteRoute = createRoute({
  method: "post",
  path: "/api/notes",
  tags: ["Notes"],
  security: [{ sessionCookie: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: noteInputSchema } },
    },
  },
  responses: {
    201: {
      description: "Created note",
      content: { "application/json": { schema: z.object({ note: noteSchema }) } },
    },
    ...commonErrors,
  },
});

const getNoteRoute = createRoute({
  method: "get",
  path: "/api/notes/{noteId}",
  tags: ["Notes"],
  security: [{ sessionCookie: [] }],
  request: { params: noteIdParameter },
  responses: {
    200: {
      description: "Owned note",
      content: { "application/json": { schema: z.object({ note: noteSchema }) } },
    },
    ...commonErrors,
    ...noteResourceNotFound,
  },
});

const updateNoteRoute = createRoute({
  method: "patch",
  path: "/api/notes/{noteId}",
  tags: ["Notes"],
  security: [{ sessionCookie: [] }],
  request: {
    params: noteIdParameter,
    body: {
      required: true,
      content: { "application/json": { schema: notePatchSchema } },
    },
  },
  responses: {
    200: {
      description: "Updated note",
      content: { "application/json": { schema: z.object({ note: noteSchema }) } },
    },
    ...commonErrors,
    ...noteResourceNotFound,
  },
});

const deleteNoteRoute = createRoute({
  method: "delete",
  path: "/api/notes/{noteId}",
  tags: ["Notes"],
  security: [{ sessionCookie: [] }],
  request: { params: noteIdParameter },
  responses: {
    204: { description: "Owned note deleted" },
    ...commonErrors,
    ...noteResourceNotFound,
  },
});

function authenticatedOwnerId(c: {
  get(name: "authenticatedUser"): IdentityContextVariables["authenticatedUser"];
}): string {
  const user = c.get("authenticatedUser");
  if (!user) {
    throw new ApplicationError("UNAUTHENTICATED", "A valid session is required.");
  }
  return user.id;
}

export function createNotesHttp(dependencies: NotesHttpDependencies): OpenAPIHono<NotesHttpEnv> {
  const router = new OpenAPIHono<NotesHttpEnv>({
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

  router.onError((error, c) => {
    const mapped = mapNotesError(error);
    if (!mapped) {
      throw error;
    }
    return problem(c, mapped);
  });

  router.use("/api/notes", requireJsonBody);
  router.use("/api/notes/*", requireJsonBody);
  router.use("/api/notes", limitNoteBody);
  router.use("/api/notes/*", limitNoteBody);

  router.openapi(listRoute, async (c) => {
    const ownerId = authenticatedOwnerId(c);
    const repository = dependencies.createRepository(c.env.DB);
    const notes = await new ListNotes(repository).execute(ownerId, c.req.valid("query").limit);
    return c.json({ notes }, 200);
  });

  router.openapi(createNoteRoute, async (c) => {
    const ownerId = authenticatedOwnerId(c);
    const input = c.req.valid("json");
    const note = await new CreateNote(dependencies.createRepository(c.env.DB)).execute({
      ...input,
      now: Date.now(),
      ownerId,
    });
    return c.json({ note }, 201);
  });

  router.openapi(getNoteRoute, async (c) => {
    const note = await new GetNote(dependencies.createRepository(c.env.DB)).execute(
      authenticatedOwnerId(c),
      c.req.valid("param").noteId,
    );
    return c.json({ note }, 200);
  });

  router.openapi(updateNoteRoute, async (c) => {
    const note = await new UpdateNote(dependencies.createRepository(c.env.DB)).execute({
      changes: c.req.valid("json"),
      noteId: c.req.valid("param").noteId,
      now: Date.now(),
      ownerId: authenticatedOwnerId(c),
    });
    return c.json({ note }, 200);
  });

  router.openapi(deleteNoteRoute, async (c) => {
    await new DeleteNote(dependencies.createRepository(c.env.DB)).execute(
      authenticatedOwnerId(c),
      c.req.valid("param").noteId,
    );
    return c.body(null, 204);
  });

  return router;
}
