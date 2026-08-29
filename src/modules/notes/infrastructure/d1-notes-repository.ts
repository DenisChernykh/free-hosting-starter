import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { notes } from "../../../platform/database/schema";
import type { Note, NoteChanges } from "../application/model";
import type { NotesRepository } from "../application/ports";

export class D1NotesRepository implements NotesRepository {
  private readonly database;

  constructor(binding: D1Database) {
    this.database = drizzle(binding);
  }

  async create(note: Note): Promise<Note> {
    await this.database.insert(notes).values(note);
    return note;
  }

  async deleteOwned(noteId: string, ownerId: string): Promise<boolean> {
    const deleted = await this.database
      .delete(notes)
      .where(and(eq(notes.id, noteId), eq(notes.ownerId, ownerId)))
      .returning({ id: notes.id });
    return deleted.length === 1;
  }

  async findOwned(noteId: string, ownerId: string): Promise<Note | null> {
    const [note] = await this.database
      .select()
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.ownerId, ownerId)))
      .limit(1);
    return note ?? null;
  }

  listOwned(ownerId: string, limit: number): Promise<Note[]> {
    return this.database
      .select()
      .from(notes)
      .where(eq(notes.ownerId, ownerId))
      .orderBy(desc(notes.updatedAt), desc(notes.id))
      .limit(limit);
  }

  async updateOwned(
    noteId: string,
    ownerId: string,
    changes: NoteChanges & { updatedAt: number },
  ): Promise<Note | null> {
    const [updated] = await this.database
      .update(notes)
      .set(changes)
      .where(and(eq(notes.id, noteId), eq(notes.ownerId, ownerId)))
      .returning();
    return updated ?? null;
  }
}
