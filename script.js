// ==========================
// DOM prvky
// ==========================

const SliderAmp = document.getElementById("SliderAmp");
const SliderBitDepth = document.getElementById("SliderBitDepth");
const SliderDither = document.getElementById("SliderDither");
const bitsValue = document.getElementById("bitsValue");

const SignalType = document.getElementById("SignalType");
const DitherType = document.getElementById("DitherType");

const playOriginal = document.getElementById("playOriginal");
const stopOriginal = document.getElementById("stopOriginal");
const playQuantized = document.getElementById("playQuantized");
const stopQuantized = document.getElementById("stopQuantized");
const playDithered = document.getElementById("playDithered");
const stopDithered = document.getElementById("stopDithered");

// ==========================
// Konstanty
// ==========================

/////////////////////// SIGNAL

const FS = 44100;
const FREQ = 440;
const DURATION = 20;

// jedna perioda ma fs/f priblizne 100 vzoriek, kreslime teda jednu periodu signalu
const DRAW_SAMPLES = 101;

////////////////// GRID
// jeden graf je mriezka GRAPH_COLUMNS x GRAPH_ROWS stvorcekov
const GRAPH_SQUARE = 30;
const GRAPH_COLUMNS = 17;
const GRAPH_ROWS = 11;
const GRAPH_WIDTH = (GRAPH_COLUMNS - 1) * GRAPH_SQUARE;   // 480 px

const X_START = 60;
const Y_START = 20;
const OFFSET_X = 600;   // vzdialenost medzi grafmi
const MIDDLE_Y = Y_START + 5 * GRAPH_SQUARE;   // stred

const CANVAS_WIDTH = 1800;
const CANVAS_HEIGHT = 360;

//////////////// FARBY
const FARBA_GRAFU = '#FF4141';      // hlavny signal
const FARBA_REF_GRAFU = '#FFB300';  // referencny (povodny) signal
const FARBA_POZADIA = '#eef0f4';
const FARBA_TEXTU = '#000000';

const THICKNESS = 4; // hrubka ciary signalov

// ==========================
// Globalny stav aplikacie
// ==========================

let s = new Float32Array(0);            // povodny signal
let ss = new Float32Array(0);           // signal + dither
let qS = new Float32Array(0);           // kvantizovany signal s ditherom
let qSBezDither = new Float32Array(0);  // kvantizovany signal bez ditheru
let qErrorS = new Float32Array(0);      // kvantizacna chyba
let noiseBase = new Float32Array(0);    // ulozeny sum -- generuje sa len pri zmene typu ditheru

let audioCtx = null;

// ==========================
// Sumy
// ==========================

function TPDF() {
    return Math.random() - Math.random();
}

function RPDF() {
    return Math.random() - 0.5;
}

function Gaussian() {
    let u1 = 0;
    while (u1 === 0) {
        u1 = Math.random();                 // log(0) je nedefinovany
    }
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); // Box-Mullerova transformacia
}

// ==========================
// Generatory
// ==========================

function sinusGen({ A, f, fs, duration, phase = 0 }) {
    const N = Math.round(duration * fs);
    const signal = new Float32Array(N);

    for (let n = 0; n < N; n++) {
        const t = n / fs;
        signal[n] = A * Math.sin(2 * Math.PI * f * t + phase);
    }

    return signal;
}

function triangleGen({ A, f, fs, duration }) {
    const N = Math.round(duration * fs);
    const signal = new Float32Array(N);

    for (let n = 0; n < N; n++) {
        const p = (f * n / fs) % 1;   // pozicia v periode <0, 1)

        if (p <= 0.25) {
            signal[n] = A * (p * 4);
        } else if (p <= 0.75) {
            signal[n] = A * (2 - p * 4);
        } else {
            signal[n] = A * (p * 4 - 4);
        }
    }

    return signal;
}

function squareGen({ A, f, fs, duration, phase = 0 }) {
    const N = Math.round(duration * fs);
    const signal = new Float32Array(N);

    for (let n = 0; n < N; n++) {
        const angle = 2 * Math.PI * f * n / fs + phase;
        signal[n] = Math.sin(angle) >= 0 ? A : -A;
    }

    return signal;
}

function sawtoothGen({ A, f, fs, duration }) {
    const N = Math.round(duration * fs);
    const signal = new Float32Array(N);

    for (let n = 0; n < N; n++) {
        // + 0.5 periody (faza pi) posunie zlom pily do stredu zobrazenia
        const p = (f * n / fs + 0.5) % 1;   // pozicia v periode <0, 1)
        signal[n] = A * (2 * p - 1);
    }

    return signal;
}

// ==========================
// Kvantizacia
// ==========================

function getSchod(nBits) {
    const levels = Math.pow(2, nBits);
    return 2 / levels;   // rozsah <-1, 1> deleny poctom urovni
}

