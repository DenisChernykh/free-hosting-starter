import {
  NoteBodyTooLongError,
  NoteNotFoundError,
  NotePatchEmptyError,
  NotesLimitInvalidError,
  NoteTitleInvalidError,
} from "./errors";
import type { Note, NoteChanges } from "./model";
import type { NotesRepository } from "./ports";

function requireNote(note: Note | null): Note {
  if (!note) {
    throw new NoteNotFoundError();
  }
  return note;
}

function normalizeTitle(title: string): string {
  const normalized = title.trim();
  if (normalized.length < 1 || normalized.length > 120) {
    throw new NoteTitleInvalidError();
  }
  return normalized;
}

function requireValidBody(body: string): string {
  if (body.length > 10_000) {
    throw new NoteBodyTooLongError();
  }
  return body;
}

export class CreateNote {
  constructor(private readonly repository: NotesRepository) {}

  execute(input: { body: string; now: number; ownerId: string; title: string }): Promise<Note> {
    return this.repository.create({
      id: crypto.randomUUID(),
      ownerId: input.ownerId,
      title: normalizeTitle(input.title),
      body: requireValidBody(input.body),
      createdAt: input.now,
      updatedAt: input.now,
    });
  }
}

export class ListNotes {
  constructor(private readonly repository: NotesRepository) {}

  execute(ownerId: string, limit: number): Promise<Note[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new NotesLimitInvalidError();
    }
    return this.repository.listOwned(ownerId, limit);
  }
}

export class GetNote {
  constructor(private readonly repository: NotesRepository) {}

  async execute(ownerId: string, noteId: string): Promise<Note> {
    return requireNote(await this.repository.findOwned(noteId, ownerId));
  }
}

export class UpdateNote {
  constructor(private readonly repository: NotesRepository) {}

  async execute(input: {
    changes: NoteChanges;
    noteId: string;
    now: number;
    ownerId: string;
  }): Promise<Note> {
    if (input.changes.title === undefined && input.changes.body === undefined) {
      throw new NotePatchEmptyError();
    }
    const changes: NoteChanges = { ...input.changes };
    if (changes.title !== undefined) {
      changes.title = normalizeTitle(changes.title);
    }
    if (changes.body !== undefined) {
      changes.body = requireValidBody(changes.body);
    }
    return requireNote(
      await this.repository.updateOwned(input.noteId, input.ownerId, {
        ...changes,
        updatedAt: input.now,
      }),
    );
  }
}

export class DeleteNote {
  constructor(private readonly repository: NotesRepository) {}

  async execute(ownerId: string, noteId: string): Promise<void> {
    if (!(await this.repository.deleteOwned(noteId, ownerId))) {
      throw new NoteNotFoundError();
    }
  }
}
