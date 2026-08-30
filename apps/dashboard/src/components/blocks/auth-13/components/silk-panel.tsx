import { useEffect, useRef, useState } from "react";

/**
 * The landing's "iridescent silk" hero shader (apps/site/public/js/shader.js)
 * ported to the pre-auth brand panel. Vanilla WebGL1, no libraries, no
 * external requests. VERT/FRAG are kept byte-identical to the canonical site
 * shader so the two cannot drift; the console runs it dark-only (u_light
 * stays 0 — the console has no daylight reading) and targets this
 * component's host element instead of the site's #hero.
 *
 * Bails out — leaving the CSS fallback gradient visible — on reduced motion,
 * missing WebGL, or context loss. Parks off-screen and on hidden tabs.
 * Sizing caps DPR at 1.5 with a total-pixel ceiling, and takes one adaptive
 * quality step down if the first seconds are janky (same as the site).
 */

const VERT = [
  "attribute vec2 aPos;",
  "void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }",
].join("\n");

const FRAG = [
  "#ifdef GL_FRAGMENT_PRECISION_HIGH",
  "precision highp float;",
  "#else",
  "precision mediump float;",
  "#endif",
  "uniform vec2 uRes;",
  "uniform float uTime;",
  "uniform float u_light;",

  "float hash(vec2 p){",
  "  p = fract(p * vec2(123.34, 456.21));",
  "  p += dot(p, p + 45.32);",
  "  return fract(p.x * p.y);",
  "}",

  "float vnoise(vec2 p){",
  "  vec2 i = floor(p);",
  "  vec2 f = fract(p);",
  "  vec2 u = f * f * (3.0 - 2.0 * f);",
  "  float a = hash(i);",
  "  float b = hash(i + vec2(1.0, 0.0));",
  "  float c = hash(i + vec2(0.0, 1.0));",
  "  float d = hash(i + vec2(1.0, 1.0));",
  "  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);",
  "}",

  "float fbm3(vec2 p){",
  "  float s = 0.0; float a = 0.5;",
  "  for (int i = 0; i < 3; i++){",
  "    s += a * vnoise(p);",
  "    p = p * 2.03 + vec2(11.7, 3.1);",
  "    a *= 0.5;",
  "  }",
  "  return s;",
  "}",

  "float fbm2(vec2 p){",
  "  float s = 0.0; float a = 0.55;",
  "  for (int i = 0; i < 2; i++){",
  "    s += a * vnoise(p);",
  "    p = p * 2.11 + vec2(4.3, 9.2);",
  "    a *= 0.5;",
  "  }",
  "  return s;",
  "}",

  /* x = thread intensity, y = hue key, z = fold envelope */
  "vec3 silk(vec2 p, float t, float freq, float speed){",
  "  float w1 = fbm3(p * 0.85 + vec2(t * speed, -t * speed * 0.55));",
  "  float w2 = fbm2(p * 1.75 + vec2(-t * speed * 0.70, t * speed * 0.42) + w1 * 1.6);",
  "  float fold = smoothstep(0.14, 0.92, w1 * 0.74 + w2 * 0.52);",
  "  float phase = dot(p, vec2(0.82, 0.58)) * freq + w1 * 12.0 + w2 * 7.0 + t * speed * 6.0;",
  "  float band = 0.5 + 0.5 * sin(phase);",
  "  float thread = pow(band, 4.0);",
  "  float fine = pow(0.5 + 0.5 * sin(phase * 2.0 + 1.3), 8.0) * 0.45;",
  "  return vec3((thread + fine) * fold, w2 * 0.62 + w1 * 0.38, fold);",
  "}",

  "void main(){",
  "  vec2 frag = gl_FragCoord.xy;",
  "  vec2 st = frag / uRes;",
  "  vec2 p = (frag - 0.5 * uRes) / uRes.y;",
  "  float t = uTime;",

  "  vec3 a = silk(p * 2.60, t, 42.0, 0.060);",
  "  vec3 b = silk(p * 4.30 + vec2(7.3, -2.1), t * 1.35, 63.0, 0.085);",

  "  float inten = a.x + b.x * 0.50;",
  "  float hue = mix(a.y, b.y, 0.45) + t * 0.018;",
  "  float fold = max(a.z, b.z * 0.85);",

  "  vec3 emerald = vec3(0.145, 0.827, 0.400);",
  "  vec3 teal    = vec3(0.059, 0.702, 0.604);",
  "  vec3 cyan    = vec3(0.133, 0.827, 0.933);",
  "  vec3 warm    = vec3(0.784, 0.525, 0.353);",

  "  float k = 0.5 - 0.5 * cos(hue * 6.28318);",
  "  vec3 col = k < 0.5 ? mix(emerald, teal, k * 2.0) : mix(teal, cyan, (k - 0.5) * 2.0);",

  "  float glint = clamp((inten - 0.72) / 0.28, 0.0, 1.0);",
  "  glint = glint * glint * smoothstep(0.70, 1.0, fold);",

  /* night — the canonical dark palette, arithmetic untouched */
  "  vec3 night = mix(col, warm, glint * 0.34);",
  "  float lum = inten * (0.52 + 0.62 * fold);",
  "  night = night * lum * 1.35 + vec3(0.010, 0.032, 0.030) * fold;",

  /* The console panel is tall and narrow and its copy sits along the left
     edge, so the site's left/bottom/top vignette lands where it should: the
     brightest silk reads on the right, text clears on the left. */
  "  float left   = smoothstep(0.02, 0.66, st.x);",
  "  float bottom = smoothstep(-0.02, 0.44, st.y);",
  "  float top    = 1.0 - smoothstep(0.68, 1.06, st.y);",
  "  float right  = 1.0 - smoothstep(0.84, 1.06, st.x);",
  "  float edge = left * bottom * mix(0.55, 1.0, top) * mix(0.62, 1.0, right);",
  "  night *= edge;",

  /* The site's day branch is kept verbatim so this file stays a pure copy;
     the console never raises u_light above 0. */
  "  vec3 ivory  = vec3(0.955, 0.970, 0.962);",
  "  vec3 trough = vec3(0.665, 0.790, 0.755);",
  "  vec3 gold   = vec3(0.970, 0.900, 0.720);",
  "  vec3 paper  = vec3(0.969, 0.976, 0.973);",
  "  float weave = 1.0 - clamp(inten * 1.35, 0.0, 1.0);",
  "  float shade = clamp((1.0 - fold) * 0.80 + weave * 0.20, 0.0, 1.0);",
  "  vec3 day = mix(ivory, trough, shade * 0.88);",
  "  day = mix(day, col, clamp(inten, 0.0, 1.0) * 0.50 * (0.35 + 0.65 * fold));",
  "  day = mix(day, gold, glint * 0.34);",
  "  day = mix(day, paper, (1.0 - edge) * 0.72);",

  "  vec3 rgb = mix(night, day, u_light);",
  "  rgb += (hash(frag + fract(t)) - 0.5) * 0.0045;",
  "  gl_FragColor = vec4(max(rgb, 0.0), 1.0);",
  "}",
].join("\n");

