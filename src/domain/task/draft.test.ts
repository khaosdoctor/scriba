import assert from "node:assert/strict";
import { test } from "node:test";
import { draftFromDetection, parseTaskDate, parseTaskDraft } from "./draft.ts";

const TODAY = "2026-08-29"; // a Saturday

test("one date is the deadline", () => {
  const draft = parseTaskDraft("buy cat sand next week", TODAY);
  assert.deepEqual(draft, {
    description: "buy cat sand",
    type: "personal",
    start: null,
    due: "2026-09-05",
  });
});

test("a 'for <duration>' span is how long, not when", () => {
  const draft = parseTaskDraft("water the plants for a week by friday", TODAY);
  assert.equal(draft.due, "2026-09-04");
  assert.equal(draft.start, null);
});

test("cue words label the dates", () => {
  assert.deepEqual(parseTaskDraft("review the RFC by next friday", TODAY), {
    description: "review the RFC",
    type: "personal",
    start: null,
    due: "2026-09-04",
  });
  assert.deepEqual(
    parseTaskDraft("book flights starting next monday due in two weeks", TODAY),
    {
      description: "book flights",
      type: "personal",
      start: "2026-08-31",
      due: "2026-09-12",
    },
  );
});

test("a lone start is promoted to the deadline, since due is the mandatory one", () => {
  const draft = parseTaskDraft("start the chapter on monday", TODAY);
  assert.equal(draft.start, null);
  assert.equal(draft.due, "2026-08-31");
  assert.equal(draft.description, "start the chapter");
  assert.deepEqual(parseTaskDraft("gym routine starting monday", TODAY), {
    description: "gym routine",
    type: "personal",
    start: null,
    due: "2026-08-31",
  });
});

test("two bare dates are the start and the deadline, earliest first", () => {
  const expected = {
    description: "sprint kickoff demo",
    type: "personal",
    start: "2026-08-31",
    due: "2026-09-04",
  };
  assert.deepEqual(
    parseTaskDraft("sprint kickoff monday, demo friday", TODAY),
    expected,
  );
  assert.deepEqual(parseTaskDraft("demo friday, kickoff monday", TODAY), {
    ...expected,
    description: "demo kickoff",
  });
});

test("work is only work when it's said plainly", () => {
  assert.equal(
    parseTaskDraft("review the RFC for work tomorrow", TODAY).type,
    "work",
  );
  assert.equal(parseTaskDraft("answer the RFCs at work", TODAY).type, "work");
  assert.equal(
    parseTaskDraft("work on the guitar solo", TODAY).type,
    "personal",
  );
  assert.equal(
    parseTaskDraft("work out why the tests fail", TODAY).type,
    "personal",
  );
  assert.equal(
    parseTaskDraft("review the RFC for work tomorrow", TODAY).description,
    "review the RFC",
  );
});

test("a date is found whatever language the task was typed in", () => {
  // The vault is English, but a task is typed in whatever language it came to mind in,
  // and chrono only reads the locale it is handed.
  assert.deepEqual(parseTaskDraft("Comprar ração amanhã", TODAY), {
    description: "Comprar ração",
    type: "personal",
    start: null,
    due: "2026-08-30",
  });
  assert.deepEqual(parseTaskDraft("pagar a conta até sexta", TODAY), {
    description: "pagar a conta",
    type: "personal",
    start: null,
    due: "2026-09-04",
  });
  assert.deepEqual(parseTaskDraft("köp kattsand imorgon", TODAY), {
    description: "köp kattsand",
    type: "personal",
    start: null,
    due: "2026-08-30",
  });
  assert.equal(
    parseTaskDraft("boka tvättstugan på fredag", TODAY).description,
    "boka tvättstugan",
  );
  // …and the change prompts read the same languages.
  assert.equal(parseTaskDate("amanhã", TODAY), "2026-08-30");
  assert.equal(parseTaskDate("imorgon", TODAY), "2026-08-30");
});

test("anything not plainly work is personal", () => {
  // The model may only push a task towards work; everything else falls back to what the
  // text says, which defaults to personal.
  assert.equal(
    draftFromDetection(
      { description: "Renew the passport", type: "work" },
      TODAY,
    ).type,
    "work",
  );
  for (const type of ["Work", "WORK", "professional", "other", "", undefined])
    assert.equal(
      draftFromDetection({ description: "Renew the passport", type }, TODAY)
        .type,
      "personal",
      `type ${JSON.stringify(type)} should fall back to personal`,
    );
  // …unless the text itself says work, in which case the fallback finds it.
  assert.equal(
    draftFromDetection({ description: "Fix the deploy for work" }, TODAY).type,
    "work",
  );
});

test("a task with no date at all keeps its whole text", () => {
  assert.deepEqual(parseTaskDraft("buy milk", TODAY), {
    description: "buy milk",
    type: "personal",
    start: null,
    due: null,
  });
  // A bare clock time is not a date, so it stays in the description.
  assert.equal(parseTaskDraft("gym at 7pm", TODAY).due, null);
});

test("parseTaskDate takes a phrase, an ISO day, or a clear instruction", () => {
  assert.equal(parseTaskDate("next friday", TODAY), "2026-09-04");
  assert.equal(parseTaskDate("2026-12-24", TODAY), "2026-12-24");
  assert.equal(parseTaskDate("in three days", TODAY), "2026-09-01");
  assert.equal(parseTaskDate("none", TODAY), null);
  assert.equal(parseTaskDate("banana", TODAY), undefined);
  assert.equal(parseTaskDate("", TODAY), undefined);
});

test("a detected task's own words become dates against the jot's day", () => {
  assert.deepEqual(
    draftFromDetection(
      { description: "Call the vet", due: "tomorrow", type: "personal" },
      TODAY,
    ),
    {
      description: "Call the vet",
      type: "personal",
      start: null,
      due: "2026-08-30",
    },
  );
  // A date left inside the description is lifted out of it rather than read twice.
  assert.deepEqual(
    draftFromDetection({ description: "Call the vet tomorrow" }, TODAY),
    {
      description: "Call the vet",
      type: "personal",
      start: null,
      due: "2026-08-30",
    },
  );
  // A start with no deadline is promoted, since the deadline is the mandatory one.
  assert.deepEqual(
    draftFromDetection(
      { description: "Book the flights", start: "next monday", type: "work" },
      TODAY,
    ),
    {
      description: "Book the flights",
      type: "work",
      start: null,
      due: "2026-08-31",
    },
  );
});

test("a detected task with no timing at all keeps none — the card asks", () => {
  const draft = draftFromDetection(
    { description: "Renew the passport" },
    TODAY,
  );
  assert.equal(draft.due, null);
  assert.equal(draft.start, null);
  // Nonsense the model may put in a date field is dropped, not guessed at.
  assert.equal(
    draftFromDetection(
      { description: "Renew the passport", due: "soon-ish" },
      TODAY,
    ).due,
    null,
  );
});
