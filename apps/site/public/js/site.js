/* ============================================================================
   Eccos — landing behaviour: entrance reveals, stat count-up, the mobile menu
   and the diagram play-state. Vanilla, no dependencies, no external requests.
   Everything degrades to "already visible / already final" without JS and
   under prefers-reduced-motion.
   ========================================================================== */

(function () {
  "use strict";

  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var hasIO = "IntersectionObserver" in window;

  /* ---------- 1. entrance reveals ---------- */

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

  /* ---------- 2. stat count-up ---------- */

  var nums = [].slice.call(document.querySelectorAll(".num[data-count]"));

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
      el.textContent = String(Math.round(start + (target - start) * eased));
      if (k < 1) window.requestAnimationFrame(step);
      else el.textContent = String(target);
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

  /* ---------- 3. mobile menu ---------- */

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

  /* ---------- 4. diagrams only animate while on screen ---------- */

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
