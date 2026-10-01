import type { Bot, Context } from "grammy";
import type { AdminController } from "../controllers/admin.ts";
import type { HabitController } from "../controllers/habits.ts";
import type { JotController } from "../controllers/jots.ts";
import type { RatingController } from "../controllers/rating.ts";
import type { SettingsController } from "../controllers/settings.ts";
import type { TaskController } from "../controllers/tasks.ts";
import type { Jot } from "../db.ts";
import type { CommandSession } from "../flows/command.ts";
import { logger } from "../log.ts";
import type { JotKind } from "../models/domain.ts";
import { callbackViews } from "./callbacks/index.ts";
import { COMMANDS } from "./commands/index.ts";
import { type ErrorDeps, errorHandler } from "./errors.ts";
import type { MenuLifetime } from "./menu-lifetime.ts";
import { editedView } from "./messages/edited.ts";
import { fallbackView } from "./messages/fallback.ts";
import { photoView } from "./messages/photo.ts";
import { reactionView } from "./messages/reaction.ts";
import { textView } from "./messages/text.ts";
import { videoView } from "./messages/video.ts";
import { voiceView } from "./messages/voice.ts";

const log = logger("bot");

/** The jot handlers the message and callback views call back into. */
export interface JotHandlers {
  intake(
    ctx: Context,
    kind: JotKind,
    src: { rawText?: string; fileId?: string; day?: string },
  ): Promise<void>;
  intakeMedia(ctx: Context, kind: JotKind, fileId: string): Promise<void>;
  spokenTask(ctx: Context, fileId: string): Promise<void>;
  handleEdit(ctx: Context): Promise<void>;
  applyMessageEdit(ctx: Context, edited: string): Promise<void>;
  handleDeleteCommand(ctx: Context): Promise<void>;
  handleMergeReaction(ctx: Context): Promise<void>;
  handleVoiceFix(ctx: Context, verdict?: string, jotId?: string): Promise<void>;
  handleRetry(ctx: Context, jotId?: string): Promise<void>;
  handleRemove(
    ctx: Context,
    jotId: string | undefined,
    source: "undo" | "discard",
  ): Promise<void>;
  handleEmbed(
    ctx: Context,
    jotId: string | undefined,
    embed: boolean,
  ): Promise<void>;
  handleLink(ctx: Context, verdict?: string, pendingId?: string): Promise<void>;
  deleteJot(jot: Jot): Promise<string>;
}

export type ViewDeps = {
  ownerId: number;
  rating: RatingController;
  habits: HabitController;
  settings: SettingsController;
  menus: MenuLifetime;
  command: CommandSession;
  tasks: TaskController;
  jotController: JotController;
  jots: JotHandlers;
  /** Read per tap or command: the controller is built after the bot, in index.ts. */
  admin: () => AdminController;
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
