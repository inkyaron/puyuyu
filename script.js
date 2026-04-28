const fallbackLines = [
  { text: "うーん…", kana: "うーん…" },
  { text: "でもなぁ", kana: "でもなぁ" },
  { text: "はぁ…", kana: "はぁ…" },
  { text: "まだ迷う…", kana: "まだまよう…" },
  { text: "保留で…", kana: "ほりゅうで…" },
];

const bubble = document.getElementById("speechBubble");
const speechText = document.getElementById("speechText");
const puyuyu = document.getElementById("puyuyu");
const soundToggle = document.getElementById("soundToggle");
const lightToggle = document.getElementById("lightToggle");
const visitor = document.getElementById("visitor");

let currentLine = "";
let speaking = false;
let cycleTimeoutId = 0;
let bubbleTimeoutId = 0;
let motionTimeoutId = 0;
let visitorTimeoutId = 0;
let visitorPhaseTimeoutIds = [];
let scareTimeoutIds = [];
let availableVoices = [];
let lines = [];
let soundEnabled = false;
let lightsOn = true;
let visitorActive = false;
let audioContext = null;
let lightToggleLocked = false;
let scareEventTriggered = false;
let scareAudio = null;
let hasScareOccurred = false;
let darkLineToggle = false;

const motionModes = ["motion-squish", "motion-roll", "motion-shiver", "motion-bounce"];
let currentMotionMode = motionModes[0];
let pendingMotionMode = null;
const scareCookieName = "puyuyu_scare_event_done";

function supportsEmojiGlyph(emoji) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return true;
    }

    const render = (value) => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.textBaseline = "top";
      context.font = '48px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
      context.fillText(value, 4, 4);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };

    const target = render(emoji);
    const unsupported = render("\u{10FFFF}");
    let differentPixels = 0;

    for (let index = 0; index < target.length; index += 4) {
      if (
        target[index] !== unsupported[index] ||
        target[index + 1] !== unsupported[index + 1] ||
        target[index + 2] !== unsupported[index + 2] ||
        target[index + 3] !== unsupported[index + 3]
      ) {
        differentPixels += 1;
        if (differentPixels > 24) {
          return true;
        }
      }
    }

    return false;
  } catch (error) {
    console.warn("Could not detect emoji glyph support.", error);
    return true;
  }
}

function setLines(nextLines) {
  lines = nextLines;
  window.lines = nextLines.map((line) => ({ ...line }));
}

function normalizeLine(line) {
  if (typeof line === "string" && line.trim()) {
    return { text: line, kana: line };
  }

  if (
    line &&
    typeof line === "object" &&
    typeof line.text === "string" &&
    line.text.trim() &&
    typeof line.kana === "string" &&
    line.kana.trim()
  ) {
    return {
      text: line.text,
      kana: line.kana,
    };
  }

  return null;
}

