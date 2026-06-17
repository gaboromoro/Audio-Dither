// ==========================================================
// AudioWorklet procesor - bezi na audio vlakne (nie na UI vlakne).
// Generuje signal vzorku po vzorke, prida dither a kvantizuje v REALNOM CASE.
// Logika je zhodna so script.js, len pocita priebezne (fazovy akumulator)
// namiesto predpocitaneho pola.
// ==========================================================

class DitherProcessor extends AudioWorkletProcessor {

    // Plynule cisla -> AudioParam. Da sa nimi hybat pocas hrania bez restartu.
    static get parameterDescriptors() {
        return [
            { name: "amplitude",    defaultValue: 1, minValue: 0, maxValue: 1,  automationRate: "a-rate" },
            { name: "frequency",    defaultValue: 440, minValue: 1, maxValue: 20000, automationRate: "k-rate" },
            { name: "bits",         defaultValue: 8, minValue: 1, maxValue: 16, automationRate: "k-rate" },
            { name: "ditherAmount", defaultValue: 0, minValue: 0, maxValue: 1,  automationRate: "k-rate" }
        ];
    }

    constructor() {
        super();

        this.phase = 0;            // priebezna faza v <0, 1) - PREZIVA medzi blokmi
        this.signalType = "sinus"; // sinus | triangle | square | sawtooth
        this.ditherType = "tpdf";  // tpdf | rpdf | gaussian
        this.mode = "dithered";    // original | quantized | dithered
        this.running = false;      // play / stop

        // Diskretne volby a play/stop prichadzaju z hlavneho vlakna cez spravy.
        this.port.onmessage = (e) => {
            const d = e.data;
            if (d.signalType !== undefined) this.signalType = d.signalType;
            if (d.ditherType !== undefined) this.ditherType = d.ditherType;
            if (d.mode !== undefined) this.mode = d.mode;
            if (d.running !== undefined) this.running = d.running;
        };
    }

    // ----- Sumy (zhodne so script.js) -----
    tpdf() { return Math.random() - Math.random(); }
    rpdf() { return Math.random() - 0.5; }
    gaussian() {
        let u1 = 0;
        while (u1 === 0) u1 = Math.random();   // log(0) je nedefinovany
        const u2 = Math.random();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); // Box-Muller
    }
    noise() {
        if (this.ditherType === "rpdf") return this.rpdf();
        if (this.ditherType === "gaussian") return this.gaussian();
        return this.tpdf();
    }

    // ----- Generator jednej vzorky z fazy p v <0, 1) -----
    oscilator(p, A) {
        switch (this.signalType) {
            case "triangle":
                if (p <= 0.25) return A * (p * 4);
                if (p <= 0.75) return A * (2 - p * 4);
                return A * (p * 4 - 4);
            case "square":
                return p < 0.5 ? A : -A;
            case "sawtooth":
                return A * (2 * p - 1);
            default: // sinus
                return A * Math.sin(2 * Math.PI * p);
        }
    }

    // ----- Hlavny callback: vola sa pre kazdy blok 128 vzoriek -----
    process(inputs, outputs, parameters) {
        const out = outputs[0][0];   // prvy vystup, prvy kanal (Float32Array, 128 vzoriek)
        if (!out) return true;

        // Stop -> ticho, ale procesor zostava nazive.
        if (!this.running) {
            out.fill(0);
            return true;
        }

        const A = parameters.amplitude;           // a-rate -> pole (128)
        const f = parameters.frequency[0];        // k-rate -> jedno cislo
        const nBits = Math.round(parameters.bits[0]);
        const ditherAmt = parameters.ditherAmount[0];

        // Kvantizacia (rovnako ako getSchod/quantizer v script.js)
        const schod = 2 / Math.pow(2, nBits);
        const maxLevel = 1 - schod;
        const minLevel = -1;

        const phaseInc = f / sampleRate;          // sampleRate je globalne dostupne

        for (let i = 0; i < out.length; i++) {
            const a = A.length > 1 ? A[i] : A[0]; // a-rate vs k-rate

            // 1) vzorka signalu z aktualnej fazy
            let x = this.oscilator(this.phase, a);

            // 2) podla modu: dither pred kvantizaciou + kvantizacia
            if (this.mode !== "original") {
                let vstup = x;
                if (this.mode === "dithered") {
                    vstup = x + ditherAmt * schod * this.noise();
                }
                let q = Math.round(vstup / schod) * schod;  // mid-tread
                if (q < minLevel) q = minLevel;
                if (q > maxLevel) q = maxLevel;
                x = q;
            }

            out[i] = x;

            // 3) posun fazu a wrapuj (drzi cislo male, sin ostava presny)
            this.phase += phaseInc;
            if (this.phase >= 1) this.phase -= 1;
        }

        return true;   // true = drz procesor nazive
    }
}

registerProcessor("dither-processor", DitherProcessor);
