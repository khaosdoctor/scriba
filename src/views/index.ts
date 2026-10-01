import type { Bot, Context } from "grammy";
import type { Deps } from "../commands/index.ts";
import type { CommandSession } from "../flows/command.ts";
import type { FollowupFlow } from "../flows/followup.ts";
import type { HabitsCommand } from "../flows/habits/index.ts";
import type { MenuController } from "../flows/menu.ts";
import type { RatingCommand } from "../flows/rating.ts";
import type { ReprocessCommand } from "../flows/reprocess.ts";
import type { TasksFlow } from "../flows/tasks/index.ts";
import type { TilFlow } from "../flows/til.ts";
import { logger } from "../log.ts";
import type { JotKind } from "../models/domain.ts";
import { callbackViews } from "./callbacks/index.ts";
import { COMMANDS } from "./commands/index.ts";
import { type ErrorDeps, errorHandler } from "./errors.ts";
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
  handleUnreject(ctx: Context, rest: string[]): Promise<void>;
}

export type ViewDeps = {
  ownerId: number;
  rating: RatingCommand;
  followup: FollowupFlow;
  habits: HabitsCommand;
  menu: MenuController;
  reprocess: ReprocessCommand;
  command: CommandSession;
  tasks: TasksFlow;
  til: TilFlow;
  jots: JotHandlers;
  /** What the admin commands act on, assembled per invocation. */
  admin: () => Deps;
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
