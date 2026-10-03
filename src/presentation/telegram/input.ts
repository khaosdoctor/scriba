import type { Message, MessageEntity } from "grammy/types";
import type { EditInput, IntakeInput } from "../../domain/jot/structures.ts";

const ENTITY_WRAP: Partial<Record<string, readonly [string, string]>> = {
  bold: ["**", "**"],
  italic: ["_", "_"],
  underline: ["__", "__"],
  strikethrough: ["~~", "~~"],
  spoiler: ["||", "||"],
  code: ["`", "`"],
};

function wrapEntity(entity: MessageEntity, content: string): string {
  if (entity.type === "pre")
    return `\`\`\`${entity.language ?? ""}\n${content}\n\`\`\``;
  if (entity.type === "text_link") return `[${content}](${entity.url})`;
  if (entity.type === "text_mention")
    return `[@${content}](tg://user?id=${entity.user?.id})`;
  const [open, close] = ENTITY_WRAP[entity.type] ?? ["", ""];
  return `${open}${content}${close}`;
}

/** Convert Telegram message entities to Markdown. Entities are in UTF-16 code units. */
export function entitiesToMarkdown(
  text: string,
  entities: MessageEntity[] | undefined,
): string {
  if (!entities?.length) return text;
  const sorted = [...entities].sort(
    (first, second) => first.offset - second.offset,
  );
  let out = "";
  let last = 0;
  for (const entity of sorted) {
    const start = entity.offset;
    const end = entity.offset + entity.length;
    // Flat serializer: skip entities nested in an already-emitted one
    // (bold-link, bold+italic same span). Drops inner formatting but never
    // duplicates text. Full nesting would need a boundary-marker tree.
    if (start < last) continue;
    out += text.slice(last, start) + wrapEntity(entity, text.slice(start, end));
    last = end;
  }
  out += text.slice(last);
  return out;
}

export function intakeInput(message: Message): IntakeInput | undefined {
  const base = { messageId: message.message_id, sentAt: message.date * 1000 };
  const caption = () =>
    entitiesToMarkdown(message.caption ?? "", message.caption_entities);
  if (message.text !== undefined)
    return {
      ...base,
      kind: "text",
      rawText: entitiesToMarkdown(message.text, message.entities),
    };
  if (message.voice)
    return {
      ...base,
      kind: "audio",
      rawText: null,
      fileId: message.voice.file_id,
    };
  if (message.audio)
    return {
      ...base,
      kind: "audio",
      rawText: null,
      fileId: message.audio.file_id,
    };
  if (message.photo)
    return {
      ...base,
      kind: "image",
      rawText: caption(),
      fileId: message.photo.at(-1)!.file_id,
    };
  if (message.video)
    return {
      ...base,
      kind: "video",
      rawText: caption(),
      fileId: message.video.file_id,
    };
  if (message.video_note)
    return {
      ...base,
      kind: "video",
      rawText: null,
      fileId: message.video_note.file_id,
    };
  return undefined;
}

export function editInput(message: Message): EditInput {
  const text =
    message.text !== undefined
      ? entitiesToMarkdown(message.text, message.entities)
      : entitiesToMarkdown(message.caption ?? "", message.caption_entities);
  return { messageId: message.message_id, text };
}
