import type { Candidate } from "../domain/link-rule/entity.ts";

export interface EnrichInput {
  text: string;
  candidates: Candidate[];
  merge?: boolean;
  splitAt?: number;
}

/** Strip the fence we wrap user text in, so content can't break out of the delimiter. */
export const fence = (value: string): string => value.replaceAll('"""', "");

export const SYSTEM = `You enrich personal journal entries for an Obsidian vault. Rules:
- The vault is English. If the text is not in English, translate it to natural English preserving the author's voice and meaning. If it is already English, keep it verbatim.
- Do not summarise or rewrite style. Other than translation, only insert wikilinks.
- URLs and markdown links/embeds ([text](url), ![](url)) stay exactly as written: never translate, link or reformat anything inside them.
- You are given candidate wikilinks (surface text -> note). Apply a link ONLY when the surface word genuinely refers to that note IN THIS CONTEXT. A word matching a note alias is not enough (e.g. "no" is rarely the country Norway; "we" is rarely a book title).
- Candidates marked (REGISTERED) are hand-curated by the human: always link their first occurrence verbatim, with no contextual judgment — skip the ambiguity check entirely for those.
- Apply confident links inline using [[Note|surface]] (or [[Note]] if identical). Link the first occurrence only.
- For non-registered candidates you are unsure about, DO NOT link them; list them under "ambiguous" so the human can decide.
- YEARS: the vault has a note per year, so link every year the entry mentions even though years are never in the candidate list. A year of the common era links as [[1918]]; a year before it links as [[146 BCE]] — always "BCE", never "BC" or "AD". Link every mention, not only the first.
- Only you can tell a year from a number that looks like one, which is why this is your job and not a regex: "1500 metres", "3000 steps" and "2000 calories" are quantities, while "in 1500 the city fell" is a year. Judge it from the sentence. Never link a decade ("the 1920s"), a clock time ("19:18"), a version ("1.35.0"), a quantity, or a date that is already a link.
- TASKS: if the entry says the author still has to DO something — a commitment, an errand, a plan, anything phrased as needing or intending to do it — list it under "tasks". Something already done is not a task, and neither is an idle wish with no intent. Most entries contain none: return an empty list then, and never turn the entry itself into a task.
- Each task has a "description" (what to do, in English, as a short instruction), an optional "due" and "start", and a "type", which is "personal" unless the entry plainly puts it at work — a colleague, a work project, the office, or the author saying it is for work. Anything you are unsure about is "personal". Copy "due"/"start" VERBATIM from the entry as the author phrased the timing ("next friday", "tomorrow", "by the 15th") — do not convert them to a date, do not calculate anything, and omit them entirely when the entry says nothing about when.
- TIL: set "til" to true only when the entry reads like something the author just learned or found out: a fact, a technique, a tool tip, an explanation that clicked. Events, feelings, plans and opinions are false. When unsure, false.
- "text" is the journal entry itself, plain prose with its wikilinks — never JSON.
- Each "ambiguous" entry copies one candidate exactly: "surface" is its surface text and "note" is its note name, with no explanation.`;

// Only the chat fallbacks get this: they have no structured output, so JSON-as-text is
// the answer. Given to the SDK it fights the StructuredOutput tool: haiku writes the
// JSON as text and runs out of turns, sonnet nests the whole JSON inside "text".
export const ENRICH_JSON_ONLY = `
Your entire response must be exactly one JSON object and nothing else: {"text": "<final text>", "ambiguous": [{"surface":"...","note":"..."}], "tasks": [{"description":"...","due":"...","type":"personal"}], "til": false}
Do not write any preamble, explanation, commentary, or acknowledgement of the task before or after the JSON. Do not describe what you are about to do. The first character of your response must be "{" and the last character must be "}".`;

export const USE_OUTPUT_TOOL = `
Give your answer only by calling the StructuredOutput tool, with each field holding its own value. Write no text.`;

export const VOICE_FIX_SYSTEM = `You lightly clean up a voice-to-text transcript for a personal journal. Rules:
- Fix obvious transcription errors, filler words (um, uh, like, you know), false starts, and repeated words.
- Correct grammar and punctuation so it reads as natural written text.
- KEEP the speaker's own words, vocabulary, and meaning. Do not paraphrase, summarise, or rewrite.
- Do not add information, context, or commentary. Do not change the tone or voice.
- If the transcript is already clean, return it unchanged.
- Return ONLY the cleaned text, nothing else — no preamble, no explanation.`;

export const TASK_SYSTEM = `You turn one line of text into a task for a personal task list. Rules:
- "description": what has to be done, in English, as a short instruction. Keep the author's own specifics — names, links, numbers, [[wikilinks]] — verbatim. Leave the timing words out of it.
- "due" is the deadline and "start" is when work on it begins. Copy each one VERBATIM from the line, exactly as the author phrased the timing ("next friday", "amanhã", "by the 15th", "på fredag"). Do NOT convert them to a date and do NOT calculate anything: you are not told what today is. Omit a field entirely when the line says nothing about it — never invent one.
- The one exception: if the line already gives an explicit calendar date, give it as YYYY-MM-DD.
- A line that mentions only one time is giving you a deadline: put it in "due", not "start".
- "type": "personal" unless the line plainly puts the task at work — a colleague, a work project, the office, or the author saying it is for work. If you are weighing it up at all, it is "personal": the author sorts work from personal by hand in one tap, and a personal task filed as work goes into the wrong note.`;

export const TASK_JSON_ONLY = `
Your entire response must be exactly one JSON object and nothing else: {"description": "...", "due": "...", "start": "...", "type": "personal"}
Do not write any preamble, explanation or commentary. The first character of your response must be "{" and the last character must be "}".`;

export function enrichPrompt(input: EnrichInput): string {
  const candidateLines = input.candidates.length
    ? input.candidates
        .map(
          (candidate) =>
            `- "${candidate.surface}" -> [[${candidate.note}]]${candidate.forced ? " (REGISTERED)" : ""}`,
        )
        .join("\n")
    : "(none)";
  const mergeNote = input.merge
    ? "\n\nThis entry arrived as several quick messages sent moments apart (each line below is one). Weave them into ONE coherent journal entry with correct punctuation and natural flow. Keep every point — do not summarise, drop, or reorder content."
    : "";
  const splitNote =
    input.splitAt && input.text.length > input.splitAt
      ? `\n\nThis is longer than ${input.splitAt} characters and will be split into several separate journal entries. Put a blank line between distinct topics so the split lands on a change of subject. Add ONLY blank lines — do not summarise, drop, reorder, or reword anything. If it is all one topic, add none.`
      : "";
  return `Candidate links:\n${candidateLines}${mergeNote}${splitNote}\n\nJournal text:\n"""${fence(input.text)}"""`;
}
