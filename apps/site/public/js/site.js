/* ============================================================================
   Eccos — site behaviour: the theme toggle, entrance reveals, stat count-up,
   the mobile menu and the diagram play-state. Vanilla, no dependencies, no
   external requests. Everything degrades to "already visible / already final"
   without JS and under prefers-reduced-motion. Loaded on every page: the theme
   toggle lives in the masthead of the landing, the legal shells and the 404.
   ========================================================================== */

(function () {
  "use strict";

  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var hasIO = "IntersectionObserver" in window;

  /* ---------- 1. theme: auto -> light -> dark -> auto ----------

     The <head> snippet has already stamped an override on <html> before the
     stylesheet parsed, so there is no flash to undo here. This wires the
     button, keeps the two theme-color metas and the light <picture> sources in
     sync with an override, and announces every effective-theme change on the
     window as "eccos:theme" so the hero shader can re-tune without a re-init.

     data-theme absent = auto (follow the system). Never "auto" as a value. */

  var root = document.documentElement;
  var KEY = "eccos-theme";
  var MODES = ["auto", "light", "dark"];
  var LIGHT_MQ = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;

  var themeBtn = document.getElementById("theme-toggle");
  var metas = [].slice.call(document.querySelectorAll('meta[name="theme-color"]'));
  /* the authored per-scheme values, so returning to auto restores them exactly */
  var metaAuto = metas.map(function (m) { return m.getAttribute("content"); });
  var lightSrcs = [].slice.call(document.querySelectorAll(".own-src-light"));
  var SRC_AUTO = "(prefers-color-scheme: light)";

  function storedMode() {
    try {
      var v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : "auto";
    } catch (e) {
      return "auto";
    }
  }

  function storeMode(mode) {
    try {
      if (mode === "auto") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, mode);
    } catch (e) {}
  }

  function effectiveTheme() {
    var attr = root.getAttribute("data-theme");
    if (attr === "light" || attr === "dark") return attr;
    return LIGHT_MQ && LIGHT_MQ.matches ? "light" : "dark";
  }

  function emitTheme(theme) {
    var ev;
    try {
      ev = new CustomEvent("eccos:theme", { detail: { theme: theme } });
    } catch (e) {
      ev = document.createEvent("CustomEvent");
      ev.initCustomEvent("eccos:theme", false, false, { theme: theme });
    }
    window.dispatchEvent(ev);
  }

  function themeModeWord(mode) {
    var attr = themeBtn && themeBtn.getAttribute("data-theme-" + mode);
    if (attr) return attr;
    return mode.charAt(0).toUpperCase() + mode.slice(1);
  }

  function themeLabelWord() {
    var attr = themeBtn && themeBtn.getAttribute("data-theme-label");
    return attr || "Theme";
  }

  function applyMode(mode) {
    if (mode === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
    storeMode(mode);

    if (themeBtn) {
      themeBtn.setAttribute("data-mode", mode);
      var txt = themeLabelWord() + ": " + themeModeWord(mode);
      themeBtn.setAttribute("aria-label", txt);
      themeBtn.setAttribute("title", txt);
    }

    var theme = effectiveTheme();

    /* an override has to win over the metas' own media queries, so both carry
       the effective colour; auto hands them back their authored values */
    metas.forEach(function (m, i) {
      m.setAttribute("content", mode === "auto" ? metaAuto[i] : theme === "light" ? "#f7f9f8" : "#070c0f");
    });

    /* same trick for the daylight art: the <source> media attr is what the
       no-JS path follows, so an override rewrites it rather than duplicating
       the DOM. <picture> re-runs its selection when the attribute changes. */
    var srcMedia = mode === "auto" ? SRC_AUTO : theme === "light" ? "all" : "not all";
    lightSrcs.forEach(function (s) { s.setAttribute("media", srcMedia); });

    emitTheme(theme);
  }

  var themeMode = storedMode();
  applyMode(themeMode);

  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      themeMode = MODES[(MODES.indexOf(themeMode) + 1) % MODES.length];
      applyMode(themeMode);
    });
  }

  var localeSwitch = document.querySelector(".lang-switch");
  if (localeSwitch) {
    localeSwitch.addEventListener("click", function () {
      var locale = localeSwitch.getAttribute("hreflang");
      if (locale !== "en" && locale !== "es") return;
      try { localStorage.setItem("eccos-locale", locale); } catch (e) {}
    });
  }

  if (LIGHT_MQ) {
    var onScheme = function () { if (themeMode === "auto") applyMode("auto"); };
    if (LIGHT_MQ.addEventListener) LIGHT_MQ.addEventListener("change", onScheme);
    else if (LIGHT_MQ.addListener) LIGHT_MQ.addListener(onScheme);
  }

  /* ---------- 2. entrance reveals ---------- */

  var reveals = [].slice.call(document.querySelectorAll(".reveal"));

  function show(el) { el.classList.add("in"); }

  if (reduced || !hasIO) {
    reveals.forEach(show);
  } else {
    var hero = document.getElementById("hero");
    var heroKids = hero ? [].slice.call(hero.querySelectorAll(".reveal")) : [];

    /* the hero rises on load, staggered by CSS transition-delay */
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () { heroKids.forEach(show); });
    });

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        show(entry.target);
        io.unobserve(entry.target);
      });
    }, { threshold: 0.15, rootMargin: "0px 0px -4% 0px" });

    reveals.forEach(function (el) {
      if (heroKids.indexOf(el) !== -1) return;
      io.observe(el);
    });
  }

  /* ---------- 3. stat count-up ---------- */

  var nums = [].slice.call(document.querySelectorAll(".num[data-count]"));

  // Thousands separators, so the animation lands on "1,950" and not "1950",
  // which reads as a year.
  var groupSep = root.getAttribute("lang") === "es" ? "." : ",";
  function group(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, groupSep);
  }

  function countUp(el) {
    var target = parseInt(el.getAttribute("data-count"), 10);
    if (isNaN(target) || target === 0) return;
    var start = 0;
    var t0 = 0;
    var dur = 1200;
    function step(now) {
      if (!t0) t0 = now;
      var k = Math.min((now - t0) / dur, 1);
      var eased = 1 - Math.pow(1 - k, 3);
      el.textContent = group(Math.round(start + (target - start) * eased));
      if (k < 1) window.requestAnimationFrame(step);
      else el.textContent = group(target);
    }
    el.textContent = "0";
    window.requestAnimationFrame(step);
  }

  if (!reduced && hasIO && nums.length) {
    var nio = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        nio.unobserve(entry.target);
        countUp(entry.target);
      });
    }, { threshold: 0.6 });
    nums.forEach(function (el) { nio.observe(el); });
  }

  /* ---------- 4. mobile menu ---------- */

  var toggle = document.getElementById("nav-toggle");
  var nav = document.getElementById("primary-nav");

  if (toggle && nav) {
    var open = false;

    function setOpen(next) {
      open = next;
      nav.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    }

    toggle.addEventListener("click", function () { setOpen(!open); });

    nav.addEventListener("click", function (e) {
      if (e.target.tagName === "A") setOpen(false);
    });

    document.addEventListener("keydown", function (e) {
      if (!open) return;
      if (e.key === "Escape" || e.key === "Esc") {
        setOpen(false);
        toggle.focus();
      }
    });

    document.addEventListener("click", function (e) {
      if (!open) return;
      if (nav.contains(e.target) || toggle.contains(e.target)) return;
      setOpen(false);
    });

    window.addEventListener("resize", function () {
      if (open && window.innerWidth >= 760) setOpen(false);
    }, { passive: true });
  }

  /* ---------- 5. diagrams only animate while on screen ---------- */

  var diagrams = [].slice.call(document.querySelectorAll(".dg"));

  if (!reduced && hasIO && diagrams.length) {
    var onScreen = [];

    function applyPlayState() {
      diagrams.forEach(function (el, i) {
        el.classList.toggle("is-paused", document.hidden || !onScreen[i]);
      });
    }

    var dio = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var i = diagrams.indexOf(entry.target);
        if (i !== -1) onScreen[i] = entry.isIntersecting;
      });
      applyPlayState();
    }, { threshold: 0.05 });

    diagrams.forEach(function (el) { dio.observe(el); });
    document.addEventListener("visibilitychange", applyPlayState);
  }
})();
