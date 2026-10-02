import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { GroqTranscriber, groqChat } from "./groq.ts";

type Seen = { url: string; authorization: string; body: string };
const seen: Seen[] = [];
const answer: { type: string; body: string } = { type: "text/plain", body: "" };

const server: Server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  seen.push({
    url: req.url ?? "",
    authorization: String(req.headers.authorization),
    body: Buffer.concat(chunks).toString("utf8"),
  });
  res.writeHead(200, { "content-type": answer.type }).end(answer.body);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => new Promise<void>((resolve) => void server.close(() => resolve())));

async function viaGroqHost<T>(run: () => Promise<T>): Promise<T> {
  const saved = process.env.GROQ_BASE_URL;
  process.env.GROQ_BASE_URL = url;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.GROQ_BASE_URL;
    if (saved !== undefined) process.env.GROQ_BASE_URL = saved;
  }
}

const messages = [
  { role: "system" as const, content: "be brief" },
  { role: "user" as const, content: "hi" },
];

test("a Telegram voice note goes to Groq as .ogg and the transcript comes back trimmed", async () => {
  answer.type = "text/plain";
  answer.body = "  hello world \n";
  const out = await viaGroqHost(() =>
    new GroqTranscriber("key").transcribe(new Uint8Array([1, 2, 3]), "oga"),
  );
  const request = seen.at(-1)!;
  assert.equal(out, "hello world");
  assert.ok(request.url.endsWith("/audio/translations"));
  assert.equal(request.authorization, "Bearer key");
  assert.match(request.body, /filename="audio\.ogg"/);
  assert.match(request.body, /whisper-large-v3/);
});

test("an audio file keeps its own extension, and a JSON answer is read as well", async () => {
  answer.type = "application/json";
  answer.body = JSON.stringify({ text: " transcribed " });
  const out = await viaGroqHost(() =>
    new GroqTranscriber("key").transcribe(new Uint8Array([1, 2, 3]), "mp3"),
  );
  assert.equal(out, "transcribed");
  assert.match(seen.at(-1)!.body, /filename="audio\.mp3"/);
});

test("groqChat posts the messages to an OpenAI-compatible base URL with the timeout and reads the answer with its usage", async () => {
  answer.type = "application/json";
  answer.body = JSON.stringify({
    choices: [{ message: { content: "ok" } }],
    usage: { prompt_tokens: 3, completion_tokens: 5 },
  });
  const out = await groqChat("key", "model-x", messages, url, 5000);
  const request = seen.at(-1)!;
  assert.deepEqual(out, { text: "ok", usage: { input: 3, output: 5 } });
  assert.ok(request.url.endsWith("/chat/completions"));
  assert.deepEqual(JSON.parse(request.body), {
    model: "model-x",
    temperature: 0,
    messages,
  });
});

test("groqChat without a base URL talks to Groq itself, and a reply with no choices and no usage counts as empty", async () => {
  answer.type = "application/json";
  answer.body = JSON.stringify({ choices: [] });
  const out = await viaGroqHost(() =>
    groqChat("key", "model-x", messages, undefined, 5000),
  );
  assert.deepEqual(out, { text: "", usage: { input: 0, output: 0 } });
  assert.ok(seen.at(-1)!.url.endsWith("/chat/completions"));
});
