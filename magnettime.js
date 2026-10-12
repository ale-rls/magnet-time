// magnettime.js  --  brain for the "Magnet Time" Max for Live device
// Max 8 / Live 11  --  ES5 only (no let/const/arrow functions)
//
// Takes a plain 0..100 knob and warps it so that musically meaningful
// values (1/4, 1/8, 1/16 ... at the current Live tempo) behave like soft
// detents: the value gets "heavy" as you approach one, sits on it for a
// while, and you have to keep turning to break out.

autowatch = 1;
inlets = 1;
outlets = 2; // 0: parameter values, 1: target IDs for live.remote~ right inlet

var PAT = this.patcher;

// ---------------------------------------------------------------- state
var KNOB    = 0.0;   // 0..1, raw position from the dial
var MAGNET  = 0.85;  // 0..1, detent strength
var GRIDIX  = 1;     // 0 = down to 1/4, 1 = 1/8, 2 = 1/16, 3 = 1/32
var FEELIX  = 0;     // 0 straight, 1 +triplet, 2 +dotted, 3 all
var SCALEIX = 1;     // 0 linear, 1 exponential
var MINMS   = 20.0;
var MAXMS   = 1000.0;

var tempo   = 120.0;
var target  = null;      // LiveAPI on the mapped DeviceParameter
var pmin    = 0.0;
var pmax    = 1.0;
var calMode = "none";    // "auto" (str_for_value LUT) | "manual" | "none"
var lutV    = [];
var lutMS   = [];

var anchorsPos  = [];
var anchorsMs   = [];
var anchorsName = [];
var ENC         = 0;     // 0 = mapped dial, 1 = read the encoder directly
var RES         = 400;  // encoder ticks for a full sweep
var encCC       = -1;
var encCh       = -1;
var encLearn    = 0;
var internalSet = 0;
var HELD        = -1;     // exact musical anchor held by the current knob position

var mapping    = 0;
var pollTask   = null;
var baselineId = "0";
var armTicks   = 0;
var tempoObs   = null;
var booted   = 0;

var DIVS = [ ["1/1", 4.0], ["1/2", 2.0], ["1/4", 1.0],
             ["1/8", 0.5], ["1/16", 0.25], ["1/32", 0.125] ];

var TOK = ["live_set", "tracks", "return_tracks", "master_track", "devices",
           "chains", "return_chains", "parameters", "drum_pads", "mixer_device"];

// ------------------------------------------------------------- helpers
function idxOf(arr, v) {
    for (var i = 0; i < arr.length; i++) { if (arr[i] === v) return i; }
    return -1;
}

function named(n) {
    try { return PAT.getnamed(n); } catch (e) { return null; }
}

function getv(n, dflt) {
    var o = named(n);
    if (!o) return dflt;
    var v = o.getvalueof();
    if (v === null || v === undefined) return dflt;
    if (v instanceof Array) { return v.length ? v[0] : dflt; }
    return v;
}

function setv(n, val) {
    var o = named(n);
    if (o) { o.setvalueof(val); }
}

function say(n, txt) {
    var o = named(n);
    if (o) { o.message("set", txt); }
}

function fmtMs(ms) {
    if (ms >= 1000) return (Math.round(ms / 10) / 100) + " s";
    if (ms >= 100)  return Math.round(ms) + " ms";
    return (Math.round(ms * 10) / 10) + " ms";
}

// ------------------------------------------------- knob <-> milliseconds
function posToMs(x) {
    if (SCALEIX === 1 && MINMS > 0 && MAXMS > MINMS) {
        return MINMS * Math.pow(MAXMS / MINMS, x);
    }
    return MINMS + x * (MAXMS - MINMS);
}

function msToPos(ms) {
    if (MAXMS <= MINMS) return 0.0;
    if (SCALEIX === 1 && MINMS > 0) {
        return Math.log(ms / MINMS) / Math.log(MAXMS / MINMS);
    }
    return (ms - MINMS) / (MAXMS - MINMS);
}

