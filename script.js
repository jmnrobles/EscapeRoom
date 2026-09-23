// ---------- AUDIO (sintetizado, sin archivos externos) ----------

let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function beep({ freq = 440, duration = 0.08, type = "square", volume = 0.05, delay = 0 }) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = volume;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const start = ctx.currentTime + delay;
    osc.start(start);
    gain.gain.setValueAtTime(volume, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.stop(start + duration + 0.02);
  } catch (e) {
    /* audio no disponible: seguimos sin sonido */
  }
}

function keyTone() {
  beep({ freq: 700 + Math.random() * 120, duration: 0.05, type: "square", volume: 0.04 });
}

function alarmTone() {
  beep({ freq: 220, duration: 0.28, type: "sawtooth", volume: 0.07 });
  beep({ freq: 160, duration: 0.28, type: "sawtooth", volume: 0.07, delay: 0.3 });
}

function successTone() {
  [523, 659, 784, 1046].forEach((f, i) => {
    beep({ freq: f, duration: 0.14, type: "sine", volume: 0.05, delay: i * 0.09 });
  });
}

// ---------- GLITCH AMBIENTE ----------

const glitchTitle = document.querySelector(".glitch");
const statusDot = document.getElementById("status-dot");

function triggerGlitch() {
  if (!glitchTitle) return;
  glitchTitle.classList.add("active-glitch");
  setTimeout(() => glitchTitle.classList.remove("active-glitch"), 260);
}

setInterval(() => {
  if (Math.random() < 0.35) triggerGlitch();
}, 3200);

// ---------- PANTALLA 1: PIN ----------

const CODE = "4619";

const pinScreen = document.getElementById("pin-screen");
const videoScreen = document.getElementById("video-screen");
const pinDigits = Array.from(document.querySelectorAll(".pin-digit"));
const pinError = document.getElementById("pin-error");
const pinSuccess = document.getElementById("pin-success");
const attemptsLabel = document.getElementById("attempts-label");
const noiseBurst = document.getElementById("noise-burst");

let attempts = 0;

const FAIL_MESSAGES = [
  "⚠ ACCESO DENEGADO — INTENTO REGISTRADO",
  "⚠ SECUENCIA INCORRECTA — VIGILANCIA ALERTADA",
  "⚠ CLAVE RECHAZADA — REVISE EL PROTOCOLO",
  "⚠ FALLO DE VALIDACIÓN — CONTENCIÓN ACTIVA",
];

pinDigits[0].focus();

pinDigits.forEach((input, i) => {
  input.addEventListener("input", () => {
    input.value = input.value.replace(/[^0-9]/g, "").slice(0, 1);
    input.classList.toggle("filled", !!input.value);

    if (input.value) {
      keyTone();
    }

    pinError.classList.remove("show");
    pinDigits.forEach(d => d.classList.remove("wrong"));

    if (input.value && i < pinDigits.length - 1) {
      pinDigits[i + 1].focus();
    }

    if (pinDigits.every(d => d.value.length === 1)) {
      checkCode();
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" && !input.value && i > 0) {
      pinDigits[i - 1].focus();
    }
  });
});

function flashAlarm() {
  noiseBurst.classList.remove("flash");
  void noiseBurst.offsetWidth; // reinicia la animación
  noiseBurst.classList.add("flash");
  statusDot.classList.add("alarm");
  setTimeout(() => statusDot.classList.remove("alarm"), 700);
}

function flashOk() {
  noiseBurst.classList.remove("flash-ok");
  void noiseBurst.offsetWidth;
  noiseBurst.classList.add("flash-ok");
}

function checkCode() {
  const entered = pinDigits.map(d => d.value).join("");
  if (entered === CODE) {
    grantAccess();
  } else {
    attempts++;
    attemptsLabel.textContent = `INTENTOS REGISTRADOS: ${attempts}`;
    pinError.textContent = FAIL_MESSAGES[Math.min(attempts - 1, FAIL_MESSAGES.length - 1)];
    pinError.classList.add("show");
    pinDigits.forEach(d => d.classList.add("wrong"));
    alarmTone();
    flashAlarm();
    triggerGlitch();

    setTimeout(() => {
      pinDigits.forEach(d => {
        d.value = "";
        d.classList.remove("wrong");
        d.classList.remove("filled");
      });
      pinDigits[0].focus();
    }, 500);
  }
}

