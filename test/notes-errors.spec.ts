import { describe, expect, it } from "vitest";
import {
  NoteBodyTooLongError,
  NoteNotFoundError,
  NotePatchEmptyError,
  NotesLimitInvalidError,
  NoteTitleInvalidError,
} from "../src/modules/notes/application/errors";
import type { NotesRepository } from "../src/modules/notes/application/ports";
import {
  CreateNote,
  DeleteNote,
  GetNote,
  ListNotes,
  UpdateNote,
} from "../src/modules/notes/application/use-cases";
import { mapNotesError } from "../src/modules/notes/presentation/problems";

const missingRepository: NotesRepository = {
  create: async (note) => note,
  deleteOwned: async () => false,
  findOwned: async () => null,
  listOwned: async () => [],
  updateOwned: async () => null,
};

describe("Notes application errors", () => {
  it("uses module-owned errors for every application invariant", async () => {
    expect(() =>
      new CreateNote(missingRepository).execute({
        body: "Body",
        now: 1,
        ownerId: "owner",
        title: " ",
      }),
    ).toThrowError(NoteTitleInvalidError);
    expect(() =>
      new CreateNote(missingRepository).execute({
        body: "x".repeat(10_001),
        now: 1,
        ownerId: "owner",
        title: "Title",
      }),
    ).toThrowError(NoteBodyTooLongError);
    expect(() => new ListNotes(missingRepository).execute("owner", 101)).toThrowError(
      NotesLimitInvalidError,
    );
    await expect(
      new UpdateNote(missingRepository).execute({
        changes: {},
        noteId: "note",
        now: 1,
        ownerId: "owner",
      }),
    ).rejects.toBeInstanceOf(NotePatchEmptyError);
    await expect(new GetNote(missingRepository).execute("owner", "note")).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );
    await expect(
      new UpdateNote(missingRepository).execute({
        changes: { body: "Updated" },
        noteId: "note",
        now: 1,
        ownerId: "owner",
      }),
    ).rejects.toBeInstanceOf(NoteNotFoundError);
    await expect(new DeleteNote(missingRepository).execute("owner", "note")).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );
  });

  it.each([
    [
      new NoteBodyTooLongError(),
      {
        code: "NOTE_BODY_TOO_LONG",
        detail: "Note body must not exceed 10000 characters.",
        status: 400,
        title: "Note body is too long",
        type: "https://free-hosting-starter.dev/problems/note-body-too-long",
      },
    ],
    [
      new NoteNotFoundError(),
      {
        code: "NOTE_NOT_FOUND",
        detail: "The note was not found.",
        status: 404,
        title: "Note not found",
        type: "https://free-hosting-starter.dev/problems/note-not-found",
      },
    ],
    [
      new NotePatchEmptyError(),
      {
        code: "NOTE_PATCH_EMPTY",
        detail: "At least one note field is required.",
        status: 400,
        title: "Note update is empty",
        type: "https://free-hosting-starter.dev/problems/note-patch-empty",
      },
    ],
    [
      new NoteTitleInvalidError(),
      {
        code: "NOTE_TITLE_INVALID",
        detail: "Note title must contain 1 to 120 characters.",
        status: 400,
        title: "Note title is invalid",
        type: "https://free-hosting-starter.dev/problems/note-title-invalid",
      },
    ],
    [
      new NotesLimitInvalidError(),
      {
        code: "NOTES_LIMIT_INVALID",
        detail: "Notes limit must be an integer from 1 to 100.",
        status: 400,
        title: "Notes limit is invalid",
        type: "https://free-hosting-starter.dev/problems/notes-limit-invalid",
      },
    ],
  ])("maps $expected.code to fixed public metadata", (error, expected) => {
    expect(mapNotesError(error)).toEqual(expected);
    expect(mapNotesError(error)?.detail).not.toBe(error.message);
  });

  it("does not map errors owned by another boundary", () => {
    expect(mapNotesError(new Error("sensitive repository failure"))).toBeUndefined();
  });
});
