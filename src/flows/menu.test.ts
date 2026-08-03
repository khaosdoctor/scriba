import assert from "node:assert/strict";
import { test } from "node:test";

// menu.ts pulls in config.ts, which validates process.env at import time — give it the
// bare minimum before loading, the same trick config.test.ts uses.
process.env.TELEGRAM_BOT_TOKEN ??= "t";
process.env.ALLOWED_TELEGRAM_USER_ID ??= "1";
process.env.OBSIDIAN_API_KEY ??= "o";
const { MenuController } = await import("./menu.ts");

/** A controller wired to a bot stub that only records deleteMessage calls. */
function harness() {
	const deleted: [number, number][] = [];
	const bot = {
		api: {
			deleteMessage: async (chatId: number, msgId: number) => {
				deleted.push([chatId, msgId]);
			},
		},
	};
	const menu = new MenuController(
		bot as any,
		{} as any,
		{} as any,
		{} as any,
		(() => ({})) as any,
		(async () => "") as any,
	) as any;
	return { menu, deleted };
}

test("a menu message self-destructs after a minute of no taps", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { menu, deleted } = harness();
	menu.scheduleExpiry(7, 42);
	t.mock.timers.tick(59_000);
	assert.deepEqual(deleted, []);
	t.mock.timers.tick(2_000);
	assert.deepEqual(deleted, [[7, 42]]);
});

test("each tap restarts the countdown, and closing cancels it", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { menu, deleted } = harness();
	menu.scheduleExpiry(7, 42);
	t.mock.timers.tick(50_000);
	menu.scheduleExpiry(7, 42); // a tap
	t.mock.timers.tick(50_000); // 100s since the send, 50s since the tap
	assert.deepEqual(deleted, []);
	menu.cancelExpiry(7, 42);
	t.mock.timers.tick(120_000);
	assert.deepEqual(deleted, []);
});
