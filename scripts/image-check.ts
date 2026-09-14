/**
 * Image generation against stand-in services: what each adapter sends, what it
 * takes back and what it refuses. No model, no network, no cost.
 *
 *   bun scripts/image-check.ts
 */

import { deflateSync } from "node:zlib";
import type { Provider } from "../server/ai";
import { ImageTooLarge, generateImage, imageStatus, openAiImageRequest, probeImage, sameModel } from "../server/image";
import { imageSizeFor, licenceOf, licenceWarning } from "../src/editor/image-models";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}
const refusal = (p: Promise<unknown>) => p.then(() => null, (err: Error) => err);

/** A real PNG: a left-to-right gradient, so it is not blank. */
function png(width: number, height: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.slice(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      raw[at] = Math.round((255 * x) / width);
      raw[at + 1] = 80;
      raw[at + 2] = 255 - Math.round((255 * x) / width);
    }
  }
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  return new Uint8Array(Buffer.concat(parts));
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}
const seen: Seen[] = [];
let answer: "ok" | "error" | "bad" | "text" | "big" = "ok";
let appModel = "z_image_turbo_1.0_q8p.ckpt";

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const text = req.method === "POST" ? await req.text() : "";
    seen.push({ method: req.method, path: url.pathname, body: text ? (JSON.parse(text) as Record<string, unknown>) : null });
    const image = () => {
      if (answer === "error") return Response.json({ error: { message: "CUDA out of memory" } }, { status: 500 });
      if (answer === "bad") return Response.json(url.pathname.includes("sdapi") ? { images: ["this is not base64!"] } : { data: [{ b64_json: "this is not base64!" }] });
      if (answer === "text") return Response.json(url.pathname.includes("sdapi") ? { images: [b64(new TextEncoder().encode("hello, not a picture"))] } : { data: [{ b64_json: b64(new TextEncoder().encode("hello, not a picture")) }] });
      if (answer === "big") return Response.json({ data: [{ b64_json: b64(new Uint8Array(3 * 1024 * 1024)) }] });
      const body = JSON.parse(text) as { width?: number; height?: number; size?: string };
      const [w, h] = body.size ? body.size.split("x").map(Number) : [body.width ?? 64, body.height ?? 64];
      const picture = b64(png(Math.min(w!, 320), Math.min(h!, 320)));
      return url.pathname.includes("sdapi") ? Response.json({ images: [picture], info: JSON.stringify({ seed: 424242 }) }) : Response.json({ data: [{ b64_json: picture }] });
    };
    // Like Draw Things: its settings as JSON at /, and txt2img.
    if (url.pathname === "/dt/" && req.method === "GET") return Response.json({ model: appModel, steps: 8, width: 1024, height: 1024 });
    if (url.pathname === "/dt/sdapi/v1/txt2img") return image();
    // Like AUTOMATIC1111: a web page at /, the loaded checkpoint in its options.
    if (url.pathname === "/a1/" && req.method === "GET") return new Response("<html>Stable Diffusion</html>", { headers: { "content-type": "text/html" } });
    if (url.pathname === "/a1/sdapi/v1/options") return Response.json({ sd_model_checkpoint: "sd_xl_base_1.0.safetensors [31e35c80fc]" });
    if (url.pathname === "/a1/sdapi/v1/txt2img") return image();
    if (url.pathname === "/v1/images/generations") return image();
    return new Response("not found", { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;
const local: Provider = { id: "sd", kind: "openai", name: "sd-server", baseUrl: `${base}/v1`, transcribeModel: "", imageModel: "z-image-turbo" };
const drawThings: Provider = { id: "dt", kind: "a1111", name: "Draw Things", baseUrl: `${base}/dt`, transcribeModel: "", imageModel: "current" };
const automatic: Provider = { id: "a1", kind: "a1111", name: "A1111", baseUrl: `${base}/a1`, transcribeModel: "", imageModel: "flux1-schnell.safetensors" };
const last = (path: string) => [...seen].reverse().find((s) => s.path === path);

console.log("OpenAI images API");
const drawn = await generateImage(local, { prompt: "  A tea stall at dawn  ", negativePrompt: "text, watermark", width: 1536, height: 896, steps: 8 });
const sent = last("/v1/images/generations")?.body;
check(
  "a local server is sent pixels, a seed, the negative prompt and steps, and asked for base64",
  sent?.model === "z-image-turbo" && sent.prompt === "A tea stall at dawn" && sent.size === "1536x896" && sent.negative_prompt === "text, watermark" && sent.steps === 8 && sent.response_format === "b64_json" && Number.isInteger(sent.seed),
  JSON.stringify(sent),
);
check("and a PNG comes back with its size and the seed that was sent", drawn.mime === "image/png" && drawn.width === 320 && drawn.height === 320 && drawn.seed === sent?.seed, `${drawn.width}×${drawn.height} seed ${drawn.seed}`);
await generateImage(local, { prompt: "Same again", width: 512, height: 512, seed: 77 });
check("a seed given is the seed sent", last("/v1/images/generations")?.body?.seed === 77);

const openRouter = openAiImageRequest({ ...local, baseUrl: "https://openrouter.ai/api/v1" }, "black-forest-labs/flux-2-pro", { prompt: "A tea stall", negativePrompt: "text", width: 1536, height: 896, seed: 5 });
check(
  "OpenRouter gets /images with an aspect ratio, the negative prompt in words, and PNG",
  openRouter.route === "images" && openRouter.body.aspect_ratio === "16:9" && openRouter.body.prompt === "A tea stall\n\nAvoid: text" && !("negative_prompt" in openRouter.body) && openRouter.body.output_format === "png" && openRouter.body.seed === 5,
  JSON.stringify(openRouter),
);
const openAi = openAiImageRequest({ ...local, baseUrl: "https://api.openai.com/v1" }, "gpt-image-1", { prompt: "A tea stall", width: 1536, height: 896, seed: 5 });
check("OpenAI gets one of its three sizes and no seed", openAi.route === "images/generations" && openAi.body.size === "1536x1024" && !("seed" in openAi.body), JSON.stringify(openAi.body));

answer = "error";
const provider = await refusal(generateImage(local, { prompt: "x", width: 256, height: 256 }));
check("a provider failure says what it said, and is a 422", /could not draw: 500/.test(provider?.message ?? "") && /out of memory/.test(provider?.message ?? "") && imageStatus(provider) === 422, provider?.message);
answer = "bad";
const bad = await refusal(generateImage(local, { prompt: "x", width: 256, height: 256 }));
check("bad base64 is refused as not base64, a 422", /not base64/.test(bad?.message ?? "") && imageStatus(bad) === 422, bad?.message);
answer = "text";
const notImage = await refusal(generateImage(local, { prompt: "x", width: 256, height: 256 }));
check("base64 that is not a picture is refused, a 422", /not a PNG, JPEG or WebP/.test(notImage?.message ?? "") && imageStatus(notImage) === 422, notImage?.message);
answer = "big";
const big = await refusal(generateImage(local, { prompt: "x", width: 256, height: 256 }, { maxBytes: 1024 * 1024 }));
check("an image over the limit is refused while reading it, a 413", big instanceof ImageTooLarge && imageStatus(big) === 413, big?.message);
answer = "ok";
check("an empty prompt is refused", /nothing to draw/.test((await refusal(generateImage(local, { prompt: "  ", width: 256, height: 256 })))?.message ?? ""));
check("a size that is not whole pixels in range is refused", /whole pixels/.test((await refusal(generateImage(local, { prompt: "x", width: 10, height: 256 })))?.message ?? ""));
check("no image model is refused", /no image model/.test((await refusal(generateImage({ ...local, imageModel: undefined }, { prompt: "x", width: 256, height: 256 })))?.message ?? ""));

console.log("\nDraw Things (AUTOMATIC1111 API)");
const dt = await generateImage(drawThings, { prompt: "A tea stall", negativePrompt: "blur", width: 1024, height: 576, steps: 8, seed: 9 });
const dtBody = last("/dt/sdapi/v1/txt2img")?.body;
check(
  "txt2img is sent the prompt, negative prompt, size, seed and steps, and no model",
  dtBody?.prompt === "A tea stall" && dtBody.negative_prompt === "blur" && dtBody.width === 1024 && dtBody.height === 576 && dtBody.seed === 9 && dtBody.steps === 8 && !("override_settings" in dtBody),
  JSON.stringify(dtBody),
);
check("left to the app, the model recorded is the one the app has selected", dt.model === appModel && dt.modelUsed === appModel, `${dt.model} / ${dt.modelUsed}`);
check("the seed the server reports is the one recorded", dt.seed === 424242);
await generateImage({ ...drawThings, imageModel: "Z_Image_Turbo_1.0_q8p" }, { prompt: "x", width: 512, height: 512 });
check("a pinned model the app has selected draws, spelling aside", last("/dt/sdapi/v1/txt2img") !== undefined && sameModel("z_image_turbo_1.0_q8p.ckpt", "Z_Image_Turbo_1.0_q8p"));
const before = seen.filter((s) => s.path === "/dt/sdapi/v1/txt2img").length;
const other = await refusal(generateImage({ ...drawThings, imageModel: "flux_2_klein_4b_q8p.ckpt" }, { prompt: "x", width: 512, height: 512 }));
check(
  "a pinned model the app does not have selected is refused before drawing, saying what to select",
  /has z_image_turbo_1\.0_q8p\.ckpt selected/.test(other?.message ?? "") && /Select flux_2_klein_4b_q8p\.ckpt in Draw Things/.test(other?.message ?? "") && seen.filter((s) => s.path === "/dt/sdapi/v1/txt2img").length === before,
  other?.message,
);

console.log("\nAUTOMATIC1111");
const a1 = await generateImage(automatic, { prompt: "A tea stall", width: 1024, height: 1024, guidance: 3.5, sampler: "Euler" });
const a1Body = last("/a1/sdapi/v1/txt2img")?.body;
check(
  "a pinned model A1111 does not have loaded is asked for with override_settings, with guidance and sampler",
  (a1Body?.override_settings as { sd_model_checkpoint?: string } | undefined)?.sd_model_checkpoint === "flux1-schnell.safetensors" && a1Body?.cfg_scale === 3.5 && a1Body.sampler_name === "Euler",
  JSON.stringify(a1Body),
);
check("and recorded as the model used", a1.model === "flux1-schnell.safetensors" && a1.modelUsed === "flux1-schnell.safetensors");

console.log("\nProbing");
check("an image model that draws probes as able", (await probeImage(local)).image === true);
check("no image model: nothing to probe", Object.keys(await probeImage({ ...local, imageModel: undefined })).length === 0);
answer = "error";
const probed = await probeImage(drawThings);
check("one that fails probes as unable, with why", probed.image === false && /out of memory/.test(probed.imageMessage ?? ""), probed.imageMessage);
answer = "ok";

console.log("\nLicences and sizes");
check("Z-Image Turbo, FLUX.2 [klein] 4B and Qwen-Image are Apache 2.0", ["z_image_turbo_1.0_q8p.ckpt", "flux_2_klein_4b_q8p.ckpt", "qwen_image_edit_2509_q6p.ckpt"].every((m) => licenceOf(m, true)?.commercial === true));
check("FLUX.2 [klein] 9B and FLUX.1 dev are non-commercial", ["flux_2_klein_9b_q8p.ckpt", "flux_1_dev_q8p.ckpt", "FLUX.1-dev"].every((m) => licenceOf(m, true)?.commercial === false));
check("and warned about", /not for commercial or client work/.test(licenceWarning("flux_2_klein_9b_q8p.ckpt", true) ?? ""));
check("a hosted model claims no licence: the service's terms apply", licenceOf("black-forest-labs/flux-2-klein-9b", false) === null);
const size = imageSizeFor({ width: 1920, height: 1080 });
check("the sequence's shape is asked for in multiples of 64", size.width === 1536 && size.height % 64 === 0 && Math.abs(size.width / size.height - 16 / 9) < 0.1, `${size.width}×${size.height}`);

server.stop(true);
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures ? 1 : 0);
