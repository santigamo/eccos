/* ============================================================================
   Eccos — hero "iridescent silk" shader.
   Vanilla WebGL1, no libraries, no external requests.

   Two virtual silk layers are mixed in a single fragment pass: high-frequency
   diagonal sine bands whose phase is warped by drifting value-noise fbm, shaped
   by a broad fold envelope, tinted emerald -> teal -> cyan with a faint warm
   glint at the brightest folds, then vignetted to black towards the left and
   bottom so the hero copy always clears AA contrast.

   The same weave is read twice. u_light = 0 is that nocturnal silk, untouched;
   u_light = 1 is its daylight reading — nacre on paper, form carried by the
   troughs and the vignette inverted so the edges bleach into the page. The two
   are cross-faded on the page's "eccos:theme" event, live, with no re-init.

   Bails out (leaving the CSS --hero-fallback still image visible) when the
   visitor prefers reduced motion, when WebGL is unavailable, or when the
   context is lost. Paused off-screen and while the tab is hidden.
   ========================================================================== */

(function () {
  "use strict";

  var hero = document.getElementById("hero");
  if (!hero) return;

  var bg = hero.querySelector(".hero-bg");
  if (!bg) return;

  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var VERT = [
    "attribute vec2 aPos;",
    "void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }"
  ].join("\n");

  var FRAG = [
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

    "  float left   = smoothstep(0.02, 0.66, st.x);",
    "  float bottom = smoothstep(-0.02, 0.44, st.y);",
    "  float top    = 1.0 - smoothstep(0.68, 1.06, st.y);",
    "  float right  = 1.0 - smoothstep(0.84, 1.06, st.x);",
    "  float edge = left * bottom * mix(0.55, 1.0, top) * mix(0.62, 1.0, right);",
    "  night *= edge;",

    /* day — the same weave as matter, not emission. The sheet starts ivory and
       is shaped downwards: the fold valleys and the gaps between threads sink
       towards a teal-grey, so form comes from shadow the way it does on paper.
       The interference hue is a low-amplitude pigment wash (headline ink still
       clears ~12:1 over the brightest band), the warm glint turns pale gold,
       and the vignette inverts — edges bleach towards --bg instead of to black,
       kept at 82% so the nacre never fully dissolves into the page. */
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
    "}"
  ].join("\n");

  var opts = {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "low-power",
    failIfMajorPerformanceCaveat: false
  };

  var canvas = document.createElement("canvas");
  canvas.className = "hero-canvas";
  canvas.setAttribute("aria-hidden", "true");

  var gl = null;
  try {
    gl = canvas.getContext("webgl", opts) || canvas.getContext("experimental-webgl", opts);
  } catch (e) {
    gl = null;
  }
  if (!gl) return;

  function compile(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  var vs = compile(gl.VERTEX_SHADER, VERT);
  var fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return;

  var prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;

  gl.useProgram(prog);

  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  var uRes = gl.getUniformLocation(prog, "uRes");
  var uTime = gl.getUniformLocation(prog, "uTime");
  var uLight = gl.getUniformLocation(prog, "u_light");

  /* Which palette to run. Same resolution rule as site.js: an explicit
     data-theme override wins, otherwise follow the system. */
  function isLight() {
    var attr = document.documentElement.getAttribute("data-theme");
    if (attr === "light" || attr === "dark") return attr === "light";
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  }

  gl.uniform1f(uLight, isLight() ? 1.0 : 0.0);

  bg.parentNode.insertBefore(canvas, bg.nextSibling);

  /* ---- sizing: DPR capped at 1.5, plus a total-pixel ceiling ---- */

  var MAX_PIXELS = 2600000;
  var quality = 1;
  var w = 0;
  var h = 0;

  function resize() {
    var rect = hero.getBoundingClientRect();
    var cw = Math.max(1, Math.round(rect.width));
    var ch = Math.max(1, Math.round(rect.height));
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5) * quality;
    var nw = Math.max(1, Math.round(cw * dpr));
    var nh = Math.max(1, Math.round(ch * dpr));
    var total = nw * nh;
    if (total > MAX_PIXELS) {
      var f = Math.sqrt(MAX_PIXELS / total);
      nw = Math.max(1, Math.round(nw * f));
      nh = Math.max(1, Math.round(nh * f));
    }
    if (nw === w && nh === h) return;
    w = nw;
    h = nh;
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.uniform2f(uRes, w, h);
  }

  /* ---- run loop ---- */

  var raf = 0;
  var last = 0;
  var clock = 0;
  var visible = true;
  var alive = true;
  var frames = 0;
  var slow = 0;
  var painted = false;

  function frame(now) {
    raf = 0;
    if (!alive) return;
    if (!last) last = now;
    var dt = (now - last) / 1000;
    last = now;
    if (dt > 0.05) dt = 0.05;
    clock += dt;

    gl.uniform1f(uTime, clock);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (!painted) {
      painted = true;
      canvas.classList.add("ready");
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
  window.addEventListener("resize", function () {
    resize();
    if (!raf) window.requestAnimationFrame(frame);
  }, { passive: true });

  document.addEventListener("visibilitychange", sync);

  /* site.js announces every effective-theme change; swap the palette in place
     and repaint once, even while the loop is parked off-screen. */
  window.addEventListener("eccos:theme", function (e) {
    var light = e && e.detail && e.detail.theme ? e.detail.theme === "light" : isLight();
    if (!alive) return;
    gl.uniform1f(uLight, light ? 1.0 : 0.0);
    if (!raf) window.requestAnimationFrame(frame);
  });

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      sync();
    }, { threshold: 0 }).observe(hero);
  }

  canvas.addEventListener("webglcontextlost", function (e) {
    e.preventDefault();
    alive = false;
    stop();
    canvas.classList.remove("ready");
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  sync();
})();
