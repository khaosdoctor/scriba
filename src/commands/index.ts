import { changelog } from "./changelog.ts";
import { failed } from "./failed.ts";
import { flush } from "./flush.ts";
import { makeHelp } from "./help.ts";
import { jot } from "./jot.ts";
import { register } from "./register.ts";
import { rejections } from "./rejections.ts";
import { retry } from "./retry.ts";
import { stats } from "./stats.ts";
import { status } from "./status.ts";
import { stopword } from "./stopword.ts";
import { sweep } from "./sweep.ts";
import { transcriber } from "./transcriber.ts";
import type { Command } from "./types.ts";
import { unreject } from "./unreject.ts";
import { unstick } from "./unstick.ts";
import { version } from "./version.ts";

/** The admin command registry. The bot registers a handler per entry. */
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
	register,
	transcriber,
];
// help closes over the array, so it lists itself and every command added above.
commands.push(makeHelp(commands));

export type { Command, Deps } from "./types.ts";
