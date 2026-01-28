// main.js
import * as Vex from 'https://cdn.jsdelivr.net/npm/vexflow@4.2.3/releases/vexflow-min.js';
const yin = pitchfinder.YIN({ sampleRate: audioCtx.sampleRate });

// ── State ────────────────────────────────────────
let audioCtx;
let analyser;
let scriptProcessor;
let stream;
let isRecording = false;
let pitches = [];     // [{startTime, endTime, midiNote}]
let notes = [];       // for VexFlow

const status = document.getElementById('status');
const staffDiv = document.getElementById('staff');

// ── Pitch utilities ──────────────────────────────
const A4 = 440;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function frequencyToMidi(f) {
  if (f <= 0) return null;
  const note = 12 * Math.log2(f / A4) + 69;
  return Math.round(note);
}

function midiToNoteName(midi) {
  const octave = Math.floor(midi / 12) - 1;
  const name = NOTE_NAMES[midi % 12];
  return `${name}/${octave}`;
}

// Very basic autocorrelation pitch detection → replace with this faster version
function detectPitch(buffer, sampleRate) {
  const SIZE = buffer.length;
  const MAX_LAG = Math.min(512, SIZE / 2);   // limit search to reasonable voice range
  const MIN_LAG = 40;                        // ~1100 Hz max

  let maxCorr = 0;
  let bestLag = -1;

  // Pre-compute energy once (rough RMS)
  let energy = 0;
  for (let i = 0; i < SIZE; i++) energy += buffer[i] * buffer[i];
  if (energy < 0.0001) return -1;  // too quiet → skip

  for (let lag = MIN_LAG; lag < MAX_LAG; lag++) {
    let corr = 0;
    // Only correlate overlapping part + early exit if corr already too low
    const maxPossible = SIZE - lag;
    for (let i = 0; i < maxPossible; i += 2) {  // step by 2 → 2× speedup, still accurate enough
      corr += buffer[i] * buffer[i + lag];
    }
    corr /= maxPossible;  // normalize roughly

    if (corr > maxCorr) {
      maxCorr = corr;
      bestLag = lag;
    }
    // Early exit if correlation is dropping too much
    if (maxCorr > 0.4 && corr < maxCorr * 0.6) break;
  }

  if (bestLag < 1 || maxCorr < 0.15) return -1; // noise threshold raised a bit
  return sampleRate / bestLag;
}

// ── Audio pipeline ───────────────────────────────
async function startRecording() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    scriptProcessor = audioCtx.createScriptProcessor(1024, 1, 1);
    analyser.connect(scriptProcessor);
    scriptProcessor.connect(audioCtx.destination);

    const buffer = new Float32Array(scriptProcessor.bufferSize);
    let lastNoteStart = 0;
    let lastFreq = -1;

    scriptProcessor.onaudioprocess = (e) => {
      if (!isRecording) return;
      const input = e.inputBuffer.getChannelData(0);
      const freq = yin(input);   // returns Hz or -1 if no pitch

      const now = audioCtx.currentTime;

      if (freq > 60 && freq < 1200) {   // reasonable voice range
        const midi = frequencyToMidi(freq);

        if (midi !== lastFreq) {
          // new note → close previous if any
          if (lastFreq !== -1) {
            pitches.push({ start: lastNoteStart, end: now, midi: lastFreq });
          }
          lastNoteStart = now;
          lastFreq = midi;
        }
      } else if (lastFreq !== -1) {
        // silence → close note
        pitches.push({ start: lastNoteStart, end: now, midi: lastFreq });
        lastFreq = -1;
      }
    };

    isRecording = true;
    document.getElementById('start').disabled = true;
    document.getElementById('stop').disabled = false;
    status.textContent = "Listening… sing now!";
  } catch (err) {
    status.textContent = "Microphone error: " + err.message;
  }
}

function stopAndTranscribe() {
  if (!isRecording) return;
  isRecording = false;

  document.getElementById('start').disabled = false;
  document.getElementById('stop').disabled = true;
  status.textContent = "Processing…";

  stream.getTracks().forEach(t => t.stop());
  scriptProcessor.disconnect();
  analyser.disconnect();

  // Very naive note merging / quantization
  const merged = [];
  let current = null;

  pitches.forEach(p => {
    if (!current || p.midi !== current.midi || (p.start - current.end) > 0.15) {
      if (current) merged.push(current);
      current = { midi: p.midi, durationMs: (p.end - p.start) * 1000 };
    } else {
      current.durationMs += (p.end - p.start) * 1000;
    }
  });
  if (current) merged.push(current);

  // Convert to simple quarter/eighth notes (very crude)
  notes = merged.map(n => {
    let dur = "4"; // quarter
    if (n.durationMs < 350) dur = "8";
    if (n.durationMs > 1200) dur = "2";
    return { keys: [midiToNoteName(n.midi)], duration: dur };
  });

  renderScore();
  status.textContent = `Found ${notes.length} notes.`;
  document.getElementById('play').disabled = notes.length === 0;
  document.getElementById('export-svg').disabled = notes.length === 0;
}

function renderScore() {
  staffDiv.innerHTML = "";
  const renderer = new Vex.Flow.Renderer(staffDiv, Vex.Flow.Renderer.Backends.SVG);
  renderer.resize(800, 200);
  const context = renderer.getContext();

  const stave = new Vex.Flow.Stave(10, 40, 780);
  stave.addClef("treble").addTimeSignature("4/4");
  stave.setContext(context).draw();

  if (notes.length === 0) return;

  const voice = new Vex.Flow.Voice({ num_beats: 4, beat_value: 4 });
  const staveNotes = notes.map(n =>
    new Vex.Flow.StaveNote({
      keys: n.keys,
      duration: n.duration
    })
  );

  voice.addTickables(staveNotes);
  new Vex.Flow.Formatter().joinVoices([voice]).format([voice], 750);
  voice.draw(context, stave);
}

// ── Playback (very simple oscillator) ─────────────
let playbackSynth;

function playMelody() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (playbackSynth) playbackSynth.stop();

  let time = audioCtx.currentTime;
  notes.forEach(note => {
    const [key] = note.keys[0].split('/');
    const octave = parseInt(key.slice(-1));
    const noteName = key.slice(0, -1);
    const freq = Vex.Flow.semitonesFromNote(noteName + '/' + octave) * 440 / 12; // approx

    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, time);

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.4, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.1);

    osc.connect(gain).connect(audioCtx.destination);
    osc.start(time);
    osc.stop(time + 0.15); // crude duration

    time += 0.25; // fixed tempo for demo
  });
}

// ── Export ───────────────────────────────────────
function exportSVG() {
  const svg = staffDiv.querySelector('svg');
  if (!svg) return;
  const data = new XMLSerializer().serializeToString(svg);
  const blob = new Blob([data], {type: 'image/svg+xml'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'myscore.svg';
  a.click();
  URL.revokeObjectURL(url);
}

// ── Event listeners ──────────────────────────────
document.getElementById('start').onclick = startRecording;
document.getElementById('stop').onclick = stopAndTranscribe;
document.getElementById('play').onclick = playMelody;
document.getElementById('export-svg').onclick = exportSVG;
