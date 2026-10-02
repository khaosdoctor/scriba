import { Composer, type Context } from "grammy";
import type { CommandOpen } from "../../../services/command.ts";
import type { CommandView } from "../commands.ts";

const INTRO = [
  "🧭 Command mode is on.",
  "",
  "Everything you send now goes to the vault assistant instead of your journal. It can create, refresh and delete notes, and research on the web first. I'll ask before anything is written or deleted.",
  "",
  "Keep talking while it works — every message is taken straight away and answered under itself, in the order they arrive. You'll see what the assistant is thinking and which tools it reaches for as it goes, and ⏹ Stop cuts a message off mid-thought.",
  "",
  "Send /done when you're finished.",
].join("\n");

const REFUSALS: Record<Exclude<CommandOpen, "opened">, string> = {
  busy: "📝 Task mode is open. Send /done to close it first, then /command.",
  noVault:
    "⚠️ command mode needs SCRIBA_VAULT_HOST_PATH — the vault isn't mounted.",
};

export const commandMode: CommandView = {
  command: "command",
  description: "Open a vault assistant session (/done to close)",
  view({ command }) {
    const view = new Composer<Context>();
    view.command("command", async (ctx) => {
      const outcome = command.open();
      await ctx.reply(outcome === "opened" ? INTRO : REFUSALS[outcome]);
    });
    return view;
  },
};