function quantizer(signal, nBits) {
    const schod = getSchod(nBits);
    const qSignal = new Float32Array(signal.length);
    const qErrorSignal = new Float32Array(signal.length);

    const maxLevel = 1 - schod;
    const minLevel = -1;

    for (let n = 0; n < signal.length; n++) {
        let q = Math.round(signal[n] / schod) * schod;   // mid-tread zaokruhlenie

        if (q < minLevel) q = minLevel;                  // povoleny rozsah
        if (q > maxLevel) q = maxLevel;

        qSignal[n] = q;
        qErrorSignal[n] = signal[n] - q;                 // kvantizacna chyba e[n]
    }

    return { qSignal, qErrorSignal };
}

// ==========================
// Dither
// ==========================

// vrati sumovu funkciu podla aktualne vybraneho typu
function getNoiseFunction() {
    const ditherType = DitherType.value;
    if (ditherType === "tpdf") return TPDF;
    if (ditherType === "rpdf") return RPDF;
    if (ditherType === "gaussian") return Gaussian;
}

// vygeneruje novu realizaciu sumu -- vola sa LEN pri zmene typu ditheru,
// nie pri posuvani posuvnikov (uroven, amplituda, bitova hlbka)
function regenerateNoise() {
    const noiseFunction = getNoiseFunction();
    const N = Math.round(DURATION * FS);
    noiseBase = new Float32Array(N);

    for (let n = 0; n < N; n++) {
        noiseBase[n] = noiseFunction();
    }
}

// prida ulozeny sum k signalu -- meni sa len jeho uroven (amount * schod),
// nahodny priebeh zostava rovnaky
function addDither(signal, schod, amount = 1) {
    const out = new Float32Array(signal.length);

    for (let n = 0; n < signal.length; n++) {
        out[n] = signal[n] + amount * schod * noiseBase[n];
    }

    return out;
}

// ==========================
// Hlavny prepocet
// ==========================

function updateSignals() {
    const amp = Number(SliderAmp.value) / 150;
    const nBits = Number(SliderBitDepth.value);
    const ditherAmount = Number(SliderDither.value);
    const schod = getSchod(nBits);
    bitsValue.textContent = nBits;

    const signalType = SignalType.value;

    // vyber generatora signalu
    if (signalType === "sinus") {
        s = sinusGen({ A: amp, f: FREQ, fs: FS, duration: DURATION });
    } else if (signalType === "triangle") {
        s = triangleGen({ A: amp, f: FREQ, fs: FS, duration: DURATION });
    } else if (signalType === "square") {
        s = squareGen({ A: amp, f: FREQ, fs: FS, duration: DURATION });
    } else if (signalType === "sawtooth") {
        s = sawtoothGen({ A: amp, f: FREQ, fs: FS, duration: DURATION });
    }

    // signal s ditherom -- sum sa pridava pred kvantizaciou
    // (pouzije sa ulozeny sum, novy sa generuje len pri zmene typu ditheru)
    ss = addDither(s, schod, ditherAmount);

    // kvantizacia signalu s ditherom (chybu berieme z tohto priebehu)
    const dithered = quantizer(ss, nBits);
    qS = dithered.qSignal;
    qErrorS = dithered.qErrorSignal;

    // referencna kvantizacia bez ditheru (len na prehravanie)
    qSBezDither = quantizer(s, nBits).qSignal;

    redraw();
    posliParametre();   // ak prave hrame, posli nove hodnoty do procesora (live update)
}

// ==========================
// Prehravanie v realnom case (AudioWorklet)
// ==========================
// Namiesto predpocitaneho bufferu generuje zvuk procesor na audio vlakne.
// Vzorky vznikaju az v callbacku z aktualnych hodnot sliderov -> zmenu pocut okamzite.

let workletNode = null;    // uzol s nasim procesorom (dither-processor.js)
let workletReady = null;   // Promise z addModule, aby sa modul nacital len raz

// Posle aktualne hodnoty z UI do procesora (parametre + diskretne volby).
function posliParametre() {
    if (!workletNode) return;   // este nehrame -> niet kam posielat

    const amp = Number(SliderAmp.value) / 150;
    const nBits = Number(SliderBitDepth.value);
    const ditherAmount = Number(SliderDither.value);
    const t = audioCtx.currentTime;

    // amplitudu menime plynulo (bez lupnutia), ostatne staci skokovo
    workletNode.parameters.get("amplitude").setTargetAtTime(amp, t, 0.01);
    workletNode.parameters.get("frequency").value = FREQ;
    workletNode.parameters.get("bits").value = nBits;
    workletNode.parameters.get("ditherAmount").value = ditherAmount;

    // diskretne volby idu spravou (nie su to plynule cisla)
    workletNode.port.postMessage({
        signalType: SignalType.value,
        ditherType: DitherType.value
    });
}