function grantAccess() {
  pinDigits.forEach(d => d.blur());
  pinError.classList.remove("show");
  pinSuccess.classList.add("show");
  successTone();
  flashOk();

  setTimeout(() => {
    pinScreen.classList.remove("active");
    videoScreen.classList.add("active");
    video.load();
  }, 900);
}

// ---------- PANTALLA 2: REPRODUCTOR DE VIDEO ----------

const video = document.getElementById("player");
const btnPlay = document.getElementById("btn-play");
const btnPause = document.getElementById("btn-pause");
const btnStart = document.getElementById("btn-start");
const btnEnd = document.getElementById("btn-end");
const btnReverse = document.getElementById("btn-reverse");
const progressBar = document.getElementById("progress-bar");
const progressFill = document.getElementById("progress-fill");
const timeDisplay = document.getElementById("time-display");
const feedTimestamp = document.getElementById("feed-timestamp");

let reversing = false;
let reverseRAF = null;
let reverseSeekPending = false;

// ---------- AUDIO EN REVERSA ----------
// El <video> solo suena mientras reproduce; durante la reversa lo mantenemos
// en pausa e "hacemos scrubbing" de su currentTime, así que no emite sonido.
// Para que se oiga algo al ir hacia atrás, decodificamos la pista de audio
// del propio vídeo una vez (Web Audio API) y generamos una copia con las
// muestras invertidas (como una cinta al revés).
//
// En vez de reproducir esa copia como un único clip largo a velocidad
// normal (que se desincroniza del scrubbing visual —cuya velocidad varía
// según lo que tarde cada salto— y acaba agotándose y quedando en
// silencio), reproducimos pequeños "granos" de audio (~120ms) en un
// intervalo continuo, releídos en cada tick desde el punto exacto en el
// que está el vídeo. Así el audio nunca se desincroniza ni se acaba antes
// de tiempo, sea cual sea la velocidad real de la reversa.

let reversedAudioBuffer = null;
let reverseAudioTimer = null;

async function prepareReverseAudio() {
  reversedAudioBuffer = null;
  try {
    const ctx = getAudioCtx();
    const response = await fetch(video.currentSrc || video.src);
    const arrayBuffer = await response.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arrayBuffer);

    const reversed = ctx.createBuffer(decoded.numberOfChannels, decoded.length, decoded.sampleRate);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const src = decoded.getChannelData(ch);
      const dst = reversed.getChannelData(ch);
      for (let i = 0, j = src.length - 1; i < src.length; i++, j--) {
        dst[i] = src[j];
      }
    }
    reversedAudioBuffer = reversed;
  } catch (e) {
    // Sin audio de reversa disponible (p. ej. el vídeo se abrió como
    // archivo local con doble clic, sin servidor: el navegador bloquea
    // la descarga del archivo por CORS). La reversa seguirá funcionando
    // en silencio.
    reversedAudioBuffer = null;
  }
}

const REVERSE_AUDIO_GRAIN = 0.12; // duración de cada grano de audio (s)
const REVERSE_AUDIO_INTERVAL = 90; // cada cuánto se dispara un grano (ms)

function playReverseAudioGrain() {
  if (!reversedAudioBuffer) return;

  try {
    const ctx = getAudioCtx();
    const pos = reversedAudioBuffer.duration - video.currentTime;
    const offset = Math.max(0, Math.min(reversedAudioBuffer.duration - REVERSE_AUDIO_GRAIN, pos));

    const src = ctx.createBufferSource();
    src.buffer = reversedAudioBuffer;

    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + 0.015);
    gain.gain.linearRampToValueAtTime(0, now + REVERSE_AUDIO_GRAIN);

    src.connect(gain).connect(ctx.destination);
    src.start(now, offset, REVERSE_AUDIO_GRAIN);
    src.stop(now + REVERSE_AUDIO_GRAIN + 0.02);
  } catch (e) {
    /* si un grano falla, simplemente no suena ese instante */
  }
}

