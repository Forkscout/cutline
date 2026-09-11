/**
 * The workspace store over its API: brand kits, looks, recipes and references.
 *
 *   bun scripts/workspace-check.ts
 *
 * Saves an item twice and checks the version went up, round-trips a file,
 * checks that bad names and unknown kinds are refused, and deletes the item
 * with its files. Touches nothing but the item it makes. Needs `bun run dev`.
 */

const WEB = process.env.CUTLINE_WEB_URL ?? "http://localhost:5310";
const API = process.env.CUTLINE_API_URL ?? "http://127.0.0.1:5311";
const html = await (await fetch(WEB)).text();
const token = /name="cutline-token" content="([a-f0-9]+)"/.exec(html)?.[1];
if (!token) throw new Error("No token in the page — is `bun run dev` running?");

async function api(route: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-cutline-token", token!);
  return fetch(`${API}/api${route}`, { ...init, headers });
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const id = `check-kit-${crypto.randomUUID().slice(0, 8)}`;
const kit = `/workspace/brand-kits/${id}`;
try {
  const first = (await (await api(kit, json("PUT", { id: "ignored", name: "Check kit", colors: ["#123456"] }))).json()) as { id: string; version: number };
  const second = (await (await api(kit, json("PUT", { name: "Check kit", colors: ["#654321"] }))).json()) as { version: number; colors: string[] };
  check("a save is version 1, the next version 2", first.version === 1 && second.version === 2, `${first.version} → ${second.version}`);
  check("the id comes from the URL, not the body", first.id === id);
  const listed = (await (await api("/workspace/brand-kits")).json()) as { id: string }[];
  check("it is listed", listed.some((k) => k.id === id));

  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
  const put = await api(`${kit}/files/logo.png`, { method: "PUT", body: png });
  const got = new Uint8Array(await (await api(`${kit}/files/logo.png`)).arrayBuffer());
  check("a file goes in and comes back the same", put.ok && got.length === png.length && got.every((b, i) => b === png[i]), `${got.length} bytes`);
  check("a name that climbs out is refused", (await api(`${kit}/files/..%2Fescape.png`, { method: "PUT", body: png })).status === 400);
  check("an unknown kind is not a route", (await api("/workspace/secrets")).status === 404);

  await api(kit, { method: "DELETE" });
  check("a delete takes the item and its files", (await api(kit)).status === 404 && (await api(`${kit}/files/logo.png`)).status === 404);
} finally {
  await api(kit, { method: "DELETE" });
}
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

export {};
