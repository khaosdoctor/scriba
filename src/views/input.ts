import type { Message, MessageEntity } from "grammy/types";
import type { EditInput, IntakeInput } from "../domain/jot/structures.ts";

const ENTITY_WRAP: Partial<Record<string, readonly [string, string]>> = {
  bold: ["**", "**"],
  italic: ["_", "_"],
  underline: ["__", "__"],
  strikethrough: ["~~", "~~"],
  spoiler: ["||", "||"],
  code: ["`", "`"],
};

function wrapEntity(e: MessageEntity, content: string): string {
  if (e.type === "pre") return `\`\`\`${e.language ?? ""}\n${content}\n\`\`\``;
  if (e.type === "text_link") return `[${content}](${e.url})`;
  if (e.type === "text_mention")
    return `[@${content}](tg://user?id=${e.user?.id})`;
  const [open, close] = ENTITY_WRAP[e.type] ?? ["", ""];
  return `${open}${content}${close}`;
}

/** Convert Telegram message entities to Markdown. Entities are in UTF-16 code units. */
export function entitiesToMarkdown(
  text: string,
  entities: MessageEntity[] | undefined,
): string {
  if (!entities?.length) return text;
  const sorted = [...entities].sort((a, b) => a.offset - b.offset);
  let out = "";
  let last = 0;
  for (const e of sorted) {
    const start = e.offset;
    const end = e.offset + e.length;
    // Flat serializer: skip entities nested in an already-emitted one
    // (bold-link, bold+italic same span). Drops inner formatting but never
    // duplicates text. Full nesting would need a boundary-marker tree.
    if (start < last) continue;
    out += text.slice(last, start) + wrapEntity(e, text.slice(start, end));
    last = end;
  }
  out += text.slice(last);
  return out;
}

/** Build the intake input for a message, or nothing for a kind the bot does not take. */
export function intakeInput(m: Message): IntakeInput | undefined {
  const base = { messageId: m.message_id, sentAt: m.date * 1000 };
  const caption = () => entitiesToMarkdown(m.caption ?? "", m.caption_entities);
  if (m.text !== undefined)
    return {
      ...base,
      kind: "text",
      rawText: entitiesToMarkdown(m.text, m.entities),
    };
  if (m.voice)
    return { ...base, kind: "audio", rawText: null, fileId: m.voice.file_id };
  if (m.audio)
    return { ...base, kind: "audio", rawText: null, fileId: m.audio.file_id };
  if (m.photo)
    return {
      ...base,
      kind: "image",
      rawText: caption(),
      fileId: m.photo.at(-1)!.file_id,
    };
  if (m.video)
    return {
      ...base,
      kind: "video",
      rawText: caption(),
      fileId: m.video.file_id,
    };
  if (m.video_note)
    return {
      ...base,
      kind: "video",
      rawText: null,
      fileId: m.video_note.file_id,
    };
  return undefined;
}

export function editInput(m: Message): EditInput {
  const text =
    m.text !== undefined
      ? entitiesToMarkdown(m.text, m.entities)
      : entitiesToMarkdown(m.caption ?? "", m.caption_entities);
  return { messageId: m.message_id, text };
}
