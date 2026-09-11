/**
 * Transcription end to end, against a real OpenAI-compatible service.
 *
 *   bun scripts/transcribe-check.ts [baseUrl] [model]
 *
 * Defaults to a whisper.cpp server on this machine:
 *
 *   whisper-server -m ~/.cache/whisper-cpp/ggml-medium.bin \
 *     --inference-path /v1/audio/transcriptions --convert -l auto --port 8178
 *
 * Speaks a known script with macOS `say`, stores it as a take's microphone
 * track, transcribes it through Cutline's server, and checks the words and
 * their times. Leaves any provider the user had already connected alone.
 * Needs `bun run dev` — or, for another instance such as the Docker one,
 * CUTLINE_WEB_URL and CUTLINE_API_URL (both http://localhost:5311 there).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Transcript } from "../src/editor/transcript";

const [baseUrl = "http://127.0.0.1:8178/v1", model = "whisper-1"] = process.argv.slice(2);
const SCRIPT =
  "Cutline records your screen, your camera and your voice as separate files. " +
  "Then you edit them together in the browser, and export without uploading anything.";

const WEB = process.env.CUTLINE_WEB_URL ?? "http://localhost:5310";
const API = process.env.CUTLINE_API_URL ?? "http://127.0.0.1:5311";
const html = await (await fetch(WEB)).text();
const token = /name="cutline-token" content="([a-f0-9]+)"/.exec(html)?.[1];
if (!token) throw new Error("No token in the page — is `bun run dev` running?");

async function api<T>(route: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const headers = new Headers(init.headers);
  headers.set("x-cutline-token", token!);
  const response = await fetch(`${API}/api${route}`, { ...init, headers });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** Word error rate: edit distance over words, ignoring case and punctuation. */
function wer(reference: string, hypothesis: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);
  const r = norm(reference);
  const h = norm(hypothesis);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...new Array<number>(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j += 1) d[0]![j] = j;
  for (let i = 1; i <= r.length; i += 1) {
    for (let j = 1; j <= h.length; j += 1) {
      const cost = r[i - 1] === h[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    }
  }
  return d[r.length]![h.length]! / r.length;
}

async function waitFor(jobId: string): Promise<{ status: string; result?: Transcript; error?: string; ms: number }> {
  const started = performance.now();
  for (;;) {
    const { body } = await api<{ status: string; result?: Transcript; error?: string }>(`/transcribe/${jobId}`);
    if (body.status !== "running") return { ...body, ms: performance.now() - started };
    await Bun.sleep(250);
  }
}

const work = await mkdtemp(path.join(tmpdir(), "cutline-transcribe-"));
const sessionId = `transcribe-check-${crypto.randomUUID()}`;
const providerId = `check-${crypto.randomUUID().slice(0, 8)}`;
const deadId = `check-dead-${crypto.randomUUID().slice(0, 8)}`;

try {
  console.log("providers");
  const added = await api<{ capabilities?: { transcribe: boolean; message?: string } }>(
    `/ai/providers/${providerId}`,
    json("PUT", { name: "transcribe check", baseUrl, transcribeModel: model }),
  );
  check("a transcribing service probes as able to transcribe", added.body.capabilities?.transcribe === true,
    added.body.capabilities?.message ?? baseUrl);

  // Cutline's own API has no transcription route: a stand-in for LM Studio.
  const dead = await api<{ capabilities?: { transcribe: boolean; message?: string } }>(
    `/ai/providers/${deadId}`,
    json("PUT", { name: "no audio", baseUrl: "http://127.0.0.1:5311/api" }),
  );
  check("a service without transcription is reported as such, with a reason",
    dead.body.capabilities?.transcribe === false && Boolean(dead.body.capabilities?.message),
    dead.body.capabilities?.message ?? "");

  const listed = await api<{ id: string; hasKey: boolean; apiKey?: string }[]>("/ai/providers");
  check("keys never come back to the page", listed.body.every((p) => !("apiKey" in p)));

  console.log("\nthe take");
  const aiff = path.join(work, "speech.aiff");
  const webm = path.join(work, "microphone.webm");
  await Bun.spawn(["say", "-v", "Samantha", "-o", aiff, SCRIPT]).exited;
  await Bun.spawn(["ffmpeg", "-v", "error", "-y", "-i", aiff, "-c:a", "libopus", "-b:a", "48k", webm]).exited;
  const upload = await api<{ bytes: number }>(`/recordings/${sessionId}/files/microphone.webm`, {
    method: "PUT",
    body: Bun.file(webm),
  });
  check("the spoken fixture is stored as a take's microphone track", upload.status === 200, `${upload.body.bytes} bytes`);

  console.log("\ntranscribing");
  const start = await api<{ jobId: string }>("/transcribe", json("POST", { sessionId, fileName: "microphone.webm", language: "en" }));
  const whole = await waitFor(start.body.jobId);
  const t = whole.result;
  check("the job finishes", whole.status === "done" && Boolean(t), whole.error ?? `${Math.round(whole.ms)} ms`);
  if (t) {
    const said = t.words.map((w) => w.text).join(" ");
    const rate = wer(SCRIPT, said);
    check("the words are what was said", rate < 0.15, `WER ${(rate * 100).toFixed(1)}% · "${said.slice(0, 90)}…"`);
    check("the service gave word times", t.timing === "word", t.timing);
    check("every word lies inside the audio, in order",
      t.words.every((w, i) => w.start >= 0 && w.end <= t.durationSec + 0.1 && w.end >= w.start && (i === 0 || w.start >= t.words[i - 1]!.start - 0.05)),
      `${t.words.length} words over ${t.durationSec.toFixed(2)} s`);

    const again = await api<{ jobId: string }>("/transcribe", json("POST", { sessionId, fileName: "microphone.webm", language: "en" }));
    const cached = await waitFor(again.body.jobId);
    check("asking again is answered from the cache", cached.status === "done" && cached.ms < 1000, `${Math.round(cached.ms)} ms`);

    // Parts cut on a copy of the packets, each shifted back by where it began.
    const parts = await api<{ jobId: string }>(
      "/transcribe",
      json("POST", { sessionId, fileName: "microphone.webm", language: "en", force: true, chunkSeconds: 5 }),
    );
    const chunked = await waitFor(parts.body.jobId);
    const c = chunked.result;
    check("a transcript made in parts finishes", chunked.status === "done" && Boolean(c), chunked.error ?? "");
    if (c) {
      const lastWhole = t.words[t.words.length - 1]!.end;
      const lastParts = c.words[c.words.length - 1]!.end;
      check("parts are shifted back into place", Math.abs(lastWhole - lastParts) < 0.75,
        `last word ends at ${lastParts.toFixed(2)} s in parts, ${lastWhole.toFixed(2)} s whole`);
      const rate = wer(SCRIPT, c.words.map((w) => w.text).join(" "));
      check("and still say what was said", rate < 0.3, `WER ${(rate * 100).toFixed(1)}% (a cut through a word costs that word)`);
    }
  }
} finally {
  await api(`/recordings/${sessionId}`, { method: "DELETE" });
  await api(`/ai/providers/${providerId}`, { method: "DELETE" });
  await api(`/ai/providers/${deadId}`, { method: "DELETE" });
  await rm(work, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
