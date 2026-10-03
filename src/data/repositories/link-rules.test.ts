import assert from "node:assert/strict";
import { test } from "node:test";
import { withDb } from "../../test/sqlite.ts";
import { LinkRuleRepository } from "./link-rules.ts";

test("learned link rejections can be listed and undone", async (testContext) => {
  await withDb(testContext, async (knex) => {
    const rules = new LinkRuleRepository(knex);
    await rules.reject("No", "Norway");
    assert.ok((await rules.rejections()).has("no Norway")); // stored lowercased

    // rejections: list + undo (reject stores surface lowercased)
    assert.deepEqual(await rules.rejectionList(), [
      { surface: "no", note: "Norway" },
    ]);
    assert.equal(await rules.unreject("No", "Norway"), 1);
    assert.equal((await rules.rejectionList()).length, 0);
  });
});

test("stopwords are seeded, added idempotently, listed sorted, and deleted", async (testContext) => {
  await withDb(testContext, async (knex) => {
    const rules = new LinkRuleRepository(knex);
    assert.ok((await rules.stopwords()).size > 0); // seeded by migration

    // stopwords: add is idempotent, del reports how many rows went
    await rules.addStopword("Foo");
    await rules.addStopword("foo"); // dup ignored
    assert.ok((await rules.stopwords()).has("foo"));
    // the wizard indexes rows by position, so the list must come back sorted
    const words = await rules.stopwordList();
    assert.deepEqual(words, [...words].sort());
    assert.ok(words.includes("foo"));
    assert.equal(await rules.delStopword("FOO"), 1);
    assert.ok(!(await rules.stopwords()).has("foo"));
  });
});

test("registered links are added idempotently and removed", async (testContext) => {
  await withDb(testContext, async (knex) => {
    const rules = new LinkRuleRepository(knex);
    // registered links: add is idempotent + stores surface lowercased, del reports rows
    await rules.addRegisteredLink("Gym", "Fitness");
    await rules.addRegisteredLink("gym", "Fitness"); // dup ignored
    assert.deepEqual(await rules.registeredLinks(), [
      { surface: "gym", note: "Fitness" },
    ]);
    assert.equal(await rules.delRegisteredLink("GYM", "Fitness"), 1);
    assert.equal((await rules.registeredLinks()).length, 0);
  });
});

test("pending link questions are consumed once", async (testContext) => {
  await withDb(testContext, async (knex) => {
    const rules = new LinkRuleRepository(knex);
    await rules.addPendingLink("pppppppp", "aaaaaaaa", "Lev", "Lev");
    assert.equal((await rules.takePendingLink("pppppppp"))?.note, "Lev");
    assert.equal(await rules.takePendingLink("pppppppp"), undefined); // consumed
  });
});
