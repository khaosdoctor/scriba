import { setFrontmatterValue } from "../core.ts";
import type { TaskType } from "../db.ts";
import {
	completeTaskLine,
	insertTaskLine,
	parseTaskLine,
	parseTasks,
	renderTaskLine,
	replaceTaskLineAt,
	type Task,
	type TaskDraft,
	uncompleteTaskLine,
} from "../flows/tasks/parse.ts";
import { logger } from "../log.ts";
import { plainDate } from "../time.ts";
import type { ObsidianClient } from "./obsidian.ts";

const log = logger("tasks");

/** Where one type's tasks live, and how that note keeps them. */
export interface TaskNoteConfig {
	/** Vault-relative path of the note. */
	path: string;
	/** The heading whose checklist holds the tasks — everything else in the note is
	 *  ignored, which is what keeps the work note's project sections out of the way. */
	heading: string;
	/** The tag every task in that note carries. */
	tag: string;
	/** Which end a new task goes on: the work note runs newest-first, the personal one is
	 *  appended to. */
	insert: "top" | "bottom";
}

/**
 * Read and write the two task notes. All the vault I/O for tasks lives here; the shaping of
 * a line is pure and lives in flows/tasks/parse.ts. Every write is a read-modify-write under
 * the per-note lock, so a task added from Telegram can't clobber an edit made in Obsidian a
 * second earlier — the same discipline every journal write already follows.
 */
export class TaskStore {
	constructor(
		private obsidian: ObsidianClient,
		private notes: Record<TaskType, TaskNoteConfig>,
	) {}

	config(type: TaskType): TaskNoteConfig {
		return this.notes[type];
	}

	/** Every task of one type, or of both (work first) in note order. */
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

	/** Write a new task into its note. Returns the line as it landed. */
	async add(draft: TaskDraft, sourceDate: string): Promise<string> {
		const cfg = this.notes[draft.type];
		const line = renderTaskLine(draft, cfg.tag, sourceDate);
		await this.obsidian.withNoteLock(cfg.path, async () => {
			const note = await this.obsidian.readNote(cfg.path);
			const out = insertTaskLine(note, cfg.heading, line, cfg.insert);
			await this.obsidian.writeNote(cfg.path, this.touch(out));
		});
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
		return this.obsidian.withNoteLock(cfg.path, async () => {
			const note = await this.obsidian.readNote(cfg.path);
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
			const out = replaceTaskLineAt(
				note,
				cfg.heading,
				index,
				fingerprint,
				line,
			);
			if (!out) return null;
			await this.obsidian.writeNote(cfg.path, this.touch(out));
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
