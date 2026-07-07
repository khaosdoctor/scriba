import type { Command } from "./types.ts";
import { version } from "./version.ts";
import { stats } from "./stats.ts";
import { status } from "./status.ts";
import { failed } from "./failed.ts";
import { jot } from "./jot.ts";
import { flush } from "./flush.ts";
import { retry } from "./retry.ts";
import { sweep } from "./sweep.ts";
import { unstick } from "./unstick.ts";
import { stopword } from "./stopword.ts";
import { rejections } from "./rejections.ts";
import { unreject } from "./unreject.ts";
import { transcriber } from "./transcriber.ts";
import { makeHelp } from "./help.ts";

/** The admin command registry. The bot registers a handler per entry. */
export const commands: Command[] = [
  version, stats, status, failed, jot,
  flush, retry, sweep, unstick,
  stopword, rejections, unreject, transcriber,
];
// help closes over the array, so it lists itself and every command added above.
commands.push(makeHelp(commands));

export type { Command, Deps } from "./types.ts";
