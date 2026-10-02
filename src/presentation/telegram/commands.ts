import type { CommandContext, Context } from "grammy";
import { changelog } from "./admin/changelog.ts";
import { failed } from "./admin/failed.ts";
import { flush } from "./admin/flush.ts";
import { help } from "./admin/help.ts";
import { jot } from "./admin/jot.ts";
import { rejections } from "./admin/rejections.ts";
import { retry } from "./admin/retry.ts";
import { stats } from "./admin/stats.ts";
import { status } from "./admin/status.ts";
import { stopword } from "./admin/stopword.ts";
import { sweep } from "./admin/sweep.ts";
import { unreject } from "./admin/unreject.ts";
import { unstick } from "./admin/unstick.ts";
import { version } from "./admin/version.ts";
import { commandMode } from "./command/command.ts";
import { done } from "./command/done.ts";
import { habitsCommand } from "./habits/command.ts";
import type { ViewDeps } from "./index.ts";
import { deleteCommand } from "./journal/delete.ts";
import { start } from "./journal/start.ts";
import { rate } from "./rating/rate.ts";
import { reprocess } from "./reprocess/command.ts";
import { menuCommand } from "./settings/menu-command.ts";
import { taskAddCommand } from "./tasks/add.ts";
import { tasksCommand } from "./tasks/list.ts";
import { taskCommand } from "./tasks/mode.ts";

/** One slash command: what Telegram's `/` menu shows for it and the view that answers it. */
export type CommandView = {
  command: string;
  description: string;
  /** Listed by /help. The owner allowlist is the only auth either way. */
  admin?: true;
  run(ctx: CommandContext<Context>, deps: ViewDeps): unknown;
};

/** Every slash command, in the order Telegram's `/` menu and /help list them. */
export const COMMANDS: CommandView[] = [
  start,
  menuCommand,
  rate,
  habitsCommand,
  reprocess,
  commandMode,
  taskCommand,
  taskAddCommand,
  tasksCommand,
  done,
  deleteCommand,
  version,
  changelog,
  stats,
  status,
  failed,
  jot,
  flush,
  retry,
  sweep,
  unstick,
  stopword,
  rejections,
  unreject,
];
COMMANDS.push(help(COMMANDS));