/** CSS-only still fallback (emerald/teal radials over the silk floor). */
const FALLBACK_BG =
  "radial-gradient(120% 90% at 80% 10%, rgba(37, 211, 102, 0.14), transparent 60%), " +
  "radial-gradient(90% 70% at 20% 90%, rgba(15, 179, 154, 0.10), transparent 55%), " +
  "#04080a";

/** Tailwind's lg breakpoint — the brand panel (and thus the silk) only
 * exists from here up; below it the sign-in form is the whole page. */
const LG_QUERY = "(min-width: 64rem)";

export function SilkPanel({ className }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  // SSR-safe: matchMedia is unavailable during server render, so the canvas
  // is a progressive enhancement that fades in after hydration on desktop
  // (the CSS fallback gradient paints first). Crossing the breakpoint tears
  // the WebGL context down / re-initializes it via the [active] effect.
  const [active, setActive] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.(LG_QUERY).matches === true,
  );

  useEffect(() => {
    const mq = window.matchMedia(LG_QUERY);
    const onChange = (event: MediaQueryListEvent) => setActive(event.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!active) return;
    const host = hostRef.current;
    // A CSS-hidden host (breakpoint crossed before hydration) has no box;
    // never allocate a WebGL context for an invisible panel.
    if (!host || host.clientWidth === 0) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.opacity = "0";
    canvas.style.transition = "opacity 700ms ease";
    host.insertBefore(canvas, host.firstChild);

    const glOpts: WebGLContextAttributes = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "low-power",
      failIfMajorPerformanceCaveat: false,
    };
    let gl: WebGLRenderingContext | null = null;
    try {
      gl =
        (canvas.getContext("webgl", glOpts) as WebGLRenderingContext | null) ||
        (canvas.getContext("experimental-webgl", glOpts) as WebGLRenderingContext | null);
    } catch {
      gl = null;
    }
    if (!gl) return;

    function compile(type: number, src: string): WebGLShader | null {
      const sh = gl!.createShader(type)!;
      gl!.shaderSource(sh, src);
      gl!.compileShader(sh);
      if (!gl!.getShaderParameter(sh, gl!.COMPILE_STATUS)) {
        gl!.deleteShader(sh);
        return null;
      }
      return sh;
    }

    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;

    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, "uRes");
    const uTime = gl.getUniformLocation(prog, "uTime");
    // Dark-only console: the night palette is canonical here, u_light stays 0.
    gl.uniform1f(gl.getUniformLocation(prog, "u_light"), 0.0);

    /* ---- sizing: DPR capped at 1.5, plus a total-pixel ceiling ---- */

    const MAX_PIXELS = 2600000;
    let quality = 1;
    let w = 0;
    let h = 0;

    function resize() {
      const rect = host!.getBoundingClientRect();
      const cw = Math.max(1, Math.round(rect.width));
      const ch = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5) * quality;
      let nw = Math.max(1, Math.round(cw * dpr));
      let nh = Math.max(1, Math.round(ch * dpr));
      const total = nw * nh;
      if (total > MAX_PIXELS) {
        const f = Math.sqrt(MAX_PIXELS / total);
        nw = Math.max(1, Math.round(nw * f));
        nh = Math.max(1, Math.round(nh * f));
      }
      if (nw === w && nh === h) return;
      w = nw;
      h = nh;
      canvas!.width = w;
      canvas!.height = h;
      gl!.viewport(0, 0, w, h);
      gl!.uniform2f(uRes, w, h);
    }

    /* ---- run loop ---- */

    let raf = 0;
    let last = 0;
    let clock = 0;
    let visible = true;
    let alive = true;
    let frames = 0;
    let slow = 0;
    let painted = false;

    function frame(now: number) {
      raf = 0;
      if (!alive) return;
      if (!last) last = now;
      let dt = (now - last) / 1000;
      last = now;
      if (dt > 0.05) dt = 0.05;
      clock += dt;

      gl!.uniform1f(uTime, clock);
      gl!.drawArrays(gl!.TRIANGLES, 0, 3);

      if (!painted) {
        painted = true;
        canvas!.style.opacity = "1";
      }

      /* one adaptive step down if the first couple of seconds are janky */
      if (quality === 1 && frames < 90) {
        frames++;
        if (dt > 0.028) slow++;
        if (frames === 90 && slow > 45) {
          quality = 0.7;
          resize();
        }
      }

      if (visible) raf = window.requestAnimationFrame(frame);
    }

    function start() {
      if (!alive || raf) return;
      last = 0;
      raf = window.requestAnimationFrame(frame);
    }

    function stop() {
      if (raf) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
    }

    function sync() {
      if (visible && !document.hidden) start();
      else stop();
    }

    resize();
    function onResize() {
      resize();
      if (!raf) window.requestAnimationFrame(frame);
    }
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("visibilitychange", sync);

    let visibilityObserver: IntersectionObserver | null = null;
    if ("IntersectionObserver" in window) {
      visibilityObserver = new IntersectionObserver(
        function (entries: IntersectionObserverEntry[]) {
          const first: IntersectionObserverEntry | undefined = entries[0];
          if (!first) return;
          visible = first.isIntersecting;
          sync();
        },
        { threshold: 0 },
      );
      visibilityObserver.observe(host!);
    }

    function onContextLost(e: Event) {
      e.preventDefault();
      alive = false;
      stop();
      canvas!.remove();
    }
    canvas.addEventListener("webglcontextlost", onContextLost);

    function cleanup() {
      if (!alive) return;
      alive = false;
      stop();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", sync);
      visibilityObserver?.disconnect();
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.remove();
    }

    return cleanup;
  }, [active]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className={className}
      style={{ background: FALLBACK_BG }}
    />
  );
}
