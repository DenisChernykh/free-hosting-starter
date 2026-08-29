import { D1NotesRepository } from "./infrastructure/d1-notes-repository";
import { createNotesHttp } from "./presentation/http";

export function createNotesModule() {
  return {
    router: createNotesHttp({
      createRepository: (database) => new D1NotesRepository(database),
    }),
  };
}
