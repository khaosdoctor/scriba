import type { Api, Bot, Context } from "grammy";
import { logger } from "../../libs/log.ts";
import type { AdminController } from "../../services/admin.ts";
import type { CommandController } from "../../services/command.ts";
import type { EditController } from "../../services/edits.ts";
import type { HabitController } from "../../services/habits.ts";
import type { JotController } from "../../services/jots.ts";
import type { Modes } from "../../services/modes.ts";
import type { RatingController } from "../../services/rating.ts";
import type { SettingsController } from "../../services/settings.ts";
import type { TaskController } from "../../services/tasks.ts";
import { callbackViews } from "./callbacks.ts";
import { COMMANDS } from "./commands.ts";
import { type ErrorDeps, errorHandler } from "./errors.ts";
import { editedView } from "./journal/edited.ts";
import { fallbackView } from "./journal/fallback.ts";
import { photoView } from "./journal/photo.ts";
import { reactionView } from "./journal/reaction.ts";
import { textView } from "./journal/text.ts";
import { videoView } from "./journal/video.ts";
import { voiceView } from "./journal/voice.ts";
import type { MenuLifetime } from "./settings/menu-lifetime.ts";

const log = logger("bot");

export type ViewDeps = {
  ownerId: number;
  rating: RatingController;
  habits: HabitController;
  settings: SettingsController;
  menus: MenuLifetime;
  modes: Modes;
  command: CommandController;
  tasks: TaskController;
  jotController: JotController;
  edits: EditController;
  admin: AdminController;
  errors: ErrorDeps;
};

const describe = (ctx: Context) => ({
  kind: Object.keys(ctx.update).find((key) => key !== "update_id"),
  data: ctx.callbackQuery?.data ?? ctx.entities("bot_command")[0]?.text,
});

/** Everything Telegram-facing, in the order an update is tried: the owner allowlist and the
 *  one log line per update, the slash commands, the message views, the callback namespaces,
 *  reactions, and the fallback reply for anything else. */
export function registerViews(bot: Bot, deps: ViewDeps): void {
  bot.catch(errorHandler(deps.errors));
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== deps.ownerId) return;
    log.debug(describe(ctx), "update received");
    await next();
  });
  for (const command of COMMANDS) bot.use(command.view(deps));
  bot.use(
    textView(deps),
    voiceView(deps),
    photoView(deps),
    videoView(deps),
    editedView(deps),
  );
  for (const view of callbackViews(deps)) bot.use(view);
  bot.use(reactionView(deps), fallbackView());
}

/** Populate the `/` command menu Telegram shows in the compose box. */
export async function publishCommands(
  api: Pick<Api, "setMyCommands">,
): Promise<void> {
  await api
    .setMyCommands(
      COMMANDS.map(({ command, description }) => ({ command, description })),
    )
    .catch((e) => log.warn({ err: e }, "setMyCommands failed"));
}
