/**
 * Text to speech against stand-in services: what each adapter sends, what it
 * accepts back and what it refuses. No key, no network, no cost.
 *
 *   bun scripts/voice-check.ts
 */

import type { Provider } from "../server/ai";
import { listVoices, probeVoice, speak, voicesInCatalogue } from "../server/tts";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}
const refusal = (p: Promise<unknown>) => p.then(() => "", (err: Error) => err.message);

interface Seen {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}
const seen: Seen[] = [];
let answer: "mp3" | "json" | "pcm" | "401" = "mp3";

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const text = req.method === "POST" ? await req.text() : "";
    seen.push({ path: url.pathname + url.search, headers: Object.fromEntries(req.headers), body: text ? (JSON.parse(text) as Record<string, unknown>) : null });
    if (url.pathname === "/v1/audio/voices") return Response.json({ voices: ["af_bella", "am_adam"] });
    if (url.pathname === "/el/voices") return Response.json({ voices: [{ voice_id: "v1", name: "Asha", labels: { accent: "indian", gender: "female" } }] });
    // Like Gemini TTS through OpenRouter: MP3 is refused, PCM is answered.
    if (url.pathname === "/pcm/audio/speech") {
      const body = JSON.parse(text) as { response_format?: string };
      if (body.response_format !== "pcm") return Response.json({ error: { message: 'Gemini TTS only supports response_format="pcm". Got "mp3".', code: 400 } }, { status: 400 });
      return new Response(new Uint8Array(960), { headers: { "content-type": "audio/pcm" } });
    }
    if (url.pathname === "/v1/audio/speech" || url.pathname.startsWith("/el/text-to-speech/")) {
      if (answer === "401") return new Response("invalid key", { status: 401 });
      if (answer === "json") return Response.json({ error: "model not found" });
      if (answer === "pcm") return new Response(new Uint8Array(480), { headers: { "content-type": "audio/pcm" } });
      return new Response(new Uint8Array(512).fill(0xff), { headers: { "content-type": "audio/mpeg" } });
    }
    return new Response("not found", { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;
const local: Provider = { id: "local", kind: "openai", name: "Kokoro", baseUrl: `${base}/v1`, transcribeModel: "", voiceModel: "kokoro" };
const eleven: Provider = { id: "el", kind: "elevenlabs", name: "ElevenLabs", baseUrl: `${base}/el`, apiKey: "sk-test", transcribeModel: "", voiceModel: "eleven_v3" };
const last = (prefix: string) => [...seen].reverse().find((s) => s.path.startsWith(prefix));

console.log("OpenAI-compatible");
check("a local server's own voices are listed", (await listVoices(local)).map((v) => v.id).join() === "af_bella,am_adam");
const spoken = await speak(local, { text: "  Namaste, Cutline.  ", speed: 1.2, instructions: "warm" });
const sent = last("/v1/audio/speech")?.body;
check(
  "it asks /audio/speech for MP3 in the first voice, with speed and direction",
  sent?.model === "kokoro" && sent.input === "Namaste, Cutline." && sent.voice === "af_bella" && sent.response_format === "mp3" && sent.speed === 1.2 && sent.instructions === "warm",
  JSON.stringify(sent),
);
check("and hands back the audio", spoken.audio.byteLength === 512 && spoken.mime === "audio/mpeg" && spoken.voice === "af_bella");
await speak(local, { text: "Plain.", voice: "am_adam" });
const plain = last("/v1/audio/speech")?.body;
check("a chosen voice is used; speed 1 and no direction are left out", plain?.voice === "am_adam" && !("speed" in plain) && !("instructions" in plain), JSON.stringify(plain));

answer = "json";
const json = await refusal(speak(local, { text: "x" }));
check("a 200 carrying JSON is not audio, and says what it said", /not audio/.test(json) && /model not found/.test(json), json);
answer = "401";
const denied = await refusal(speak(local, { text: "x" }));
check("a refused key says so", /refused the API key \(401\)/.test(denied), denied);
answer = "pcm";
const pcm = await speak(local, { text: "x" });
check(
  "raw PCM is given a WAV header",
  pcm.mime === "audio/wav" && new TextDecoder().decode(pcm.audio.slice(0, 4)) === "RIFF" && new DataView(pcm.audio.buffer).getUint32(24, true) === 24_000 && pcm.audio.byteLength === 524,
);
answer = "mp3";
const long = await speak(local, { text: "a".repeat(4001) }).then(() => null, (err: Error) => err);
check("a script too long for one request is a RangeError that says to split it", long instanceof RangeError && /Split the script/.test(long.message), long?.message);
check("nothing to say is refused", /nothing to say/.test(await refusal(speak(local, { text: "   " }))));
check("no voice model is refused", /no voice model/.test(await refusal(speak({ ...local, voiceModel: undefined }, { text: "Hi" }))));

const gemini: Provider = { ...local, id: "pcm", name: "OpenRouter", baseUrl: `${base}/pcm`, voiceModel: "google/gemini-tts" };
const asked = () => seen.filter((s) => s.path === "/pcm/audio/speech").map((s) => s.body?.response_format);
const first = await speak(gemini, { text: "Namaste", voice: "Kore" });
check("a model that only takes PCM is asked again for PCM, and the audio is wrapped as WAV", asked().join() === "mp3,pcm" && first.mime === "audio/wav" && first.audio.byteLength === 1004, asked().join());
await speak(gemini, { text: "Phir se", voice: "Kore" });
check("and is asked for PCM straight away from then on", asked().join() === "mp3,pcm,pcm", asked().join());

console.log("\nElevenLabs");
const elVoices = await listVoices(eleven);
check("voices come from the account, with accent and gender", elVoices[0]?.id === "v1" && elVoices[0].name === "Asha · indian · female", JSON.stringify(elVoices));
await speak(eleven, { text: "Hello", speed: 1.5 });
const el = last("/el/text-to-speech/");
check(
  "it is asked for MP3 in its own shape, with its key header and the speed clamped to 1.2",
  el?.path === "/el/text-to-speech/v1?output_format=mp3_44100_128" &&
    el.body?.model_id === "eleven_v3" &&
    el.body.text === "Hello" &&
    (el.body.voice_settings as { speed?: number } | undefined)?.speed === 1.2 &&
    el.headers["xi-api-key"] === "sk-test",
  JSON.stringify(el),
);

console.log("\nProbing");
check("a voice that speaks probes as able", (await probeVoice(local)).voice === true);
check("no voice model: nothing to probe", Object.keys(await probeVoice({ ...local, voiceModel: undefined })).length === 0);
answer = "401";
const probed = await probeVoice(local);
check("a voice that cannot speak probes as unable, with why", probed.voice === false && /refused/.test(probed.voiceMessage ?? ""), probed.voiceMessage);
answer = "mp3";

console.log("\nOpenRouter's catalogue");
const catalogue = [
  { id: "google/gemini-3.1-flash-tts-preview", canonical_slug: "google/gemini-3.1-flash-tts-preview-20260801", supported_voices: ["Kore", "Puck"] },
  { id: "fish-audio/s1", supported_voices: null },
];
check(
  "a model's voices are found by id or by dated slug",
  voicesInCatalogue(catalogue, "google/gemini-3.1-flash-tts-preview")?.join() === "Kore,Puck" && voicesInCatalogue(catalogue, "google/gemini-3.1-flash-tts-preview-20260801")?.length === 2,
);
check("a model with no voice list has none; one not in the catalogue is null", voicesInCatalogue(catalogue, "fish-audio/s1")?.length === 0 && voicesInCatalogue(catalogue, "openai/nope") === null);

server.stop(true);
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures ? 1 : 0);