async function loadLines() {
  try {
    const cacheBuster = Date.now().toString();
    const response = await fetch(`./lines.json?v=${cacheBuster}`, {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-store, no-cache, max-age=0",
        Pragma: "no-cache",
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to load lines: ${response.status}`);
    }

    const payload = await response.json();
    if (Array.isArray(payload) && payload.length > 0) {
      const normalizedLines = payload.map(normalizeLine).filter(Boolean);
      if (normalizedLines.length > 0) {
        setLines(normalizedLines);
        return;
      }
    }

    throw new Error("lines.json did not contain any valid lines.");
  } catch (error) {
    console.warn("Could not load lines.json, using fallback lines.", error);
    setLines([...fallbackLines]);
  }
}

const voiceSettings = {
  voiceURI: "",
  pitch: 1.6,
  rate: 1.0,
  volume: 0.9,
};

function randomLine() {
  const candidates = lines.filter(
    (line) => !currentLine || line.text !== currentLine.text || line.kana !== currentLine.kana
  );
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function pickVoice() {
  if (voiceSettings.voiceURI) {
    return availableVoices.find((voice) => voice.voiceURI === voiceSettings.voiceURI) ?? null;
  }

  return availableVoices[0] ?? null;
}

function formatVoiceLabel(voice) {
  const locale = voice.lang || "unknown";
  return `${voice.name} (${locale})`;
}

function getSortedVoices() {
  const voices = window.speechSynthesis?.getVoices?.() ?? [];
  const prioritized = voices.slice().sort((left, right) => {
    const leftJa = Number(!left.lang.startsWith("ja"));
    const rightJa = Number(!right.lang.startsWith("ja"));
    return leftJa - rightJa || left.name.localeCompare(right.name, "ja");
  });

  return prioritized;
}

function renderVoiceOptions() {
  availableVoices = getSortedVoices();

  if (!availableVoices.length) {
    voiceSettings.voiceURI = "";
    return;
  }

  const defaultVoice =
    availableVoices.find((voice) => voice.lang.startsWith("ja") && /female|haruka|kyoko/i.test(voice.name)) ||
    availableVoices.find((voice) => voice.lang.startsWith("ja")) ||
    availableVoices[0];

  const selectedVoice =
    availableVoices.find((voice) => voice.voiceURI === voiceSettings.voiceURI) || defaultVoice;

  voiceSettings.voiceURI = selectedVoice.voiceURI;
}

function setCookie(name, value, maxAgeSeconds) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
}

function getCookie(name) {
  const prefix = `${name}=`;
  const match = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));

  return match ? decodeURIComponent(match.slice(prefix.length)) : "";
}

function getAudioContext() {
  if (!("AudioContext" in window || "webkitAudioContext" in window)) {
    return null;
  }

  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass();
  }

  if (audioContext.state === "suspended") {
    audioContext.resume().catch(() => {});
  }

  return audioContext;
}

function playLightSwitchSound(nextLightsOn) {
  if (!soundEnabled) {
    return;
  }

  const context = getAudioContext();
  if (!context) {
    return;
  }

  const startAt = context.currentTime + 0.01;
  const master = context.createGain();
  master.connect(context.destination);
  master.gain.setValueAtTime(nextLightsOn ? 0.16 : 0.3, startAt);
  master.gain.exponentialRampToValueAtTime(0.0001, startAt + (nextLightsOn ? 0.08 : 0.28));

  const tone = context.createOscillator();
  const toneGain = context.createGain();
  tone.type = nextLightsOn ? "square" : "triangle";
  tone.frequency.setValueAtTime(nextLightsOn ? 2300 : 120, startAt);
  tone.frequency.exponentialRampToValueAtTime(nextLightsOn ? 1450 : 58, startAt + (nextLightsOn ? 0.028 : 0.22));
  toneGain.gain.setValueAtTime(0.0001, startAt);
  toneGain.gain.exponentialRampToValueAtTime(nextLightsOn ? 0.08 : 0.18, startAt + 0.006);
  toneGain.gain.exponentialRampToValueAtTime(0.0001, startAt + (nextLightsOn ? 0.045 : 0.24));
  tone.connect(toneGain);

  const toneFilter = context.createBiquadFilter();
  toneFilter.type = nextLightsOn ? "highpass" : "lowpass";
  toneFilter.frequency.setValueAtTime(nextLightsOn ? 1900 : 520, startAt);
  toneGain.connect(toneFilter);
  toneFilter.connect(master);

  const clickFilter = context.createBiquadFilter();
  clickFilter.type = nextLightsOn ? "highpass" : "bandpass";
  clickFilter.frequency.setValueAtTime(nextLightsOn ? 3200 : 680, startAt);
  clickFilter.Q.setValueAtTime(nextLightsOn ? 1.3 : 0.7, startAt);

  const noiseBuffer = context.createBuffer(1, Math.floor(context.sampleRate * (nextLightsOn ? 0.022 : 0.12)), context.sampleRate);
  const noiseData = noiseBuffer.getChannelData(0);
  for (let index = 0; index < noiseData.length; index += 1) {
    noiseData[index] = (Math.random() * 2 - 1) * (nextLightsOn ? 0.42 : 0.75);
  }

  const noise = context.createBufferSource();
  noise.buffer = noiseBuffer;
  const noiseGain = context.createGain();
  noiseGain.gain.setValueAtTime(nextLightsOn ? 0.14 : 0.24, startAt);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, startAt + (nextLightsOn ? 0.03 : 0.14));
  noise.connect(clickFilter);
  clickFilter.connect(noiseGain);
  noiseGain.connect(master);

  tone.start(startAt);
  tone.stop(startAt + (nextLightsOn ? 0.05 : 0.28));
  noise.start(startAt);
  noise.stop(startAt + (nextLightsOn ? 0.03 : 0.12));
}

function playEventTrack() {
  if (!soundEnabled || !scareAudio) {
    return;
  }

  scareAudio.pause();
  scareAudio.currentTime = 0;
  scareAudio.play().catch(() => {});
}

function speak(line) {
  if (!("speechSynthesis" in window) || !soundEnabled || line.silent) {
    speaking = false;
    window.speechSynthesis?.cancel?.();
    return;
  }

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(line.kana);
  const voice = pickVoice();
  const normalizedKanaLength = line.kana.replace(/\s/g, "").length;
  const rate = normalizedKanaLength >= 12 ? 1.1 : voiceSettings.rate;

  utterance.lang = "ja-JP";
  utterance.pitch = voiceSettings.pitch;
  utterance.rate = rate;
  utterance.volume = voiceSettings.volume;
  if (voice) {
    utterance.voice = voice;
  }

  speaking = true;
  utterance.onend = () => {
    speaking = false;
  };
  utterance.onerror = () => {
    speaking = false;
  };

  window.speechSynthesis.speak(utterance);
}

function clearTimers() {
  window.clearTimeout(cycleTimeoutId);
  window.clearTimeout(bubbleTimeoutId);
  window.clearTimeout(motionTimeoutId);
  window.clearTimeout(visitorTimeoutId);
  for (const timeoutId of visitorPhaseTimeoutIds) {
    window.clearTimeout(timeoutId);
  }
  visitorPhaseTimeoutIds = [];
  for (const timeoutId of scareTimeoutIds) {
    window.clearTimeout(timeoutId);
  }
  scareTimeoutIds = [];
}

function scheduleNextLine(delay = 3000 + Math.random() * 3000) {
  if (scareEventTriggered || hasScareOccurred) {
    return;
  }
  window.clearTimeout(cycleTimeoutId);
  cycleTimeoutId = window.setTimeout(() => {
    triggerLine(randomLine());
  }, delay);
}

function showLine(line) {
  if (scareEventTriggered || hasScareOccurred) {
    return;
  }

  currentLine = line;
  bubble.classList.remove("is-visible");

  window.clearTimeout(bubbleTimeoutId);
  bubbleTimeoutId = window.setTimeout(() => {
    speechText.textContent = line.text;
    bubble.classList.add("is-visible");
  }, 120);

  speak(line);
}

function triggerLine(line, nextDelay) {
  const displayedLine = resolveDisplayedLine(line);
  showLine(displayedLine);
  scheduleNextLine(nextDelay);
}

function resolveDisplayedLine(line) {
  if (!lightsOn) {
    darkLineToggle = !darkLineToggle;
    if (darkLineToggle) {
      return { text: "…", kana: "", silent: true };
    }
  }

  return { ...line, silent: false };
}

function randomMotionMode() {
  const candidates = motionModes.filter((mode) => mode !== currentMotionMode);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function applyMotionMode(mode) {
  puyuyu.classList.remove(...motionModes);
  puyuyu.classList.add(mode);
  currentMotionMode = mode;
}

function scheduleNextMotion(delay = 10000 + Math.random() * 10000) {
  if (hasScareOccurred) {
    return;
  }
  window.clearTimeout(motionTimeoutId);
  motionTimeoutId = window.setTimeout(() => {
    pendingMotionMode = randomMotionMode();
  }, delay);
}

function syncSoundToggle() {
  soundToggle.classList.toggle("is-on", soundEnabled);
  soundToggle.classList.toggle("is-off", !soundEnabled);
  soundToggle.setAttribute("aria-pressed", String(soundEnabled));
  soundToggle.setAttribute("aria-label", soundEnabled ? "音声をオフにする" : "音声をオンにする");
  soundToggle.querySelector(".sound-toggle-icon").textContent = soundEnabled ? "🔊" : "🔇";
}

function syncLightToggle() {
  document.body.classList.toggle("lights-off", !lightsOn);
  lightToggle.classList.toggle("is-on", lightsOn);
  lightToggle.classList.toggle("is-off", !lightsOn);
  lightToggle.setAttribute("aria-pressed", String(lightsOn));
  lightToggle.setAttribute("aria-label", lightsOn ? "部屋の電気を消す" : "部屋の電気をつける");
  lightToggle.querySelector(".light-toggle-icon").textContent = "💡";
  lightToggle.setAttribute("aria-disabled", String(lightToggleLocked));
}

function clearVisitorState() {
  visitor.classList.remove("is-entering", "is-idle", "is-leaving");
}

function scheduleVisitorVisit(delay = 45000 + Math.random() * 30000) {
  window.clearTimeout(visitorTimeoutId);

  if (lightsOn || hasScareOccurred) {
    for (const timeoutId of visitorPhaseTimeoutIds) {
      window.clearTimeout(timeoutId);
    }
    visitorPhaseTimeoutIds = [];
    clearVisitorState();
    visitorActive = false;
    return;
  }

  visitorTimeoutId = window.setTimeout(() => {
    startVisitorVisit();
  }, delay);
}

function startVisitorVisit() {
  if (lightsOn || visitorActive || hasScareOccurred) {
    return;
  }

  visitorActive = true;
  clearVisitorState();
  void visitor.offsetWidth;
  visitor.classList.add("is-entering");

  const idleTimeoutId = window.setTimeout(() => {
    clearVisitorState();
    visitor.classList.add("is-idle");
  }, 2200);

  const leavingTimeoutId = window.setTimeout(() => {
    clearVisitorState();
    visitor.classList.add("is-leaving");
  }, 2200 + 3200);

  const resetTimeoutId = window.setTimeout(() => {
    clearVisitorState();
    visitorActive = false;
    visitorPhaseTimeoutIds = [];
    scheduleVisitorVisit();
  }, 2200 + 3200 + 1800);

  visitorPhaseTimeoutIds = [idleTimeoutId, leavingTimeoutId, resetTimeoutId];
}

function clearVisitorTimers() {
  window.clearTimeout(visitorTimeoutId);
  for (const timeoutId of visitorPhaseTimeoutIds) {
    window.clearTimeout(timeoutId);
  }
  visitorPhaseTimeoutIds = [];
}

function finalizeScareEvent() {
  scareTimeoutIds = [];
  clearVisitorTimers();
  clearVisitorState();
  visitorActive = false;
  pendingMotionMode = null;
  window.clearTimeout(motionTimeoutId);
  document.body.classList.remove("scare-freeze");
  document.body.classList.remove("scare-active");
  document.body.classList.remove("scare-blackout");
  document.body.classList.add("scare-finished");
  hasScareOccurred = true;
  setCookie(scareCookieName, "1", 60 * 60 * 24 * 365);
  lightsOn = true;
  lightToggleLocked = false;
  syncLightToggle();
  window.speechSynthesis?.cancel?.();
  speaking = false;
  scareAudio?.pause();
  visitor.style.animation = "";
  visitor.style.position = "";
  visitor.style.left = "";
  visitor.style.top = "";
  visitor.style.width = "";
  visitor.style.height = "";
  visitor.style.transform = "";
  visitor.style.opacity = "";
}

function startScareChase() {
  document.body.classList.remove("scare-freeze");
  document.body.classList.add("scare-active");
  playEventTrack();
  const visitorRect = visitor.getBoundingClientRect();
  const puyuyuRect = puyuyu.getBoundingClientRect();
  const fleeX = Math.max(14, puyuyuRect.left - Math.min(window.innerWidth * 0.28, 168));
  const fleeY = Math.min(window.innerHeight - puyuyuRect.height * 0.22, puyuyuRect.top + Math.min(window.innerHeight * 0.28, 170));
  const puyuyuDeltaX = fleeX - puyuyuRect.left;
  const puyuyuDeltaY = fleeY - puyuyuRect.top;
  const chaseTargetX = fleeX + puyuyuRect.width * 0.6;
  const chaseTargetY = fleeY - puyuyuRect.height * 0.24;
  const deltaX = chaseTargetX - visitorRect.left;
  const deltaY = chaseTargetY - visitorRect.top;
  const scaleLimit = Math.max((puyuyuRect.width * 0.76) / Math.max(visitorRect.width, 1), 1.02);
  const clampScale = (value) => Math.min(value, scaleLimit);
  const targetScale = clampScale(Math.max((puyuyuRect.width * 0.72) / Math.max(visitorRect.width, 1), 1.02));

  clearVisitorTimers();
  clearVisitorState();
  visitorActive = true;
  visitor.style.position = "fixed";
  visitor.style.left = `${visitorRect.left}px`;
  visitor.style.top = `${visitorRect.top}px`;
  visitor.style.width = `${visitorRect.width}px`;
  visitor.style.height = `${visitorRect.height}px`;
  visitor.style.opacity = "1";
  visitor.style.transform = "translate(0, 0) scale(1)";

  puyuyu.animate(
    [
      { transform: "translate(0, 0) rotate(0deg) scale(1)", offset: 0 },
      { transform: `translate(${puyuyuDeltaX * 0.12}px, ${puyuyuDeltaY * 0.08 - 38}px) rotate(-5deg) scale(0.992)`, offset: 0.12 },
      { transform: `translate(${puyuyuDeltaX * 0.24}px, ${puyuyuDeltaY * 0.18}px) rotate(-7deg) scale(0.988)`, offset: 0.24 },
      { transform: `translate(${puyuyuDeltaX * 0.4}px, ${puyuyuDeltaY * 0.3 - 30}px) rotate(-8deg) scale(0.984)`, offset: 0.4 },
      { transform: `translate(${puyuyuDeltaX * 0.56}px, ${puyuyuDeltaY * 0.46}px) rotate(-10deg) scale(0.98)`, offset: 0.56 },
      { transform: `translate(${puyuyuDeltaX * 0.72}px, ${puyuyuDeltaY * 0.64 - 22}px) rotate(-11deg) scale(0.976)`, offset: 0.74 },
      { transform: `translate(${puyuyuDeltaX * 0.86}px, ${puyuyuDeltaY * 0.82}px) rotate(-12deg) scale(0.973)`, offset: 0.9 },
      { transform: `translate(${puyuyuDeltaX}px, ${puyuyuDeltaY - 12}px) rotate(-13deg) scale(0.97)`, offset: 1 }
    ],
    {
      duration: 2000,
      fill: "forwards",
      easing: "linear"
    }
  );

  const animation = visitor.animate(
    [
      { transform: "translate(0, 0) scale(1)", offset: 0 },
      { transform: `translate(${deltaX * 0.08}px, ${deltaY * 0.06 - 138}px) scale(${clampScale(1.08)})`, offset: 0.08, easing: "cubic-bezier(0.14, 1, 0.24, 1)" },
      { transform: `translate(${deltaX * 0.18}px, ${deltaY * 0.14}px) scale(${clampScale(1.14)})`, offset: 0.16, easing: "cubic-bezier(0.22, 1.28, 0.3, 1)" },
      { transform: `translate(${deltaX * 0.3}px, ${deltaY * 0.22 - 124}px) scale(${clampScale(1.2)})`, offset: 0.28, easing: "cubic-bezier(0.14, 1, 0.24, 1)" },
      { transform: `translate(${deltaX * 0.42}px, ${deltaY * 0.34}px) scale(${clampScale(1.26)})`, offset: 0.4, easing: "cubic-bezier(0.22, 1.28, 0.3, 1)" },
      { transform: `translate(${deltaX * 0.56}px, ${deltaY * 0.44 - 104}px) scale(${clampScale(1.34)})`, offset: 0.54, easing: "cubic-bezier(0.14, 1, 0.24, 1)" },
      { transform: `translate(${deltaX * 0.7}px, ${deltaY * 0.58}px) scale(${clampScale(1.42)})`, offset: 0.68, easing: "cubic-bezier(0.22, 1.28, 0.3, 1)" },
      { transform: `translate(${deltaX * 0.84}px, ${deltaY * 0.74 - 78}px) scale(${clampScale(1.5)})`, offset: 0.82, easing: "cubic-bezier(0.14, 1, 0.24, 1)" },
      { transform: `translate(${deltaX * 0.94}px, ${deltaY * 0.88}px) scale(${clampScale(1.58)})`, offset: 0.92, easing: "cubic-bezier(0.22, 1.28, 0.3, 1)" },
      { transform: `translate(${deltaX}px, ${deltaY}px) scale(${targetScale})`, offset: 1 }
    ],
    {
      duration: 1760,
      fill: "forwards",
      easing: "linear"
    }
  );

  animation.finished
    .catch(() => {})
    .finally(() => {
      document.body.classList.remove("scare-active");
      document.body.classList.add("scare-blackout");
      const finishTimeoutId = window.setTimeout(() => {
        finalizeScareEvent();
      }, 4000);
      scareTimeoutIds = [finishTimeoutId];
    });
}

function beginVisitorScareEvent() {
  if (scareEventTriggered) {
    return;
  }

  const visitorRect = visitor.getBoundingClientRect();

  scareEventTriggered = true;
  clearVisitorTimers();
  clearVisitorState();
  visitorActive = true;
  document.body.classList.add("scare-freeze");
  visitor.style.position = "fixed";
  visitor.style.left = `${visitorRect.left}px`;
  visitor.style.top = `${visitorRect.top}px`;
  visitor.style.width = `${visitorRect.width}px`;
  visitor.style.height = `${visitorRect.height}px`;
  visitor.style.opacity = "1";
  visitor.style.transform = "translate(0, 0) rotate(-2deg)";

  lightsOn = true;
  playLightSwitchSound(true);
  syncLightToggle();
  lightToggleLocked = true;
  syncLightToggle();
  window.clearTimeout(cycleTimeoutId);
  window.speechSynthesis?.cancel?.();
  speaking = false;

  const hideBubbleTimeoutId = window.setTimeout(() => {
    bubble.classList.remove("is-visible");
  }, 1400);

  const chaseTimeoutId = window.setTimeout(() => {
    startScareChase();
  }, 2000);

  scareTimeoutIds = [hideBubbleTimeoutId, chaseTimeoutId];
}

function isVisitorMostlyVisible() {
  const rect = visitor.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
  const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
  const visibleArea = visibleWidth * visibleHeight;
  const fullArea = rect.width * rect.height;

  return visibleArea / fullArea >= 0.5;
}

puyuyu.addEventListener("click", () => {
  if (scareEventTriggered) {
    return;
  }

  triggerLine(randomLine());
});

soundToggle.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  syncSoundToggle();

  if (!soundEnabled) {
    window.speechSynthesis?.cancel?.();
    speaking = false;
  }
});

lightToggle.addEventListener("click", () => {
  if (lightToggleLocked) {
    return;
  }

  if (!lightsOn && isVisitorMostlyVisible() && !scareEventTriggered) {
    beginVisitorScareEvent();
    return;
  }

  lightsOn = !lightsOn;
  playLightSwitchSound(lightsOn);
  syncLightToggle();
  scheduleVisitorVisit(1800);
});

puyuyu.addEventListener("animationiteration", (event) => {
  if (event.target !== puyuyu || !pendingMotionMode) {
    return;
  }

  applyMotionMode(pendingMotionMode);
  pendingMotionMode = null;
  scheduleNextMotion();
});

window.addEventListener("load", () => {
  loadLines().finally(() => {
    hasScareOccurred = getCookie(scareCookieName) === "1";
    scareAudio = new Audio("./event.mp3");
    scareAudio.preload = "auto";
    scareAudio.load();
    syncSoundToggle();
    syncLightToggle();
    document.body.classList.toggle("visitor-use-fallback", !supportsEmojiGlyph("🫪"));

    if (hasScareOccurred) {
      document.body.classList.add("scare-finished");
      return;
    }

    document.body.classList.add("puyuyu-ready");
    renderVoiceOptions();
    applyMotionMode(currentMotionMode);
    scheduleNextMotion();
    scheduleVisitorVisit();
    showLine(currentLine || lines[0]);
    scheduleNextLine(3200);
  });
});

window.speechSynthesis?.addEventListener?.("voiceschanged", () => {
  const previousVoiceURI = voiceSettings.voiceURI;
  renderVoiceOptions();

  if (previousVoiceURI && availableVoices.some((voice) => voice.voiceURI === previousVoiceURI)) {
    voiceSettings.voiceURI = previousVoiceURI;
  }

  if (!speaking && currentLine) {
    window.speechSynthesis.cancel();
  }
});

window.addEventListener("beforeunload", () => {
  clearTimers();
  window.speechSynthesis?.cancel?.();
});
