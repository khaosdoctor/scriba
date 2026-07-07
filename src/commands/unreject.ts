import type { Command } from "./types.ts";

export const unreject: Command = {
  name: "unreject",
  description: "undo a link-rejection — /unreject <surface> <note>",
  run: async (_ctx, args, d) => {
    // ponytail: note is the last token, surface is the rest. Fine for single-word note
    // names; if a note name has spaces, wrap-free parsing won't split it right — rare
    // enough to not warrant a quoting mini-language.
    const t = args.trim();
    const i = t.lastIndexOf(" ");
    if (i < 0) return "usage: /unreject <surface> <note>";
    const surface = t.slice(0, i);
    const note = t.slice(i + 1);
    const n = await d.repo.unreject(surface, note);
    return n ? `↩️ "${surface}" may link to [[${note}]] again` : `no rejection for "${surface}" → [[${note}]]`;
  },
};
