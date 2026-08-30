import { z } from "@hono/zod-openapi";
import type { ProblemInput } from "../../../platform/http/problem-details";
import { problemDetailsSchema } from "../../../platform/http/problem-details-schema";
import { NotesError, type NotesErrorCode } from "../application/errors";

const NOTE_PROBLEMS = {
  NOTE_BODY_TOO_LONG: {
    code: "NOTE_BODY_TOO_LONG",
    detail: "Note body must not exceed 10000 characters.",
    status: 400,
    title: "Note body is too long",
    type: "https://free-hosting-starter.dev/problems/note-body-too-long",
  },
  NOTE_NOT_FOUND: {
    code: "NOTE_NOT_FOUND",
    detail: "The note was not found.",
    status: 404,
    title: "Note not found",
    type: "https://free-hosting-starter.dev/problems/note-not-found",
  },
  NOTE_PATCH_EMPTY: {
    code: "NOTE_PATCH_EMPTY",
    detail: "At least one note field is required.",
    status: 400,
    title: "Note update is empty",
    type: "https://free-hosting-starter.dev/problems/note-patch-empty",
  },
  NOTE_TITLE_INVALID: {
    code: "NOTE_TITLE_INVALID",
    detail: "Note title must contain 1 to 120 characters.",
    status: 400,
    title: "Note title is invalid",
    type: "https://free-hosting-starter.dev/problems/note-title-invalid",
  },
  NOTES_LIMIT_INVALID: {
    code: "NOTES_LIMIT_INVALID",
    detail: "Notes limit must be an integer from 1 to 100.",
    status: 400,
    title: "Notes limit is invalid",
    type: "https://free-hosting-starter.dev/problems/notes-limit-invalid",
  },
} as const satisfies Record<NotesErrorCode, ProblemInput>;

const noteNotFoundProblem = NOTE_PROBLEMS.NOTE_NOT_FOUND;
const featureDisabledProblem = {
  code: "NOT_FOUND",
  detail: "The requested resource was not found.",
  status: 404,
  title: "Not found",
  type: "https://free-hosting-starter.dev/problems/not-found",
} as const satisfies ProblemInput;

const noteNotFoundProblemSchema = problemDetailsSchema
  .extend({
    type: z.literal(noteNotFoundProblem.type),
    title: z.literal(noteNotFoundProblem.title),
    status: z.literal(noteNotFoundProblem.status),
    detail: z.literal(noteNotFoundProblem.detail),
    code: z.literal(noteNotFoundProblem.code),
  })
  .openapi("NoteNotFoundProblemDetails");

const featureDisabledProblemSchema = problemDetailsSchema
  .extend({
    type: z.literal(featureDisabledProblem.type),
    title: z.literal(featureDisabledProblem.title),
    status: z.literal(featureDisabledProblem.status),
    detail: z.literal(featureDisabledProblem.detail),
    code: z.literal(featureDisabledProblem.code),
  })
  .openapi("NotesFeatureDisabledProblemDetails");

export const noteResourceNotFoundProblemSchema = z
  .union([noteNotFoundProblemSchema, featureDisabledProblemSchema])
  .openapi("NotesResourceNotFoundProblemDetails");

export function mapNotesError(error: unknown): ProblemInput | undefined {
  if (!(error instanceof NotesError)) {
    return undefined;
  }
  return NOTE_PROBLEMS[error.code];
}
