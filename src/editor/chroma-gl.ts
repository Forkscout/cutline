/**
 * Chroma keying on the GPU.
 *
 * The JavaScript version reads every pixel back with `getImageData`, walks it,
 * and writes it again — roughly 10–20 ms for a 1080p frame, which is tolerable
 * while paused and destroys playback. The same arithmetic as a fragment shader
 * costs well under a millisecond, because it is the exact shape of work a GPU
 * exists to do.
 *
 * One context and one texture are kept for the life of the page. Creating a
 * WebGL context per frame would be slower than the loop it replaces, and
 * browsers cap how many can exist at once.
 */

const VERTEX = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  // The quad is drawn in clip space; flip Y so the texture is not upside down.
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec3 u_key;
uniform float u_near;
uniform float u_far;
uniform float u_spill;
out vec4 outColour;

void main() {
  vec4 c = texture(u_tex, v_uv);
  float d = distance(c.rgb, u_key);

  // Below u_near the pixel is the key colour and goes fully transparent; the
  // band up to u_far is the soft edge that keeps hair from turning into a
  // stencil.
  float alpha = smoothstep(u_near, u_far, d);

  vec3 rgb = c.rgb;
  if (u_spill > 0.0 && alpha > 0.0) {
    // Spill suppression pulls the dominant key channel back toward the mean of
    // the other two, which is what stops green fringing from glowing.
    if (u_key.g > u_key.r && u_key.g > u_key.b) {
      float avg = (rgb.r + rgb.b) * 0.5;
      if (rgb.g > avg) rgb.g = mix(rgb.g, avg, u_spill);
    } else if (u_key.b > u_key.r && u_key.b > u_key.g) {
      float avg = (rgb.r + rgb.g) * 0.5;
      if (rgb.b > avg) rgb.b = mix(rgb.b, avg, u_spill);
    }
  }

  outColour = vec4(rgb, c.a * alpha);
}`;

interface Kit {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  texture: WebGLTexture;
  uniforms: {
    key: WebGLUniformLocation | null;
    near: WebGLUniformLocation | null;
    far: WebGLUniformLocation | null;
    spill: WebGLUniformLocation | null;
  };
}

let kit: Kit | null = null;
let unavailable = false;

function makeCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return c;
  }
  return new OffscreenCanvas(width, height);
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("chroma shader failed:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function setup(): Kit | null {
  if (unavailable) return null;
  if (kit) return kit;

  const canvas = makeCanvas(2, 2);
  const gl = canvas.getContext("webgl2", {
    premultipliedAlpha: false,
    alpha: true,
    antialias: false,
  }) as WebGL2RenderingContext | null;
  if (!gl) {
    unavailable = true;
    return null;
  }

  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = vs && fs ? gl.createProgram() : null;
  if (!vs || !fs || !program) {
    unavailable = true;
    return null;
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("chroma program failed:", gl.getProgramInfoLog(program));
    unavailable = true;
    return null;
  }

  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  // Two triangles covering clip space.
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const attribute = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(attribute);
  gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture();
  if (!texture) {
    unavailable = true;
    return null;
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.uniform1i(gl.getUniformLocation(program, "u_tex"), 0);

  kit = {
    canvas,
    gl,
    program,
    texture,
    uniforms: {
      key: gl.getUniformLocation(program, "u_key"),
      near: gl.getUniformLocation(program, "u_near"),
      far: gl.getUniformLocation(program, "u_far"),
      spill: gl.getUniformLocation(program, "u_spill"),
    },
  };
  return kit;
}

/** True when the GPU path is usable; callers fall back to the CPU one if not. */
export function chromaGlAvailable(): boolean {
  return setup() !== null;
}

export interface ChromaSettings {
  color: string;
  similarity: number;
  smoothness: number;
  spill: number;
}

function hexToUnitRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  return [
    (parseInt(full.slice(0, 2), 16) || 0) / 255,
    (parseInt(full.slice(2, 4), 16) || 0) / 255,
    (parseInt(full.slice(4, 6), 16) || 0) / 255,
  ];
}

/**
 * Keys the source and returns the canvas holding the result, or null if the GPU
 * path is unavailable. The canvas is reused, so draw from it before the next
 * call.
 */
export function chromaKeyGl(
  source: CanvasImageSource,
  width: number,
  height: number,
  settings: ChromaSettings,
): HTMLCanvasElement | OffscreenCanvas | null {
  const k = setup();
  if (!k || !(width > 0) || !(height > 0)) return null;

  const { gl, canvas } = k;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  gl.viewport(0, 0, width, height);

  gl.bindTexture(gl.TEXTURE_2D, k.texture);
  try {
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source as TexImageSource,
    );
  } catch {
    // A VideoFrame the driver will not accept is a fallback, not a crash.
    return null;
  }

  const key = hexToUnitRgb(settings.color);
  // Distances are in unit RGB space, where the diagonal is sqrt(3).
  const near = settings.similarity * Math.SQRT2;
  gl.uniform3f(k.uniforms.key, key[0], key[1], key[2]);
  gl.uniform1f(k.uniforms.near, near);
  gl.uniform1f(k.uniforms.far, near + Math.max(0.001, settings.smoothness * Math.SQRT2));
  gl.uniform1f(k.uniforms.spill, settings.spill);

  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  return canvas;
}
