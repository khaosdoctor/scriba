import type { Task, TaskDraft, TaskType } from "../../domain/task/entity.ts";
import { logger } from "../../libs/log.ts";
import { setFrontmatterValue } from "../../libs/note.ts";
import {
  completeTaskLine,
  insertTaskLine,
  parseTaskLine,
  parseTasks,
  renderTaskLine,
  replaceTaskLineAt,
  uncompleteTaskLine,
} from "../../libs/tasks.ts";
import { plainDate } from "../../libs/time.ts";
import type { ObsidianClient } from "./notes.ts";

const log = logger("tasks");

export interface TaskNoteConfig {
  path: string;
  heading: string;
  tag: string;
  insert: "top" | "bottom";
}

export class TaskNotesService {
  constructor(
    private obsidian: ObsidianClient,
    private notes: Record<TaskType, TaskNoteConfig>,
  ) {}

  async list(type?: TaskType): Promise<Task[]> {
    const types: TaskType[] = type ? [type] : ["work", "personal"];
    const out: Task[] = [];
    for (const t of types) {
      const cfg = this.notes[t];
      const note = await this.obsidian.readNote(cfg.path);
      const tasks = parseTasks(note, cfg.heading, cfg.tag, t);
      log.debug({ type: t, path: cfg.path, tasks: tasks.length }, "tasks read");
      out.push(...tasks);
    }
    return out;
  }

  async add(draft: TaskDraft, sourceDate: string): Promise<string> {
    const cfg = this.notes[draft.type];
    const line = renderTaskLine(draft, cfg.tag, sourceDate);
    await this.obsidian.updateNote(cfg.path, (note, write) =>
      write(this.touch(insertTaskLine(note, cfg.heading, line, cfg.insert))),
    );
    log.info(
      { type: draft.type, path: cfg.path, due: draft.due, start: draft.start },
      "task created",
    );
    return line;
  }

  /**
   * Tick or untick the task at `index` of a note's section. `fingerprint` is the digest
   * the list was rendered from: if the note changed underneath, nothing is written and
   * null comes back, so a stale tap can never tick the wrong task.
   */
  async setDone(
    type: TaskType,
    index: number,
    fingerprint: string,
    done: boolean,
  ): Promise<Task | null> {
    const cfg = this.notes[type];
    return this.obsidian.updateNote(cfg.path, (note, write) => {
      const task = parseTasks(note, cfg.heading, cfg.tag, type)[index];
      if (!task || task.fingerprint !== fingerprint) {
        log.warn(
          { type, index, fingerprint, found: task?.fingerprint ?? null },
          "task tap ignored — the note changed underneath",
        );
        return null;
      }
      const line = done
        ? completeTaskLine(task.line, plainDate())
        : uncompleteTaskLine(task.line);
      const out = replaceTaskLineAt(note, cfg.heading, index, line);
      if (!out) return null;
      write(this.touch(out));
      log.info({ type, index, done, text: task.text }, "task state changed");
      return parseTaskLine(line, index, type, cfg.tag);
    });
  }

  /** Bump the note's `updatedAt` frontmatter, which both task notes carry. A note without
   *  frontmatter is left alone rather than being given a block it never had. */
  private touch(note: string): string {
    if (!note.startsWith("---\n")) return note;
    const stamp = `${new Date().toISOString().slice(0, 19)}Z`;
    return setFrontmatterValue(note, "updatedAt", stamp);
  }
}
