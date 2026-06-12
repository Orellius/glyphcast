// glyphcast GPU engine, two paths sharing one canvas/VAO:
// - direct: video frame uploaded as a mipmapped texture, the cell encode
//   (quadrant luma split / halfblock / ascii ramp) computed IN the fragment
//   shader. Zero CPU work and zero readback per frame; fps = video fps.
// - cell-buffer: two cols×rows RGBA8 data textures (fg rgb + glyph idx in
//   alpha; bg rgb) from encodeCells - the renderer for the future wire format.
// Both are ONE draw call = atomic frames (no row tearing).
// Atlas: quadrant glyphs 0-15 as exact fillRect quarters; ascii ramp 16-25.
// NOT responsible for: CPU encoding (encode.ts), control flow (main.ts).
// Test strategy: live browser smoke via window.__gc bench + PSNR vs source.

export const GLYPH_COUNT = 26
const GW = 32
const GH = 64
const RAMP = ' .:-=+*#%@'

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main() { vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uFg;
uniform sampler2D uBg;
uniform sampler2D uAtlas;
uniform vec2 uGrid;
uniform float uGlyphs;
in vec2 vUV;
out vec4 frag;
void main() {
  vec2 cell = vec2(vUV.x, 1.0 - vUV.y) * uGrid;
  ivec2 ci = ivec2(min(floor(cell), uGrid - 1.0));
  vec4 fg = texelFetch(uFg, ci, 0);
  vec4 bg = texelFetch(uBg, ci, 0);
  float gi = floor(fg.a * 255.0 + 0.5);
  vec2 inCell = fract(cell);
  float a = texture(uAtlas, vec2((gi + inCell.x) / uGlyphs, inCell.y)).a;
  frag = vec4(mix(bg.rgb, fg.rgb, a), 1.0);
}`

const FRAG_DIRECT = `#version 300 es
precision highp float;
uniform sampler2D uVideo;
uniform sampler2D uAtlas;
uniform vec2 uGrid;
uniform float uGlyphs;
uniform float uLod;
uniform int uMode;
uniform float uStep;
uniform float uSharp;
in vec2 vUV;
out vec4 frag;

const vec3 LW = vec3(0.2126, 0.7152, 0.0722);

vec3 tap(vec2 uv) { return textureLod(uVideo, uv, uLod).rgb; }

vec3 sharpTap(vec2 uv, vec2 pitch) {
  vec3 c = tap(uv);
  if (uSharp <= 0.0) return c;
  vec3 n = tap(uv - vec2(pitch.x, 0.0)) + tap(uv + vec2(pitch.x, 0.0))
         + tap(uv - vec2(0.0, pitch.y)) + tap(uv + vec2(0.0, pitch.y));
  return clamp(c * (1.0 + 4.0 * uSharp) - uSharp * n, 0.0, 1.0);
}

vec3 quant(vec3 c) {
  if (uStep <= 0.0) return c;
  return floor(c / uStep) * uStep;
}

void main() {
  vec2 cell = vec2(vUV.x, 1.0 - vUV.y) * uGrid;
  vec2 ci = floor(min(cell, uGrid - 1.0));
  vec2 f = cell - ci;
  vec2 cuv = 1.0 / uGrid;

  if (uMode == 1) {
    vec2 sub = vec2(0.5, f.y < 0.5 ? 0.25 : 0.75);
    frag = vec4(quant(sharpTap((ci + sub) * cuv, cuv * 0.5)), 1.0);
    return;
  }
  if (uMode == 2) {
    vec3 c = textureLod(uVideo, (ci + 0.5) * cuv, uLod + 1.0).rgb;
    float gi = 16.0 + floor(min(dot(c, LW), 0.999) * 10.0);
    float a = texture(uAtlas, vec2((gi + f.x) / uGlyphs, f.y)).a;
    frag = vec4(quant(c) * a, 1.0);
    return;
  }

  vec2 pitch = cuv * 0.5;
  vec3 c00 = sharpTap((ci + vec2(0.25, 0.25)) * cuv, pitch);
  vec3 c10 = sharpTap((ci + vec2(0.75, 0.25)) * cuv, pitch);
  vec3 c01 = sharpTap((ci + vec2(0.25, 0.75)) * cuv, pitch);
  vec3 c11 = sharpTap((ci + vec2(0.75, 0.75)) * cuv, pitch);
  vec4 l = vec4(dot(c00, LW), dot(c10, LW), dot(c01, LW), dot(c11, LW));
  float avg = (l.x + l.y + l.z + l.w) * 0.25;
  bvec4 on = greaterThan(l, vec4(avg));
  vec3 fgSum = vec3(0.0); float fn = 0.0;
  vec3 bgSum = vec3(0.0); float bn = 0.0;
  if (on.x) { fgSum += c00; fn += 1.0; } else { bgSum += c00; bn += 1.0; }
  if (on.y) { fgSum += c10; fn += 1.0; } else { bgSum += c10; bn += 1.0; }
  if (on.z) { fgSum += c01; fn += 1.0; } else { bgSum += c01; bn += 1.0; }
  if (on.w) { fgSum += c11; fn += 1.0; } else { bgSum += c11; bn += 1.0; }
  vec3 bg = bn > 0.0 ? bgSum / bn : fgSum / max(fn, 1.0);
  vec3 fg = fn > 0.0 ? fgSum / fn : bg;
  bool isOn = f.x < 0.5 ? (f.y < 0.5 ? on.x : on.z) : (f.y < 0.5 ? on.y : on.w);
  frag = vec4(quant(isOn ? fg : bg), 1.0);
}`

function buildAtlas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = GLYPH_COUNT * GW
  c.height = GH
  const x = c.getContext('2d')!
  x.fillStyle = '#fff'
  for (let i = 0; i < 16; i++) {
    const ox = i * GW
    if (i & 1) x.fillRect(ox, 0, GW / 2, GH / 2)
    if (i & 2) x.fillRect(ox + GW / 2, 0, GW / 2, GH / 2)
    if (i & 4) x.fillRect(ox, GH / 2, GW / 2, GH / 2)
    if (i & 8) x.fillRect(ox + GW / 2, GH / 2, GW / 2, GH / 2)
  }
  x.font = `${Math.round(GH * 0.82)}px Menlo, Consolas, monospace`
  x.textAlign = 'center'
  x.textBaseline = 'middle'
  for (let i = 0; i < RAMP.length; i++) x.fillText(RAMP[i], (16 + i) * GW + GW / 2, GH / 2)
  return c
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader compile failed')
  return sh
}

export function createRendererGL(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false })
  if (!gl) throw new Error('webgl2 unavailable')

  const prog = gl.createProgram()!
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link failed')
  gl.useProgram(prog)

  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  const vbo = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

  const newTex = (unit: number) => {
    const t = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  newTex(0)
  newTex(1)
  newTex(2)
  gl.activeTexture(gl.TEXTURE2)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, buildAtlas())

  gl.uniform1i(gl.getUniformLocation(prog, 'uFg'), 0)
  gl.uniform1i(gl.getUniformLocation(prog, 'uBg'), 1)
  gl.uniform1i(gl.getUniformLocation(prog, 'uAtlas'), 2)
  gl.uniform1f(gl.getUniformLocation(prog, 'uGlyphs'), GLYPH_COUNT)
  const uGrid = gl.getUniformLocation(prog, 'uGrid')

  const progD = gl.createProgram()!
  gl.attachShader(progD, compile(gl, gl.VERTEX_SHADER, VERT))
  gl.attachShader(progD, compile(gl, gl.FRAGMENT_SHADER, FRAG_DIRECT))
  gl.linkProgram(progD)
  if (!gl.getProgramParameter(progD, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(progD) ?? 'direct link failed')
  gl.useProgram(progD)
  gl.uniform1i(gl.getUniformLocation(progD, 'uVideo'), 3)
  gl.uniform1i(gl.getUniformLocation(progD, 'uAtlas'), 2)
  gl.uniform1f(gl.getUniformLocation(progD, 'uGlyphs'), GLYPH_COUNT)
  const dGrid = gl.getUniformLocation(progD, 'uGrid')
  const dLod = gl.getUniformLocation(progD, 'uLod')
  const dMode = gl.getUniformLocation(progD, 'uMode')
  const dStep = gl.getUniformLocation(progD, 'uStep')
  const dSharp = gl.getUniformLocation(progD, 'uSharp')

  const videoTex = newTex(3)
  gl.activeTexture(gl.TEXTURE3)
  gl.bindTexture(gl.TEXTURE_2D, videoTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  let texCols = 0
  let texRows = 0
  let vidW = 0
  let vidH = 0
  const MODE_IDX = { quadrant: 0, halfblock: 1, ascii: 2 } as const

  return {
    resize(cssW: number, cssH: number) {
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`
      gl.viewport(0, 0, canvas.width, canvas.height)
    },
    render(fg: Uint8Array, bg: Uint8Array, cols: number, rows: number) {
      gl.useProgram(prog)
      if (cols !== texCols || rows !== texRows) {
        texCols = cols
        texRows = rows
        gl.activeTexture(gl.TEXTURE0)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
        gl.activeTexture(gl.TEXTURE1)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
        gl.uniform2f(uGrid, cols, rows)
      }
      gl.activeTexture(gl.TEXTURE0)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, fg)
      gl.activeTexture(gl.TEXTURE1)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, bg)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    renderDirect(video: HTMLVideoElement, cols: number, rows: number, mode: keyof typeof MODE_IDX, qShift: number, sharp: number) {
      gl.useProgram(progD)
      gl.activeTexture(gl.TEXTURE3)
      if (video.videoWidth !== vidW || video.videoHeight !== vidH) {
        vidW = video.videoWidth
        vidH = video.videoHeight
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video)
      }
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.uniform2f(dGrid, cols, rows)
      gl.uniform1f(dLod, Math.max(Math.log2(Math.max(vidW / (cols * 2), vidH / (rows * 2))) - 1, 0))
      gl.uniform1i(dMode, MODE_IDX[mode])
      gl.uniform1f(dStep, qShift > 0 ? (1 << qShift) / 255 : 0)
      gl.uniform1f(dSharp, sharp)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    finish() {
      gl.finish()
    },
  }
}