// ------------------------------------------------------------- anchors
function buildAnchors() {
    var wanted = [];
    var last = 2 + GRIDIX;
    if (last > DIVS.length - 1) last = DIVS.length - 1;

    for (var i = 0; i <= last; i++) {
        var nm = DIVS[i][0];
        var beats = DIVS[i][1];
        wanted.push([beats, nm]);
        if (FEELIX === 1 || FEELIX === 3) wanted.push([beats * 2.0 / 3.0, nm + "T"]);
        if (FEELIX === 2 || FEELIX === 3) wanted.push([beats * 1.5, nm + "."]);
    }

    var msPerBeat = 60000.0 / tempo;
    var inRange = [];
    for (var j = 0; j < wanted.length; j++) {
        var ms = wanted[j][0] * msPerBeat;
        if (ms > MINMS * 1.001 && ms < MAXMS * 0.999) inRange.push([ms, wanted[j][1]]);
    }
    inRange.sort(function (a, b) { return a[0] - b[0]; });

    anchorsPos = [0.0];
    anchorsMs = [MINMS];
    anchorsName = [""];
    for (var k = 0; k < inRange.length; k++) {
        var p = msToPos(inRange[k][0]);
        if (p > 0.004 && p < 0.996 && p > anchorsPos[anchorsPos.length - 1] + 0.004) {
            anchorsPos.push(p);
            anchorsMs.push(inRange[k][0]);
            anchorsName.push(inRange[k][1]);
        }
    }
    anchorsPos.push(1.0);
    anchorsMs.push(MAXMS);
    anchorsName.push("");
}

// Exact flat zones around musical anchors, with short cosine shoulders.
// Outside the shoulders travel has constant speed in the selected scale.
// Integrating the velocity profile keeps entry/release continuous and avoids
// concentrating almost the entire interval into one large mid-gap jump.
// Unlabelled range endpoints do not get artificial holds.
function holdWidth() {
    var m = Math.max(0, Math.min(1, MAGNET));
    // Keep the existing feel through 85%; reserve the top end for strong glue.
    var boost = Math.max(0, (m - 0.85) / 0.15);
    return 0.12 * m + 0.28 * boost * boost;
}

function warp(x) {
    HELD = -1;
    var n = anchorsPos.length;
    if (n < 2 || MAGNET <= 0) return x;
    var i = 0;
    while (i < n - 2 && x >= anchorsPos[i + 1]) i++;
    var a = anchorsPos[i];
    var b = anchorsPos[i + 1];
    if (b - a <= 1e-9) return x;
    var t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    var width = holdWidth();
    var left = anchorsName[i] ? width : 0;
    var right = anchorsName[i + 1] ? width : 0;
    if (left > 0 && t <= left) { HELD = i; return a; }
    if (right > 0 && t >= 1 - right) { HELD = i + 1; return b; }
    // Shorten the shoulders as holds widen so a continuous transition remains.
    var shoulder = Math.min(0.12 * MAGNET, (1 - left - right) * 0.25);
    var ls = left > 0 ? shoulder : 0;
    var rs = right > 0 ? shoulder : 0;
    var total = 1 - left - right - 0.5 * (ls + rs);
    var area, u;
    if (ls > 0 && t < left + ls) {
        u = (t - left) / ls;
        area = 0.5 * ls * (u - Math.sin(Math.PI * u) / Math.PI);
    } else if (rs > 0 && t > 1 - right - rs) {
        u = (1 - right - t) / rs;
        area = total - 0.5 * rs * (u - Math.sin(Math.PI * u) / Math.PI);
    } else {
        area = t - left - 0.5 * ls;
    }
    return a + (b - a) * Math.max(0, Math.min(1, area / total));
}

// --------------------------------------------------------- calibration
function parseMs(s) {
    if (s === null || s === undefined) return null;
    s = String(s);
    var m = s.match(/-?[0-9]+(\.[0-9]+)?/);
    if (!m) return null;
    var val = parseFloat(m[0]);
    if (isNaN(val)) return null;
    if (/ms|millisec/i.test(s)) return val;
    if (/sec|[0-9]\s*s\b/i.test(s)) return val * 1000.0;
    return val;
}

