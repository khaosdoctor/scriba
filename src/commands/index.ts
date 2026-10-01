import { changelog } from "./changelog.ts";
import { failed } from "./failed.ts";
import { flush } from "./flush.ts";
import { jot } from "./jot.ts";
import { rejections } from "./rejections.ts";
import { retry } from "./retry.ts";
import { stats } from "./stats.ts";
import { status } from "./status.ts";
import { stopword } from "./stopword.ts";
import { sweep } from "./sweep.ts";
import type { Command } from "./types.ts";
import { unreject } from "./unreject.ts";
import { unstick } from "./unstick.ts";
import { version } from "./version.ts";

/** The admin command registry. `views/commands` registers a handler per entry and adds
 *  /help after them. */
export const commands: Command[] = [
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

export type { Command, Deps } from "./types.ts";