function startReverseAudio() {
  stopReverseAudio();
  if (!reversedAudioBuffer) return;
  playReverseAudioGrain();
  reverseAudioTimer = setInterval(playReverseAudioGrain, REVERSE_AUDIO_INTERVAL);
}

function stopReverseAudio() {
  if (reverseAudioTimer) {
    clearInterval(reverseAudioTimer);
    reverseAudioTimer = null;
  }
}

function formatTime(t) {
  if (!isFinite(t)) return "00:00";
  const m = Math.floor(t / 60).toString().padStart(2, "0");
  const s = Math.floor(t % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function formatFeedTime(t) {
  if (!isFinite(t)) t = 0;
  const h = Math.floor(t / 3600).toString().padStart(2, "0");
  const m = Math.floor((t % 3600) / 60).toString().padStart(2, "0");
  const s = Math.floor(t % 60).toString().padStart(2, "0");
  return `T+${h}:${m}:${s}`;
}

function updateProgress() {
  const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
  progressFill.style.width = pct + "%";
  timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
  feedTimestamp.textContent = formatFeedTime(video.currentTime);
}

// Reproducción en reversa: si restamos un paso fijo de tiempo de vídeo en
// cada frame de animación, la velocidad real depende de lo que tarde cada
// salto ("seeked") en resolverse — y eso casi siempre es más lento que el
// tiempo real, por lo que la reversa se ve más lenta que la reproducción
// normal. Para que vaya a la MISMA velocidad en los dos sentidos, calculamos
// en todo momento el punto que "tocaría" según el tiempo real transcurrido
// desde que se pulsó reversa (reloj real, no pasos fijos), y saltamos ahí.
// Si un salto tarda más de lo esperado, el siguiente objetivo ya tiene en
// cuenta ese retraso y "recupera" el tiempo perdido en vez de arrastrarlo.
function stopReverse() {
  reversing = false;
  reverseSeekPending = false;
  btnReverse.classList.remove("active");
  if (reverseRAF) cancelAnimationFrame(reverseRAF);
  reverseRAF = null;
  stopReverseAudio();
}

let reverseStartWallTime = 0;
let reverseStartVideoTime = 0;

function reverseStep() {
  if (!reversing || reverseSeekPending) return;

  const elapsed = (performance.now() - reverseStartWallTime) / 1000;
  const target = reverseStartVideoTime - elapsed;
  reverseSeekPending = true;

  if (target <= 0) {
    video.currentTime = 0;
  } else {
    video.currentTime = target;
  }
}

function startReverse() {
  video.pause();
  reversing = true;
  reverseSeekPending = false;
  btnReverse.classList.add("active");
  btnPlay.textContent = "▶";
  startReverseAudio();
  reverseStartWallTime = performance.now();
  reverseStartVideoTime = video.currentTime;
  reverseStep();
}

video.addEventListener("seeked", () => {
  if (!reversing) return;
  reverseSeekPending = false;
  updateProgress();

  if (video.currentTime <= 0) {
    stopReverse();
    return;
  }

  reverseRAF = requestAnimationFrame(reverseStep);
});

btnReverse.addEventListener("click", () => {
  if (reversing) {
    stopReverse();
  } else {
    startReverse();
  }
});

btnPlay.addEventListener("click", () => {
  if (reversing) {
    stopReverse();
    return;
  }

  if (video.paused || video.ended) {
    video.play();
  } else {
    video.pause();
  }
});

video.addEventListener("play", () => {
  btnPlay.textContent = "⏸";
});

video.addEventListener("pause", () => {
  if (!reversing) btnPlay.textContent = "▶";
});

btnStart.addEventListener("click", () => {
  stopReverse();
  video.pause();
  video.currentTime = 0;
  updateProgress();
});

btnEnd.addEventListener("click", () => {
  stopReverse();
  video.pause();
  if (isFinite(video.duration)) {
    video.currentTime = video.duration;
  }
  updateProgress();
});

video.addEventListener("timeupdate", () => {
  if (!reversing) updateProgress();
});

video.addEventListener("loadedmetadata", () => {
  updateProgress();
  prepareReverseAudio();
});

progressBar.addEventListener("click", (e) => {
  stopReverse();
  const rect = progressBar.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  if (isFinite(video.duration)) {
    video.currentTime = ratio * video.duration;
  }
  updateProgress();
});
