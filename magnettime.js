// magnettime.js  --  brain for the "Magnet Time" Max for Live device
// Max 8 / Live 11  --  ES5 only (no let/const/arrow functions)
//
// Takes a plain 0..100 knob and warps it so that musically meaningful
// values (1/4, 1/8, 1/16 ... at the current Live tempo) behave like soft
// detents: the value gets "heavy" as you approach one, sits on it for a
// while, and you have to keep turning to break out.

autowatch = 1;
inlets = 1;
outlets = 1;

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

var mapping  = 0;
var selObs   = null;
var tempoObs = null;
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

// The detent curve. Between two anchors we re-time the travel with
//     e(t) = t - (s / 2pi) * sin(2pi * t)
// whose slope is 1 - s*cos(2pi*t): it falls to (1 - s) right at an anchor
// and rises above 1 in the middle. At s = 1 the value parks exactly on the
// anchor and you have to keep turning to get moving again. Monotonic for
// every s in [0, 1], so the knob never jumps backwards.
function warp(x) {
    var n = anchorsPos.length;
    if (n < 2) return x;
    var i = 0;
    while (i < n - 2 && x >= anchorsPos[i + 1]) i++;
    var a = anchorsPos[i];
    var b = anchorsPos[i + 1];
    if (b - a <= 1e-9) return x;
    var t = (x - a) / (b - a);
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    var e = t - (MAGNET / (2 * Math.PI)) * Math.sin(2 * Math.PI * t);
    return a + (b - a) * e;
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
    var lo = lutMS[0];
    var hi = lutMS[lutMS.length - 1];
    if (lo < 1.0) lo = 1.0;
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
    var ms = posToMs(wx);

    if (target) {
        var v = msToParam(ms);
        try { target.set("value", v); } catch (e) { }
    }

    var nearest = "";
    var locked = 0;
    for (var i = 1; i < anchorsMs.length - 1; i++) {
        if (Math.abs(ms - anchorsMs[i]) / anchorsMs[i] < 0.006) {
            nearest = anchorsName[i];
            locked = 1;
            break;
        }
    }

    var shown = fmtMs(ms);
    if (calMode === "auto" && target) {
        try {
            var s = String(target.call("str_for_value", msToParam(ms)));
            if (s.length && s.length < 20) shown = s;
        } catch (e) { }
    }
    say("readout", shown + (locked ? ("   " + nearest + "  ●") : (nearest ? ("   " + nearest) : "")));
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

function bindApi(api) {
    if (!api || api.id === 0 || api.id === "0") return 0;
    var ty = "";
    try { ty = String(api.type); } catch (e) { }
    if (ty !== "DeviceParameter") {
        post("Magnet Time: that is not a device parameter (" + ty + ")\n");
        return 0;
    }
    // don't let it grab one of its own knobs
    try {
        var owner = new LiveAPI(String(api.path).replace(/"/g, "") + " canonical_parent");
        var me = new LiveAPI("this_device");
        if (String(owner.id) === String(me.id)) {
            post("Magnet Time: pick a parameter on another device\n");
            return 0;
        }
    } catch (e) { }
    target = api;
    calibrate();
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
    if (tag.length > 34) tag = tag.substring(0, 33) + "…";
    say("tname", tag + (calMode === "manual" ? "  (manual range)" : ""));
}

function startMap() {
    mapping = 1;
    say("readout", "click any parameter in Live…");
    if (!selObs) selObs = new LiveAPI(onSel, "live_set view");
    selObs.property = "selected_parameter";
}

function stopMap() {
    mapping = 0;
    if (selObs) { try { selObs.property = ""; } catch (e) { } }
    setv("mapbtn", 0);
}

function onSel(a) {
    if (!mapping) return;
    if (!a || a[0] != "selected_parameter") return;
    var id = a[a.length - 1];
    if (!id || id == 0) return;
    var api = new LiveAPI("id " + id);
    if (bindApi(api)) {
        storePath(api.path);
        autoRange();
        buildAnchors();
        showTargetName();
        update();
    }
    stopMap();
}

// ------------------------------------------------------- message inputs
function map(v) {
    if (v > 0) startMap(); else stopMap();
}

function clear() {
    target = null;
    calMode = "none";
    for (var k = 0; k < 8; k++) setv("s" + k, -1);
    showTargetName();
    update();
}

function knob(v)    { KNOB = v / 100.0; if (KNOB < 0) KNOB = 0; if (KNOB > 1) KNOB = 1; update(); }
function magnet(v)  { MAGNET = v / 100.0; update(); }
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
