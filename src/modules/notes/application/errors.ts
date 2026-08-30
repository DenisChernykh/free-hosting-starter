export type NotesErrorCode =
  | "NOTE_BODY_TOO_LONG"
  | "NOTE_NOT_FOUND"
  | "NOTE_PATCH_EMPTY"
  | "NOTE_TITLE_INVALID"
  | "NOTES_LIMIT_INVALID";

export abstract class NotesError extends Error {
  abstract readonly code: NotesErrorCode;

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class NoteNotFoundError extends NotesError {
  readonly code = "NOTE_NOT_FOUND";

  constructor() {
    super("An owned note lookup did not return a row.");
    this.name = "NoteNotFoundError";
  }
}

export class NoteTitleInvalidError extends NotesError {
  readonly code = "NOTE_TITLE_INVALID";

  constructor() {
    super("A note title violated its length invariant.");
    this.name = "NoteTitleInvalidError";
  }
}

export class NoteBodyTooLongError extends NotesError {
  readonly code = "NOTE_BODY_TOO_LONG";

  constructor() {
    super("A note body violated its length invariant.");
    this.name = "NoteBodyTooLongError";
  }
}

export class NotesLimitInvalidError extends NotesError {
  readonly code = "NOTES_LIMIT_INVALID";

  constructor() {
    super("The requested notes page size is outside its invariant.");
    this.name = "NotesLimitInvalidError";
  }
}

export class NotePatchEmptyError extends NotesError {
  readonly code = "NOTE_PATCH_EMPTY";

  constructor() {
    super("A note update did not contain any changes.");
    this.name = "NotePatchEmptyError";
  }
}
