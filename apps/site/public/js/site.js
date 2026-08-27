/* ============================================================================
   Eccos — site behaviour: the theme toggle, entrance reveals, stat count-up,
   the mobile menu and the diagram play-state. Vanilla, no dependencies, no
   external requests. Everything degrades to "already visible / already final"
   without JS and under prefers-reduced-motion. Loaded on every page: the theme
   toggle lives in the masthead of the landing, the legal shells and the 404.
   ========================================================================== */

(function () {
  "use strict";

  var cleanup = null;
  var activeThemeTransition = null;
  var countUpHasRun = false;

  function init() {
  if (cleanup) cleanup();

  var disposers = [];
  var observers = [];
  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    disposers.push(function () { target.removeEventListener(type, handler, options); });
  }

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

  function transitionMode(mode) {
    if (reduced || typeof document.startViewTransition !== "function" || root.hasAttribute("data-astro-transition")) {
      applyMode(mode);
      return;
    }

    if (activeThemeTransition) {
      try { activeThemeTransition.skipTransition(); } catch (e) {}
      activeThemeTransition = null;
    }

    root.setAttribute("data-eccos-theme-transition", "");
    var applied = false;
    try {
      var viewTransition = document.startViewTransition(function () {
        applied = true;
        applyMode(mode);
      });
      activeThemeTransition = viewTransition;
      var finish = function () {
        if (activeThemeTransition !== viewTransition) return;
        activeThemeTransition = null;
        root.removeAttribute("data-eccos-theme-transition");
      };
      var timeout = window.setTimeout(finish, 700);
      if (viewTransition.finished) viewTransition.finished.then(function () {
        window.clearTimeout(timeout);
        finish();
      }, function () {
        window.clearTimeout(timeout);
        finish();
      });
      else {
        window.clearTimeout(timeout);
        finish();
      }
    } catch (e) {
      if (!applied) applyMode(mode);
      root.removeAttribute("data-eccos-theme-transition");
      activeThemeTransition = null;
    }
  }

  var themeMode = storedMode();
  applyMode(themeMode);

  if (themeBtn) {
    listen(themeBtn, "click", function () {
      themeMode = MODES[(MODES.indexOf(themeMode) + 1) % MODES.length];
      transitionMode(themeMode);
    });
  }

  var localeSwitch = document.querySelector(".lang-switch");
  if (localeSwitch) {
    listen(localeSwitch, "click", function () {
      var locale = localeSwitch.getAttribute("hreflang");
      if (locale !== "en" && locale !== "es") return;
      try { localStorage.setItem("eccos-locale", locale); } catch (e) {}
    });
  }

  if (LIGHT_MQ) {
    var onScheme = function () { if (themeMode === "auto") transitionMode("auto"); };
    if (LIGHT_MQ.addEventListener) listen(LIGHT_MQ, "change", onScheme);
    else if (LIGHT_MQ.addListener) {
      LIGHT_MQ.addListener(onScheme);
      disposers.push(function () { LIGHT_MQ.removeListener(onScheme); });
    }
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
    observers.push(io);

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

  if (!reduced && hasIO && nums.length && !countUpHasRun) {
    countUpHasRun = true;
    var nio = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        nio.unobserve(entry.target);
        countUp(entry.target);
      });
    }, { threshold: 0.6 });
    observers.push(nio);
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

    listen(toggle, "click", function () { setOpen(!open); });

    listen(nav, "click", function (e) {
      if (e.target.tagName === "A") setOpen(false);
    });

    listen(document, "keydown", function (e) {
      if (!open) return;
      if (e.key === "Escape" || e.key === "Esc") {
        setOpen(false);
        toggle.focus();
      }
    });

    listen(document, "click", function (e) {
      if (!open) return;
      if (nav.contains(e.target) || toggle.contains(e.target)) return;
      setOpen(false);
    });

    listen(window, "resize", function () {
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
    observers.push(dio);

    diagrams.forEach(function (el) { dio.observe(el); });
    listen(document, "visibilitychange", applyPlayState);
  }

  cleanup = function () {
    disposers.forEach(function (dispose) { dispose(); });
    observers.forEach(function (observer) { observer.disconnect(); });
  };
  }

  document.addEventListener("astro:before-swap", function () {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    if (activeThemeTransition) {
      try { activeThemeTransition.skipTransition(); } catch (e) {}
      activeThemeTransition = null;
    }
    document.documentElement.removeAttribute("data-eccos-theme-transition");
  });
  document.addEventListener("astro:page-load", init);

  /* ---------- 6. Umami event tracking ----------

     One delegated capture-phase click listener names every meaningful link
     click ("area-click") and sends href, label text and owning section id as
     event properties. Registered once per window (it must survive the
     astro:before-swap / astro:page-load cycle, unlike everything above) and
     silently inert when the tracker never loaded. */

  function trackEvent(name, props) {
    if (!window.umami || typeof window.umami.track !== "function") return;
    try { window.umami.track(name, props); } catch (e) {}
  }

  function eventArea(link) {
    var href = link.getAttribute("href") || "";
    if (/^mailto:/i.test(href)) return "email";
    if (/github\.com\/santigamo\/eccos/i.test(href)) return "github";
    if (/^https?:\/\//i.test(href) && !/^https?:\/\/(www\.)?eccos\.chat/i.test(href)) return "outbound";
    if (link.classList.contains("lang-switch")) return "lang";
    return "nav";
  }

  function sectionOf(el) {
    var sec = el.closest("section[id], footer[id], [id]");
    return sec ? sec.id : "";
  }

  if (!window.__eccosTracked) {
    window.__eccosTracked = true;
    document.addEventListener("click", function (e) {
      var target = e.target;
      if (!target || !target.closest) return;
      var link = target.closest("a[href]");
      if (!link) return;
      trackEvent(eventArea(link) + "-click", {
        href: link.getAttribute("href"),
        text: (link.textContent || "").trim().slice(0, 60),
        section: sectionOf(link)
      });
    }, true);
  }
})();