// Vytvori AudioContext, nacita procesor a uzol (len raz). Musi byt z gesta pouzivatela.
async function pripravAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
        await audioCtx.resume();   // autoplay policy: kontext sa rozbehne az po kliku
    }
    if (!workletNode) {
        if (!workletReady) {
            workletReady = audioCtx.audioWorklet.addModule("dither-processor.js");
        }
        await workletReady;        // pockame na nacitanie modulu (je to asynchronne)
        workletNode = new AudioWorkletNode(audioCtx, "dither-processor");
        workletNode.connect(audioCtx.destination);
        posliParametre();
    }
}

// Spusti prehravanie v danom mode: "original" | "quantized" | "dithered"
async function prehraj(mode) {
    await pripravAudio();
    posliParametre();
    workletNode.port.postMessage({ mode: mode, running: true });
}

function zastav() {
    if (workletNode) {
        workletNode.port.postMessage({ running: false });
    }
}

playOriginal.addEventListener("click", () => prehraj("original"));
stopOriginal.addEventListener("click", zastav);

playQuantized.addEventListener("click", () => prehraj("quantized"));   // bez ditheru
stopQuantized.addEventListener("click", zastav);

playDithered.addEventListener("click", () => prehraj("dithered"));     // s ditherom
stopDithered.addEventListener("click", zastav);

// ==========================
// Vykreslovanie
// ==========================

function setup() {
    const cnv = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    cnv.parent("canvas-container");
    noLoop();          // prekresluje sa len pri zmene parametrov
    regenerateNoise();
    updateSignals();
}

function drawGrid(x0) {
    stroke(FARBA_TEXTU);

    // vodorovne ciary
    for (let i = 0; i < GRAPH_ROWS; i++) {
        const y = Y_START + i * GRAPH_SQUARE;
        strokeWeight(i === 5 ? 2 : 0.7);   // hrubsia stredova os
        line(x0, y, x0 + GRAPH_WIDTH, y);
    }

    // zvisle ciary
    for (let i = 0; i < GRAPH_COLUMNS; i++) {
        const x = x0 + i * GRAPH_SQUARE;
        strokeWeight(i === 0 ? 2 : 0.7);
        line(x, Y_START, x, Y_START + (GRAPH_ROWS - 1) * GRAPH_SQUARE);
    }

    // popisy osi
    noStroke();
    fill(FARBA_TEXTU);
    textSize(12);

    // os y -- amplituda od 1 po -1
    textAlign(RIGHT, CENTER);
    for (let i = 0; i < GRAPH_ROWS; i++) {
        const y = Y_START + i * GRAPH_SQUARE;
        let value = 1 - i * 0.2;
        if (Math.abs(value) < 0.001) value = 0;   // aby sa nezobrazilo -0
        text(Number(value.toFixed(1)), x0 - 8, y);
    }

    // os x -- jedna perioda
    textAlign(CENTER, TOP);
    const xLabels = ['0', 'π/2', 'π', '3π/2', '2π'];
    for (let k = 1; k < xLabels.length; k++) {
        const x = x0 + (GRAPH_WIDTH / 4) * k;
        text(xLabels[k], x, MIDDLE_Y + 8);
    }
}

function drawSignalPart(signal, x0, color, yScale = 150) {
    stroke(color);
    strokeWeight(THICKNESS);
    noFill();
    strokeJoin(BEVEL);

    const xScale = GRAPH_WIDTH / (DRAW_SAMPLES - 1);

    beginShape();
    for (let n = 0; n < DRAW_SAMPLES; n++) {
        vertex(x0 + n * xScale, MIDDLE_Y - signal[n] * yScale);
    }
    endShape();
}

function draw() {
    background(FARBA_POZADIA);

    // tri mriezky vedla seba
    drawGrid(X_START);
    drawGrid(X_START + OFFSET_X);
    drawGrid(X_START + 2 * OFFSET_X);

    // 1. graf -- povodny signal a signal s ditherom
    drawSignalPart(s, X_START, FARBA_REF_GRAFU);
    drawSignalPart(ss, X_START, FARBA_GRAFU);

    // 2. graf -- povodny a kvantizovany signal
    drawSignalPart(s, X_START + OFFSET_X, FARBA_REF_GRAFU);
    drawSignalPart(qS, X_START + OFFSET_X, FARBA_GRAFU);

    // 3. graf -- kvantizacna chyba
    drawSignalPart(qErrorS, X_START + 2 * OFFSET_X, FARBA_GRAFU);
}

// ==========================
// Ovladacie prvky
// ==========================

SliderAmp.addEventListener("input", updateSignals);
SliderBitDepth.addEventListener("input", updateSignals);
SliderDither.addEventListener("input", updateSignals);
SignalType.addEventListener("change", updateSignals);
DitherType.addEventListener("change", () => {
    regenerateNoise();   // novy typ ditheru -> nova realizacia sumu
    updateSignals();
});

function keyPressed() {
    if (key === 's') {
        saveCanvas('graf', 'png');
    }
    if (key === 'f') {
        html2canvas(document.body).then(canvas => {
            const a = document.createElement('a');
            a.download = 'ui.png';
            a.href = canvas.toDataURL();
            a.click();
        });
    }
}
