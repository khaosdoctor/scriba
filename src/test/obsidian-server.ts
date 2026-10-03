import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after } from "node:test";
import {
  ObsidianClient,
  type ObsidianConfig,
} from "../data/repositories/notes.ts";
import { testConfig } from "./config.ts";

/**
 * A stand-in for Obsidian's Local REST API, served on loopback so the client's real fetch,
 * headers and status handling are exercised rather than mocked out. The vault is a map of
 * path → content; every request is recorded so a test can assert what reached the network.
 */
export type FakeObsidian = {
  url: string;
  vault: Map<string, string>;
  seen: { method: string; path: string; auth?: string }[];
  /** Held back until a test releases it, to force overlap. */
  stall: (path: string) => () => void;
  /** Answer one `"<METHOD> <path>"` with a status instead of serving it. */
  fail: (key: string, status: number) => () => void;
  close: () => Promise<void>;
};

const servers: FakeObsidian[] = [];
after(async () => {
  for (const server of servers) await server.close();
});

export async function serve(
  initial: Iterable<[string, string]> = [],
): Promise<FakeObsidian> {
  const vault = new Map<string, string>(initial);
  const seen: FakeObsidian["seen"] = [];
  const gates = new Map<string, Promise<void>>();
  const broken = new Map<string, number>();
  const server = createServer(async (req, res) => {
    // The client percent-encodes each segment; decode back to the vault-relative path.
    const path = decodeURIComponent((req.url ?? "").replace(/^\/vault\//, ""));
    seen.push({
      method: req.method ?? "",
      path,
      auth: req.headers.authorization,
    });
    const key = `${req.method} ${path}`;
    await gates.get(key);
    const status = broken.get(key);
    if (status !== undefined) return void res.writeHead(status).end("nope");
    if (req.method === "GET") {
      const body = vault.get(path);
      if (body === undefined) return void res.writeHead(404).end("not found");
      return void res.writeHead(200).end(body);
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      vault.set(path, Buffer.concat(chunks).toString("utf8"));
      return void res.writeHead(204).end();
    }
    if (req.method === "DELETE") {
      if (!vault.delete(path)) return void res.writeHead(404).end();
      return void res.writeHead(204).end();
    }
    res.writeHead(500).end("boom");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const fake: FakeObsidian = {
    url: `http://127.0.0.1:${port}`,
    vault,
    seen,
    stall: (key: string) => {
      let release = () => {};
      gates.set(
        key,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => {
        gates.delete(key);
        release();
      };
    },
    fail: (key: string, status: number) => {
      broken.set(key, status);
      return () => void broken.delete(key);
    },
    close: () =>
      new Promise<void>((resolve) => void server.close(() => resolve())),
  };
  servers.push(fake);
  return fake;
}

export async function client(
  over: Partial<ObsidianConfig> = {},
  initial: Iterable<[string, string]> = [],
) {
  const fake = await serve(initial);
  const obsidian = new ObsidianClient({
    ...testConfig.obsidian,
    url: fake.url,
    key: "hunter2",
    ...over,
  });
  return { obsidian, fake };
}
