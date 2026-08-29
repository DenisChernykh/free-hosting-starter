export type Note = {
  id: string;
  ownerId: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
};

export type NoteChanges = {
  title?: string;
  body?: string;
};
