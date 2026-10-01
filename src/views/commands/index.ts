import { type CommandContext, Composer, type Context } from "grammy";
import type { ViewDeps } from "../index.ts";
import { changelog } from "./changelog.ts";
import { deleteCommand } from "./delete.ts";
import { done } from "./done.ts";
import { failed } from "./failed.ts";
import { flush } from "./flush.ts";
import { habitsCommand } from "./habits.ts";
import { help } from "./help.ts";
import { jot } from "./jot.ts";
import { rate } from "./rate.ts";
import { rejections } from "./rejections.ts";
import { reprocess } from "./reprocess.ts";
import { retry } from "./retry.ts";
import { start } from "./start.ts";
import { stats } from "./stats.ts";
import { status } from "./status.ts";
import { stopword } from "./stopword.ts";
import { sweep } from "./sweep.ts";
import { taskCommand } from "./task.ts";
import { taskAddCommand } from "./taskadd.ts";
import { tasksCommand } from "./tasks.ts";
import { unreject } from "./unreject.ts";
import { unstick } from "./unstick.ts";
import { version } from "./version.ts";

/** One slash command: what Telegram's `/` menu shows for it and the view that answers it. */
export type CommandView = {
  command: string;
  description: string;
  /** Listed by /help. The owner allowlist is the only auth either way. */
  admin?: true;
  view(deps: ViewDeps): Composer<Context>;
};

type Handler = (ctx: CommandContext<Context>) => unknown;

/** A command whose body still lives on a flow, called straight through until that flow
 *  becomes a view of its own. */
function flow(
  command: string,
  description: string,
  handle: (deps: ViewDeps) => Handler,
): CommandView {
  return {
    command,
    description,
    view(deps) {
      const view = new Composer<Context>();
      view.command(command, handle(deps));
      return view;
    },
  };
}

/** Every slash command, in the order Telegram's `/` menu and /help list them. */
export const COMMANDS: CommandView[] = [
  start,
  flow(
    "menu",
    "Open the interactive control menu",
    ({ menu }) =>
      (ctx) =>
        menu.open(ctx),
  ),
  rate,
  habitsCommand,
  reprocess,
  flow(
    "command",
    "Open a vault assistant session (/done to close)",
    ({ command }) =>
      (ctx) =>
        command.start(ctx),
  ),
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
