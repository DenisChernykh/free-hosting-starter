import type { Note, NoteChanges } from "./model";

export interface NotesRepository {
  create(note: Note): Promise<Note>;
  deleteOwned(noteId: string, ownerId: string): Promise<boolean>;
  findOwned(noteId: string, ownerId: string): Promise<Note | null>;
  listOwned(ownerId: string, limit: number): Promise<Note[]>;
  updateOwned(
    noteId: string,
    ownerId: string,
    changes: NoteChanges & { updatedAt: number },
  ): Promise<Note | null>;
}
