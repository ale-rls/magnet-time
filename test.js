// Run with node test.js. Max/Live integration still needs an in-host check.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const patch = JSON.parse(fs.readFileSync(__dirname + '/patcher.json')).patcher;
const boxes = Object.fromEntries(patch.boxes.map(x => [x.box.id, x.box]));
const state = {}, output = [], text = {};
const c = {
    patcher: {getnamed(name) {return {
        setvalueof(v) {state[name] = v;},
        getvalueof() {return state[name];},
        message(_, v) {text[name] = v;}
    };}},
    outlet(...args) {output.push(args);}
};
vm.createContext(c);
vm.runInContext(fs.readFileSync(__dirname + '/magnettime.js', 'utf8'), c);
function near(a, b, e = 1e-10) {assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);}
function setup(m = .85) {
    Object.assign(c, {MINMS:31, MAXMS:2400, tempo:120, GRIDIX:2,
        FEELIX:0, SCALEIX:1, MAGNET:m});
    c.buildAnchors();
}
let samples = 0;
for (const m of [0,.25,.5,.85,.9,.95,.99,1]) for (const scale of [0,1])
for (const grid of [0,1,2,3]) for (const feel of [0,1,2,3])
for (const tempo of [60,120,240]) {
    setup(m);
    Object.assign(c, {SCALEIX:scale, GRIDIX:grid, FEELIX:feel, tempo});
    c.buildAnchors();
    let prev = -1;
    for (let j = 0; j <= 2000; j++) {
        const x = j / 2000, y = c.warp(x);
        assert.ok(Number.isFinite(y) && y >= 0 && y <= 1);
        assert.ok(y >= prev - 1e-12);
        // Bound movement, catching the old steep jumps between plateaus.
        const speedLimit = m <= .85 ? 1.563 : 6.667;
        if (j) assert.ok(y - prev <= speedLimit / 2000 + 1e-12);
        if (!m) near(y, x);
        prev = y;
        samples++;
    }
    if (!m) continue;
    for (let j = 1; j < c.anchorsPos.length - 1; j++) {
        const a = c.anchorsPos[j], w = c.holdWidth();
        const left = a - w * (a - c.anchorsPos[j-1]);
        const right = a + w * (c.anchorsPos[j+1] - a);
        for (const x of [(left+a)/2, a, (right+a)/2]) {
            near(c.warp(x), a);
            assert.equal(c.HELD, j);
            c.KNOB = x;
            c.update();
            assert.ok(text.readout.includes('●'));
        }
        for (const edge of [left, right]) near(c.warp(edge-1e-9), c.warp(edge+1e-9), 1e-8);
        assert.ok(c.warp(left-1e-5) < a);
        assert.ok(c.warp(right+1e-5) > a);
    }
}

// Exercise the patch's MIDI wiring with Max pack/pak semantics.
let packed = [0,0,0];
function dispatch(id, inlet, msg) {
    const b = boxes[id];
    if (/^pa[ck]+ /.test(b.text)) {
        packed[inlet] = msg;
        if (inlet === 0 || b.text.startsWith('pak ')) emit(id,0,packed.slice());
    } else if (b.text === 'prepend cc') emit(id,0,msg);
    else if (b.text === 'js magnettime.js') c.cc(...msg);
}
function emit(id, outlet, msg) {
    for (const {patchline:p} of patch.lines)
        if (p.source[0] === id && p.source[1] === outlet)
            dispatch(p.destination[0],p.destination[1],msg);
}
function midi(value, cc = 16, channel = 1) {
    emit('obj-320',2,channel); emit('obj-320',1,cc); emit('obj-320',0,value);
}
setup();
Object.assign(c, {ENC:1, encLearn:1, KNOB:.5, RES:400});
midi(65);
assert.equal(c.encCC,16); assert.equal(c.encCh,1); near(c.KNOB,.5);
midi(65); near(c.KNOB,.5025);
midi(63); near(c.KNOB,.5);
midi(65,17); near(c.KNOB,.5);
midi(65,16,2); near(c.KNOB,.5);
midi(1); near(c.KNOB,.5025);
midi(127); near(c.KNOB,.5);

// Exact emitted target value while the raw dial travels through the hold.
setup();
c.calMode = 'auto'; c.lutMS = [31,2400]; c.lutV = [31,2400];
c.target = {};
const ix = c.anchorsName.indexOf('1/4'), pos = c.anchorsPos[ix];
for (const offset of [-.005,0,.005]) {
    c.KNOB = pos + offset; c.update();
    assert.equal(output.at(-1)[1], 500);
}
for (const [value,delta] of [[65,1],[63,-1]]) {
    c.KNOB = pos; let held = 0, released = false;
    for (let j=0;j<40;j++) {
        midi(value);
        const out = output.at(-1)[1];
        if (out === 500) held++;
        else {assert.ok(delta*(out-500)>0); released=true; break;}
    }
    assert.ok(held>1 && released, 'hold must consume clicks then release in either direction');
}
assert.equal(c.outlets,2);
assert.equal(boxes['obj-25'].numoutlets,2);
assert.ok(patch.lines.some(({patchline:p}) => JSON.stringify(p.source)==='["obj-25",1]' && JSON.stringify(p.destination)==='["obj-200",1]'));
c.clear();
assert.ok(output.some(x => x[0]===1 && x[1]==='id' && x[2]===0));

// The user's regression: maximum strength must require substantially more
// turning to escape, without eliminating intermediate timings.
const releaseCounts = [];
for (const strength of [.85,1]) {
    setup(strength);
    const anchor = c.anchorsName.indexOf('1/4');
    const center = c.anchorsPos[anchor];
    const directions = [];
    for (const [value,dir] of [[65,1],[63,-1]]) {
        c.KNOB = center; c.update();
        let clicks = 0;
        do {midi(value); clicks++;} while (c.HELD === anchor && clicks < 100);
        assert.ok(clicks < 100);
        assert.ok(dir * (c.warp(c.KNOB)-center) > 0);
        directions.push(clicks);
    }
    releaseCounts.push(directions);
    for (let i=1;i<c.anchorsPos.length-2;i++) {
        const mid = (c.anchorsPos[i]+c.anchorsPos[i+1])/2;
        const value = c.warp(mid);
        assert.equal(c.HELD,-1);
        assert.ok(value>c.anchorsPos[i] && value<c.anchorsPos[i+1]);
    }
}
assert.ok(releaseCounts[1][0] >= 3 * releaseCounts[0][0]);
assert.ok(releaseCounts[1][1] >= 3 * releaseCounts[0][1]);
console.log('Clicks to leave 1/4 from its center, forward/reverse at Ticks 400:', releaseCounts);
console.log(`Passed ${samples} sweep samples, exact holds/releases, MIDI learn/reversal/filtering, and ID routing.`);
