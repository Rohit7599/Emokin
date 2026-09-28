/* ==========================================================================
   Sentio — front end for the BiGRU emotion API
   Talks to:  GET /health   -> { status, model_loaded }
              POST /predict -> { text, predicted_emotion, confidence, all_probabilites }
   ========================================================================== */
(() => {
  "use strict";

  // Same origin by default (FastAPI serves this page). Set to your API URL if
  // you ever host the UI separately, e.g. "https://your-app.onrender.com".
  const API_BASE = "";

  const REQUEST_TIMEOUT_MS = 70_000; // Render's free tier can take ~a minute to wake
  const LIVE_DEBOUNCE_MS = 650;
  const HISTORY_KEY = "sentio.history.v1";
  const LIVE_KEY = "sentio.live.v1";
  const HISTORY_MAX = 8;
  const MAX_CHARS = 2000;

  const EMOTIONS = {
    sadness:  { color: "#6e9bff", emoji: "😢" },
    joy:      { color: "#ffc857", emoji: "😄" },
    love:     { color: "#ff7eb0", emoji: "❤️" },
    anger:    { color: "#ff6a4d", emoji: "😠" },
    fear:     { color: "#a68bff", emoji: "😨" },
    surprise: { color: "#3ee0c0", emoji: "😲" },
  };
  const ORDER = Object.keys(EMOTIONS);

  const EXAMPLES = [
    "I finally got the internship and I can't stop smiling",
    "Everyone moved to other cities and the house feels so empty now",
    "How dare they cancel the meeting without telling anyone",
    "My hands keep shaking the night before the interview",
    "I never expected the whole class to throw me a surprise party",
    "You make even the most ordinary days feel special",
    "I walked into the room and could not believe what I was seeing",
    "I keep checking the locks because something feels wrong tonight",
  ];

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------------------------------------------------------------- elements
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const body = document.body;
  const input = $("input");
  const field = $("field");
  const mirror = $("mirror");
  const countEl = $("count");
  const counter = $("counter");
  const analyzeBtn = $("analyzeBtn");
  const analyzeLabel = analyzeBtn.querySelector(".btn__label");
  const exampleBtn = $("exampleBtn");
  const liveToggle = $("liveToggle");
  const notice = $("notice");
  const statusEl = $("status");
  const statusText = $("statusText");
  const resultEl = $("result");
  const emptyState = $("emptyState");
  const resultBody = $("resultBody");
  const verdictLead = $("verdictLead");
  const verdictWord = $("verdictWord");
  const verdictEmoji = $("verdictEmoji");
  const verdictSub = $("verdictSub");
  const gaugeFill = $("gaugeFill");
  const gaugeNum = $("gaugeNum");
  const spectrum = $("spectrum");
  const bars = $("bars");
  const historySection = $("history");
  const historyList = $("historyList");
  const clearHistoryBtn = $("clearHistory");
  const announcer = $("announcer");

  // ------------------------------------------------------------------- state
  let inflight = null;          // AbortController of the current /predict call
  let liveTimer = null;
  let typingJob = null;         // cancel token for the example typewriter
  let exampleIndex = Math.floor(Math.random() * EXAMPLES.length);
  let lastTopEmotion = null;
  let history = [];             // filled from localStorage at boot
  const spectrumSegs = {};      // emotion -> <span>
  const barRows = {};           // emotion -> { li, fill, pct }

  // ------------------------------------------------------------ small utils
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
    },
  };

  const pct = (p, digits = 1) => `${(p * 100).toFixed(digits)}%`;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const colorOf = (emotion) => (EMOTIONS[emotion] ? EMOTIONS[emotion].color : "#e4e0ff");

  function sortedProbs(probs) {
    return Object.entries(probs)
      .map(([emotion, p]) => ({ emotion, p: Number(p) || 0 }))
      .sort((a, b) => b.p - a.p);
  }

  function announce(message) {
    announcer.textContent = "";
    requestAnimationFrame(() => { announcer.textContent = message; });
  }

  // ------------------------------------------------------------ server status
  function setStatus(state, text) {
    statusEl.dataset.state = state;
    statusText.textContent = text;
  }

  let healthRetry = null;
  async function checkHealth(attempt = 0) {
    clearTimeout(healthRetry);
    if (attempt === 0) setStatus("checking", "Connecting");
    try {
      const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.model_loaded) {
        setStatus("ready", "Model ready");
      } else {
        setStatus("loading", "Model loading");
        healthRetry = setTimeout(() => checkHealth(attempt + 1), 3000);
      }
    } catch {
      setStatus("offline", attempt < 2 ? "Waking server" : "Server unreachable");
      if (attempt < 12) healthRetry = setTimeout(() => checkHealth(attempt + 1), 5000);
    }
  }

  // ------------------------------------------------------------ input field
  function autoresize() {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }

  function updateCounter() {
    const n = input.value.length;
    countEl.textContent = n.toLocaleString();
    counter.classList.toggle("is-near", n >= MAX_CHARS * 0.9 && n < MAX_CHARS);
    counter.classList.toggle("is-full", n >= MAX_CHARS);
    analyzeBtn.disabled = input.value.trim().length === 0;
  }

  function unpaint() {
    field.classList.remove("is-painted");
  }

  // Paint the user's own words with the distribution: each emotion's colour
  // sits at the middle of its share, dominant emotion on the left.
  function paint(text, ranked) {
    const kept = ranked.filter((r) => r.p >= 0.03);
    const total = kept.reduce((s, r) => s + r.p, 0) || 1;
    let gradient;
    if (kept.length <= 1) {
      const c = colorOf((kept[0] || ranked[0]).emotion);
      gradient = `linear-gradient(90deg, ${c}, ${c})`;
    } else {
      let acc = 0;
      const stops = kept.map((r) => {
        const share = r.p / total;
        const mid = (acc + share / 2) * 100;
        acc += share;
        return `${colorOf(r.emotion)} ${mid.toFixed(1)}%`;
      });
      gradient = `linear-gradient(90deg, ${stops.join(", ")})`;
    }

    // A trailing newline collapses in the mirror; pad it so line boxes match.
    mirror.textContent = text.endsWith("\n") ? `${text}​` : text;
    field.style.setProperty("--paint", gradient);

    field.classList.remove("is-painted");
    void mirror.offsetWidth; // restart the sweep
    field.classList.add("is-painted");
  }

  // ------------------------------------------------------------ result view
  function buildResultSkeleton() {
    ORDER.forEach((emotion) => {
      const seg = document.createElement("span");
      seg.style.setProperty("--c", colorOf(emotion));
      seg.dataset.emotion = emotion;
      spectrum.appendChild(seg);
      spectrumSegs[emotion] = seg;

      const li = document.createElement("li");
      li.className = "bar";
      li.dataset.emotion = emotion;
      li.style.setProperty("--c", colorOf(emotion));
      li.innerHTML = `
        <span class="bar__name">${emotion}</span>
        <span class="bar__track"><span class="bar__fill"></span></span>
        <span class="bar__pct">0.0%</span>`;
      bars.appendChild(li);
      barRows[emotion] = {
        li,
        fill: li.querySelector(".bar__fill"),
        pct: li.querySelector(".bar__pct"),
      };
    });

    // Linked hover between the spectrum and the ranked list
    const hot = (emotion) => {
      spectrum.classList.toggle("is-hovering", !!emotion);
      bars.classList.toggle("is-hovering", !!emotion);
      ORDER.forEach((e) => {
        spectrumSegs[e].classList.toggle("is-hot", e === emotion);
        barRows[e].li.classList.toggle("is-hot", e === emotion);
      });
    };
    ORDER.forEach((e) => {
      spectrumSegs[e].addEventListener("pointerenter", () => hot(e));
      barRows[e].li.addEventListener("pointerenter", () => hot(e));
    });
    spectrum.addEventListener("pointerleave", () => hot(null));
    bars.addEventListener("pointerleave", () => hot(null));
  }

  function countUp(el, to, duration = 1000) {
    const fmt = (v) => v.toFixed(1);
    if (prefersReducedMotion) { el.textContent = fmt(to); return; }
    const from = Number(el.textContent) || 0;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = fmt(from + (to - from) * eased);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function setWord(word) {
    verdictWord.textContent = "";
    [...word].forEach((ch, i) => {
      const span = document.createElement("span");
      span.className = "ch";
      span.style.setProperty("--i", i);
      span.textContent = ch;
      verdictWord.appendChild(span);
    });
  }

  function reorderBars(ranked) {
    // FLIP: remember where rows were, reorder, then animate from old spots
    const before = new Map(ORDER.map((e) => [e, barRows[e].li.getBoundingClientRect().top]));
    ranked.forEach(({ emotion }) => {
      if (barRows[emotion]) bars.appendChild(barRows[emotion].li);
    });
    if (prefersReducedMotion) return;
    ranked.forEach(({ emotion }) => {
      const row = barRows[emotion];
      if (!row) return;
      const dy = before.get(emotion) - row.li.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) {
        row.li.animate(
          [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
          { duration: 550, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" }
        );
      }
    });
  }

  function setAura(ranked) {
    const [a, b, c] = ranked;
    root.style.setProperty("--aura-a", colorOf(a.emotion));
    root.style.setProperty("--aura-b", colorOf((b || a).emotion));
    root.style.setProperty("--aura-c", colorOf((c || b || a).emotion));
    // Blob size follows probability, with a floor so the field never vanishes
    root.style.setProperty("--aura-a-s", (0.75 + a.p * 0.55).toFixed(3));
    root.style.setProperty("--aura-b-s", (0.45 + (b ? b.p : 0) * 1.2).toFixed(3));
    root.style.setProperty("--aura-c-s", (0.35 + (c ? c.p : 0) * 1.2).toFixed(3));
  }

  function describe(top, conf, second) {
    const secondName = second ? second.emotion : null;
    const secondPct = second ? pct(second.p) : "";
    if (conf >= 0.75 || !second) {
      return {
        lead: "Reads as",
        sub: secondName && second.p >= 0.05
          ? `A clear reading. <strong>${cap(secondName)}</strong> is a distant second at ${secondPct}.`
          : "A clear reading, with little else in the mix.",
        level: "high",
      };
    }
    if (conf >= 0.5) {
      return {
        lead: "Mostly",
        sub: second.p >= 0.25
          ? `<strong>${cap(secondName)}</strong> also scores ${secondPct}, so the sentence carries a bit of both.`
          : `With a trace of <strong>${secondName}</strong> at ${secondPct}.`,
        level: "mid",
      };
    }
    return {
      lead: "Leaning toward",
      sub: `<strong>${cap(secondName)}</strong> is close behind at ${secondPct}, so treat this reading loosely.`,
      level: "low",
    };
  }

  function renderResult(data, { paintText = true } = {}) {
    const ranked = sortedProbs(data.all_probabilites || {});
    if (!ranked.length) return;

    const top = data.predicted_emotion || ranked[0].emotion;
    const conf = Number(data.confidence ?? ranked[0].p);
    const second = ranked.find((r) => r.emotion !== top);
    const copy = describe(top, conf, second);

    // Switch from empty to filled
    if (resultBody.hidden) {
      emptyState.hidden = true;
      resultBody.hidden = false;
    }
    resultEl.dataset.state = "filled";
    resultEl.dataset.confidence = copy.level;

    // Accent colour flows through the button, ring, caret and headline
    root.style.setProperty("--accent", colorOf(top));
    setAura(ranked);

    // Headline: only re-animate the letters when the emotion changes
    verdictLead.textContent = copy.lead;
    if (top !== lastTopEmotion || !verdictWord.textContent) {
      setWord(top);
      verdictEmoji.textContent = EMOTIONS[top] ? EMOTIONS[top].emoji : "";
      verdictEmoji.classList.remove("pop");
      void verdictEmoji.offsetWidth;
      verdictEmoji.classList.add("pop");
    }
    lastTopEmotion = top;
    verdictSub.innerHTML = copy.sub;

    // Confidence ring
    const circumference = 326.73;
    gaugeFill.style.strokeDashoffset = (circumference * (1 - Math.max(0, Math.min(1, conf)))).toFixed(2);
    countUp(gaugeNum, conf * 100);

    // Spectrum (sorted, dominant on the left) and ranked bars
    ranked.forEach((r, i) => {
      const seg = spectrumSegs[r.emotion];
      if (seg) {
        seg.style.order = i;
        seg.style.setProperty("--w", `${(r.p * 100).toFixed(2)}%`);
        seg.title = `${cap(r.emotion)} ${pct(r.p)}`;
      }
      const row = barRows[r.emotion];
      if (row) {
        row.fill.style.setProperty("--d", `${i * 70}ms`);
        row.fill.style.setProperty("--w", `${(r.p * 100).toFixed(2)}%`);
        row.pct.textContent = pct(r.p);
      }
    });
    reorderBars(ranked);

    if (paintText) paint(data.text ?? input.value, ranked);

    announce(`${copy.lead} ${top}, ${pct(conf, 0)} confidence.`);
  }

  // ------------------------------------------------------------ notices
  function showNotice(message, tone = "error") {
    notice.textContent = message;
    notice.dataset.tone = tone;
    notice.hidden = false;
  }
  function hideNotice() { notice.hidden = true; }

  // ------------------------------------------------------------ predict
  function setBusy(isBusy) {
    body.classList.toggle("is-busy", isBusy);
    analyzeBtn.classList.toggle("is-loading", isBusy);
    analyzeLabel.textContent = isBusy ? "Analyzing" : "Analyze";
  }

  async function analyze(source = "manual") {
    const text = input.value;
    if (!text.trim()) return;

    clearTimeout(liveTimer);
    if (inflight) inflight.abort();
    const controller = new AbortController();
    inflight = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);

    hideNotice();
    setBusy(true);

    // If the first reply is slow, say why rather than leaving a silent spinner
    const slowTimer = setTimeout(() => {
      showNotice("Still working. If the server was idle it can take up to a minute to wake up.", "info");
    }, 4000);

    try {
      const res = await fetch(`${API_BASE}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });

      if (!res.ok) {
        let detail = "";
        try { detail = (await res.json()).detail; } catch { /* not JSON */ }
        if (res.status === 503) {
          setStatus("loading", "Model loading");
          checkHealth(1);
          throw new Error(typeof detail === "string" ? detail : "The model is still loading. Try again in a few seconds.");
        }
        if (res.status === 422) throw new Error(`Enter between 1 and ${MAX_CHARS.toLocaleString()} characters.`);
        throw new Error(`The server returned an error (${res.status}). Try again.`);
      }

      const data = await res.json();
      if (controller !== inflight) return; // a newer request superseded this one

      hideNotice();
      setStatus("ready", "Model ready");
      // Only paint the words if the field still holds what was analyzed
      renderResult({ ...data, text }, { paintText: input.value === text });
      if (source !== "live") addToHistory(text, data);
    } catch (err) {
      if (controller !== inflight) return;
      if (err.name === "AbortError" && !timedOut) {
        if (notice.dataset.tone === "info") hideNotice();
        return;
      }
      if (timedOut || err instanceof TypeError) {
        setStatus("offline", "Server unreachable");
        showNotice("Couldn't reach the server. If it was idle, Render may still be waking it up, which can take up to a minute. Try again shortly.");
        checkHealth(1);
      } else {
        showNotice(err.message);
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(slowTimer);
      if (controller === inflight) {
        inflight = null;
        setBusy(false);
      }
    }
  }

  // ------------------------------------------------------------ history
  function loadHistory() {
    const h = store.get(HISTORY_KEY, []);
    return Array.isArray(h) ? h.filter((x) => x && typeof x.text === "string" && x.all_probabilites) : [];
  }

  function addToHistory(text, data) {
    const entry = {
      text,
      predicted_emotion: data.predicted_emotion,
      confidence: data.confidence,
      all_probabilites: data.all_probabilites,
    };
    history = [entry, ...history.filter((h) => h.text !== text)].slice(0, HISTORY_MAX);
    store.set(HISTORY_KEY, history);
    renderHistory(true);
  }

  function renderHistory(markNewest = false) {
    historySection.hidden = history.length === 0;
    historyList.textContent = "";
    history.forEach((h, i) => {
      const li = document.createElement("li");
      li.className = "history__item" + (markNewest && i === 0 ? " is-new" : "");
      li.style.setProperty("--c", colorOf(h.predicted_emotion));

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "history__btn";
      btn.title = "Show this reading again";

      const dot = document.createElement("span");
      dot.className = "history__dot";

      const t = document.createElement("span");
      t.className = "history__text";
      t.textContent = h.text;

      const meta = document.createElement("span");
      meta.className = "history__meta";
      const b = document.createElement("b");
      b.textContent = h.predicted_emotion;
      meta.append(b, ` ${pct(h.confidence, 0)}`);

      btn.append(dot, t, meta);
      btn.addEventListener("click", () => restore(h));
      li.appendChild(btn);
      historyList.appendChild(li);
    });
  }

  function restore(entry) {
    cancelTyping();
    if (inflight) inflight.abort();
    input.value = entry.text;
    autoresize();
    updateCounter();
    hideNotice();
    renderResult(entry);
    input.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" });
  }

  // ------------------------------------------------------------ examples
  function cancelTyping() {
    if (typingJob) typingJob.cancelled = true;
    typingJob = null;
    exampleBtn.disabled = false;
  }

  async function typeExample() {
    cancelTyping();
    const job = { cancelled: false };
    typingJob = job;
    exampleBtn.disabled = true;

    const sentence = EXAMPLES[exampleIndex % EXAMPLES.length];
    exampleIndex += 1;

    if (inflight) inflight.abort();
    unpaint();
    hideNotice();
    input.value = "";
    autoresize();
    updateCounter();
    input.focus({ preventScroll: true });

    if (prefersReducedMotion) {
      input.value = sentence;
    } else {
      for (let i = 1; i <= sentence.length; i++) {
        if (job.cancelled) return;
        input.value = sentence.slice(0, i);
        autoresize();
        updateCounter();
        // Slightly irregular rhythm reads as typing rather than a ticker
        const ch = sentence[i - 1];
        const delay = ch === " " ? 55 : ch === "," ? 140 : 22 + Math.random() * 26;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    if (job.cancelled) return;
    autoresize();
    updateCounter();
    typingJob = null;
    exampleBtn.disabled = false;
    analyze("example");
  }

  // ------------------------------------------------------------ events
  input.addEventListener("input", () => {
    if (typingJob) cancelTyping();
    autoresize();
    updateCounter();
    unpaint();
    if (!notice.hidden && notice.dataset.tone !== "info") hideNotice();

    if (liveToggle.checked) {
      clearTimeout(liveTimer);
      if (input.value.trim().length >= 3) {
        liveTimer = setTimeout(() => analyze("live"), LIVE_DEBOUNCE_MS);
      }
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!analyzeBtn.disabled) analyze("manual");
    }
  });

  analyzeBtn.addEventListener("click", () => analyze("manual"));
  exampleBtn.addEventListener("click", typeExample);

  liveToggle.checked = !!store.get(LIVE_KEY, false);
  liveToggle.addEventListener("change", () => {
    store.set(LIVE_KEY, liveToggle.checked);
    if (liveToggle.checked && input.value.trim().length >= 3 && !field.classList.contains("is-painted")) {
      analyze("live");
    }
  });

  clearHistoryBtn.addEventListener("click", () => {
    history = [];
    store.set(HISTORY_KEY, history);
    renderHistory();
  });

  // Keep the painted mirror aligned if the layout width changes
  window.addEventListener("resize", autoresize);

  // ------------------------------------------------------------ boot
  buildResultSkeleton();
  history = loadHistory();
  renderHistory();
  updateCounter();
  autoresize();
  checkHealth();
  // Fonts change line wrapping; resize once they arrive
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(autoresize);
})();
