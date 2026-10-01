import {
  anchorLine,
  replaceAnchorLine,
  setFrontmatterValue,
} from "../lib/note.ts";

type NoteIo = {
  readNote(path: string): Promise<string>;
  writeNote(path: string, content: string): Promise<void>;
};

/** `updateNote`, `updateLine` and `setFrontmatter` for an Obsidian fake, built on the
 *  fake's own `readNote` and `writeNote` so their calls still show up where a test records
 *  them. Same contract as the real client: `fn` gets the live note, and nothing is written
 *  unless it calls `write` with new text. `io` is a getter so a fake can spread this into
 *  itself; `onLock` runs each time an update takes the note lock. */
export function noteOps(io: () => NoteIo, onLock: () => void = () => {}) {
  const updateNote = async <T>(
    path: string,
    fn: (note: string, write: (next: string) => void) => T | Promise<T>,
  ): Promise<T> => {
    onLock();
    const note = await io().readNote(path);
    let next = note;
    const result = await fn(note, (text) => {
      next = text;
    });
    if (next !== note) await io().writeNote(path, next);
    return result;
  };
  const updateLine = async <T>(
    path: string,
    anchor: string,
    fn: (line: string, write: (next: string) => void) => T | Promise<T>,
  ): Promise<T | null> =>
    updateNote(path, (note, write) => {
      const line = anchorLine(note, anchor);
      if (line === null) return null;
      return fn(line, (next) => write(replaceAnchorLine(note, anchor, next)!));
    });
  const setFrontmatter = async (
    path: string,
    key: string,
    value: string | number,
  ) =>
    updateNote(path, (note, write) =>
      write(setFrontmatterValue(note, key, value)),
    );
  return { updateNote, updateLine, setFrontmatter };
}