function calibrate() {
    lutV = [];
    lutMS = [];
    calMode = "none";
    if (!target) return;

    pmin = parseFloat(target.get("min"));
    pmax = parseFloat(target.get("max"));
    if (isNaN(pmin)) pmin = 0.0;
    if (isNaN(pmax)) pmax = 1.0;

    var N = 200;
    var vs = [], ms = [], ok = 0;
    for (var i = 0; i <= N; i++) {
        var v = pmin + (pmax - pmin) * i / N;
        var s = null;
        try { s = target.call("str_for_value", v); } catch (e) { s = null; }
        var val = parseMs(s);
        if (val === null) continue;
        vs.push(v); ms.push(val); ok++;
    }

    if (ok < (N * 0.8) || vs.length < 2) { calMode = "manual"; return; }

    // Flip if the plugin counts downwards, then force monotonic.
    if (ms[ms.length - 1] < ms[0]) { vs.reverse(); ms.reverse(); }
    var cv = [], cm = [];
    for (var k = 0; k < ms.length; k++) {
        if (cm.length === 0 || ms[k] > cm[cm.length - 1]) { cm.push(ms[k]); cv.push(vs[k]); }
    }
    if (cm.length < 2 || cm[cm.length - 1] - cm[0] <= 0) { calMode = "manual"; return; }

    lutV = cv;
    lutMS = cm;
    calMode = "auto";
}

function autoRange() {
    if (calMode !== "auto") return;
    var loLim = lutMS[0];
    var hiLim = lutMS[lutMS.length - 1];
    // A plugin that runs 0-3500 ms crams every division into the top third of
    // the knob. Open on the musically useful window instead -- half a 1/32 up
    // to a little past a whole note -- clamped to the plugin's real span.
    var beat = 60000.0 / tempo;
    var lo = beat * 0.0625;
    var hi = beat * 4.8;
    if (lo < loLim) lo = loLim;
    if (hi > hiLim) hi = hiLim;
    if (lo < 0.1) lo = 0.1;
    if (hi <= lo * 1.5) { lo = Math.max(loLim, 0.1); hi = hiLim; }
    MINMS = Math.round(lo * 10) / 10;
    MAXMS = Math.round(hi);
    setv("minms", MINMS);
    setv("maxms", MAXMS);
}

function msToParam(ms) {
    if (calMode === "auto") {
        var n = lutMS.length;
        if (ms <= lutMS[0]) return lutV[0];
        if (ms >= lutMS[n - 1]) return lutV[n - 1];
        var lo = 0, hi = n - 1;
        while (hi - lo > 1) {
            var mid = (lo + hi) >> 1;
            if (lutMS[mid] <= ms) lo = mid; else hi = mid;
        }
        var span = lutMS[hi] - lutMS[lo];
        var f = span > 0 ? (ms - lutMS[lo]) / span : 0;
        return lutV[lo] + f * (lutV[hi] - lutV[lo]);
    }
    if (MAXMS <= MINMS) return pmin;
    var frac = (ms - MINMS) / (MAXMS - MINMS);
    if (frac < 0) frac = 0;
    if (frac > 1) frac = 1;
    return pmin + frac * (pmax - pmin);
}

// -------------------------------------------------------------- output
function update() {
    var wx = warp(KNOB);
    var ms = HELD >= 0 ? anchorsMs[HELD] : posToMs(wx);

    if (target) outlet(0, msToParam(ms));

    var nearest = "";
    var locked = 0;
    var best = 1e9;
    for (var i = 1; i < anchorsMs.length - 1; i++) {
        var rel = Math.abs(Math.log(ms / anchorsMs[i]));
        if (rel < best) { best = rel; nearest = anchorsName[i]; }
    }
    if (HELD >= 0) { nearest = anchorsName[HELD]; locked = 1; }

    say("readout", fmtMs(ms) + (nearest ? ("   " + nearest + (locked ? "  \u25CF" : "")) : ""));
}

// ------------------------------------------------------------- mapping
function storePath(p) {
    p = String(p).replace(/"/g, "");
    var parts = p.split(" ");
    var nums = [];
    var bad = 0;
    for (var i = 1; i < parts.length; i++) {
        if (parts[i] === "") continue;
        var ti = idxOf(TOK, parts[i]);
        if (ti < 0) { bad = 1; break; }
        var idx = 999;
        if (i + 1 < parts.length && /^[0-9]+$/.test(parts[i + 1])) {
            idx = parseInt(parts[i + 1], 10);
            i++;
        }
        nums.push(ti * 1000 + idx);
    }
    if (bad) nums = [];
    for (var k = 0; k < 8; k++) setv("s" + k, k < nums.length ? nums[k] : -1);
}

function restorePath() {
    var parts = ["live_set"];
    for (var k = 0; k < 8; k++) {
        var n = getv("s" + k, -1);
        if (n === null || n < 0) break;
        var ti = Math.floor(n / 1000);
        var idx = n % 1000;
        if (ti < 0 || ti >= TOK.length) return null;
        parts.push(TOK[ti]);
        if (idx !== 999) parts.push(String(idx));
    }
    if (parts.length < 2) return null;
    return parts.join(" ");
}

function ownedByThisDevice(api) {
    try {
        var owner = new LiveAPI(String(api.path).replace(/"/g, "") + " canonical_parent");
        var me = new LiveAPI("this_device");
        return String(owner.id) === String(me.id);
    } catch (e) { return false; }
}

function bindApi(api) {
    if (!api || String(api.id) === "0") return 0;
    target = api;
    calibrate();
    outlet(1, "id", parseInt(String(api.id), 10));
    return 1;
}

function showTargetName() {
    if (!target) { say("tname", "not mapped"); return; }
    var nm = "?";
    try { nm = String(target.get("name")); } catch (e) { }
    var dev = "";
    try {
        var d = new LiveAPI(String(target.path).replace(/"/g, "") + " canonical_parent");
        dev = String(d.get("name"));
    } catch (e) { }
    var tag = (dev ? dev + " " : "") + nm;
    if (tag.length > 34) tag = tag.substring(0, 33) + "\u2026";
    say("tname", tag + (calMode === "manual" ? "  (manual range)" : ""));
}

function selectedId() {
    try { return String(new LiveAPI("live_set view selected_parameter").id); }
    catch (e) { return "0"; }
}

// Arming records whichever parameter is selected right now as the baseline --
// clicking MAP selects the MAP button itself, so without this the very first
// reading is always this device and nothing else ever gets a chance. Anything
// we reject (our own knobs, non-parameters) just moves the baseline on and
// leaves the button armed, the way Ableton's own dontMapToYourself does.
function startMap() {
    mapping = 1;
    baselineId = selectedId();
    armTicks = 0;
    setv("mapbtn", 1);
    say("readout", "click a parameter in Live\u2026");
    if (!pollTask) pollTask = new Task(pollSel, this);
    pollTask.interval = 100;
    pollTask.repeat();
}

function stopMap() {
    mapping = 0;
    if (pollTask) pollTask.cancel();
    setv("mapbtn", 0);
    update();
}

function pollSel() {
    if (!mapping) { if (pollTask) pollTask.cancel(); return; }
    if (++armTicks > 300) { say("readout", "map timed out"); stopMap(); return; }

    var id = selectedId();
    if (id === "0" || id === baselineId) return;

    var api = null;
    try { api = new LiveAPI("id " + id); } catch (e) { return; }
    if (!api) { baselineId = id; return; }

    var ty = "";
    try { ty = String(api.type); } catch (e) { }
    if (ty !== "DeviceParameter" || ownedByThisDevice(api)) { baselineId = id; return; }

    if (bindApi(api)) {
        storePath(api.path);
        autoRange();
        buildAnchors();
        showTargetName();
        stopMap();
    } else {
        baselineId = id;
    }
}

// ------------------------------------------------------------- encoder
// A CC mapped through Live gives 128 absolute steps for the whole range, so
// a detent can never be wider than a slice of those 128. Reading the encoder
// straight off its port instead lets the position accumulate at whatever
// resolution Ticks asks for, which is what actually makes a detent feel long.
//
// Relative encoders disagree on how they encode a tick, so decode by range:
// values around 64 are the 3Fh/41h style (63 = -1, 65 = +1), and values at
// the extremes are the 1/127 style (1 = +1, 127 = -1).
function decodeDelta(v) {
    if (v >= 48 && v <= 80) return v - 64;
    if (v < 48) return v;
    return v - 128;
}

function cc(val, num, ch) {
    if (!ENC) return;
    if (encLearn) {
        encCC = num;
        encCh = ch;
        encLearn = 0;
        setv("enccc", num);
        setv("encch", ch);
        say("readout", "encoder: CC " + num + "  ch " + ch);
        return;
    }
    if (encCC < 0 || num !== encCC || ch !== encCh) return;
    var d = decodeDelta(val);
    if (!d) return;
    var k = KNOB + d / RES;
    if (k < 0) k = 0;
    if (k > 1) k = 1;
    if (k === KNOB) return;
    KNOB = k;
    internalSet = 1;
    setv("knob", KNOB * 100.0);
    internalSet = 0;
    update();
}

function encmode(v) {
    ENC = v;
    if (ENC) {
        encLearn = 1;
        say("readout", "turn the encoder to learn it\u2026");
    } else {
        update();
    }
}

function res(v) {
    RES = v < 32 ? 32 : v;
}

// ------------------------------------------------------- message inputs
function map(v) {
    if (v > 0) startMap(); else stopMap();
}

function clear() {
    target = null;
    calMode = "none";
    outlet(1, "id", 0);
    for (var k = 0; k < 8; k++) setv("s" + k, -1);
    showTargetName();
    update();
}

function knob(v)    { if (internalSet) return; KNOB = v / 100.0; if (KNOB < 0) KNOB = 0; if (KNOB > 1) KNOB = 1; update(); }
function magnet(v)  { MAGNET = Math.max(0, Math.min(1, v / 100.0)); update(); }
function grid(v)    { GRIDIX = v; buildAnchors(); update(); }
function feel(v)    { FEELIX = v; buildAnchors(); update(); }
function scale(v)   { SCALEIX = v; buildAnchors(); update(); }
function minms(v)   { MINMS = v; if (MINMS < 0.1) MINMS = 0.1; buildAnchors(); update(); }
function maxms(v)   { MAXMS = v; buildAnchors(); update(); }
function recal()    { if (target) { calibrate(); autoRange(); buildAnchors(); showTargetName(); update(); } }

// ---------------------------------------------------------------- boot
function onTempo(a) {
    if (!a || a[0] != "tempo") return;
    tempo = parseFloat(a[1]);
    buildAnchors();
    update();
}

function readUI() {
    KNOB    = getv("knob", 0.0) / 100.0;
    MAGNET  = getv("magnet", 85.0) / 100.0;
    GRIDIX  = getv("grid", 1);
    FEELIX  = getv("feel", 0);
    SCALEIX = getv("scale", 1);
    MINMS   = getv("minms", 20.0);
    ENC     = getv("encmode", 0);
    RES     = getv("res", 400);
    if (RES < 32) RES = 32;
    encCC   = getv("enccc", -1);
    encCh   = getv("encch", -1);
    MAXMS   = getv("maxms", 1000.0);
    if (MINMS < 0.1) MINMS = 0.1;
}

function init() {
    if (booted) return;
    booted = 1;
    PAT = this.patcher;
    readUI();

    var song = new LiveAPI("live_set");
    tempo = parseFloat(song.get("tempo"));
    if (isNaN(tempo) || tempo <= 0) tempo = 120.0;
    tempoObs = new LiveAPI(onTempo, "live_set");
    tempoObs.property = "tempo";

    var p = restorePath();
    if (p) {
        try { bindApi(new LiveAPI(p)); } catch (e) { }
    }
    showTargetName();
    buildAnchors();
    update();
}

function bang() { init(); }
function loadbang() { }
