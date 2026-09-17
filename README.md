# Magnet Time

A one-knob Max for Live audio effect (Live 11 / Max 8). The knob moves freely,
but musical delay times at the current song tempo act like soft detents: the
value gets heavy as you approach 1/8, parks on it, and you have to keep turning
to break out. Then it maps to any parameter in your set — e.g. H-Delay's Delay.

## Install

`Magnet Time.amxd` is self-contained — `magnettime.js` is embedded inside it.
Drop the single file anywhere Live can see it, e.g.

    ~/Music/Ableton/User Library/Presets/Audio Effects/Max Audio Effect/

## Use

1. Drop **Magnet Time** on the track that has H-Delay (before or after it —
   it passes audio straight through and doesn't touch the signal).
2. Click **MAP**, then click H-Delay's Delay knob **in Live's device panel**
   (not inside the Waves plugin window — Live can't see clicks in there).
   The target name appears and the device auto-detects the knob's ms range.
   MAP stays armed until you hit a real parameter, or 30 s pass.
3. MIDI-map the **Time** knob to your Midi Fighter Twister
   (Cmd+M, wiggle the encoder, Cmd+M).

## Controls

| Control    | What it does |
|------------|--------------|
| **Time**   | the knob. This is the one you map to the Twister. |
| **Magnet** | 0% = perfectly linear, same as now. 100% = the value fully parks on each division. ~85% is a good playing feel. |
| **Range**  | min/max in ms. On mapping it opens on the musical window (half a 1/32 up to a bit past 1/1), clamped to what the plugin supports — a plugin that runs 0-3500 ms would otherwise squeeze every division into the top third of the knob. |
| **Curve**  | how the knob spans the range. Exp feels right for delay time. |
| **Grid**   | finest division that gets a magnet (1/4 … 1/32). Coarser ones are always included. |
| **Feel**   | Straight / +triplets / +dotted / all. |
| **MAP**    | arm, then click a parameter. Click again to cancel. |
| **ENC**    | Off = the Time knob is driven by Live's MIDI mapping (128 steps). On = the device reads your encoder directly and accumulates, which is what makes the detents long. Switching it On arms a learn: turn the encoder once and it binds to that CC. |
| **Ticks**  | encoder clicks for a full sweep when ENC is On. 400 is the default; higher = heavier detents but a slower sweep. |

The readout shows the plugin's own value text plus the division you're sitting
on, with a dot when you're locked to it.

## How the magnet works

Between two neighbouring divisions the travel is re-timed by the normalised
integral of `(t(1-t))^p` — flat at both ends, steep in the middle. Near a
division the value barely moves however far you keep turning, then it
releases. Magnet sets `p` (0 = linear, 100% = nearly a hard snap).

Measured on the shipped script, 128 MIDI steps, 31–2400 ms at 120 BPM, grid
1/16 — encoder steps that land on each division:

| Magnet | 1/16 | 1/8 | 1/4 | 1/2 | 1/1 | worst step jump |
|--------|------|-----|-----|-----|-----|-----------------|
| 0%     | 0    | 1   | 1   | 0   | 0   | ×1.03 |
| 50%    | 10   | 7   | 7   | 8   | 6   | ×1.09 |
| 70%    | 17   | 11  | 11  | 12  | 8   | ×1.14 |
| 85%    | 20   | 13  | 13  | 14  | 9   | ×1.19 |
| 100%   | 21   | 15  | 15  | 15  | 9   | ×1.24 |

A knob sweep at 85% (ms):

    31 31 31 32 35 43 58 81 104 119 124 125 125 125 125 125 125 125 125 125
    125 125 127 149 206 245 250 250 250 250 250 250 252 282 384 481 499 500
    500 500 500 500 502 539 713 934 997 1000 1000 1000 1000 1000 1001 1045
    1321 1794 1986 2000 2000 2000 2000 2379 2400

Tempo is tracked live, so the divisions follow tempo changes.

## Notes

- The mapping survives saving/reloading the set (it's stored in eight hidden
  device parameters, hidden from the automation list).
- Calibration reads the plugin's own value text across its range, so it works
  with non-linear parameters. If it can't read numbers it falls back to
  "manual range" — then set Range by hand to the plugin's real min/max ms.
- Writing goes through `live.remote~`, the same route Ableton's own LFO and
  Envelope Follower use, so Live shows the parameter as remote-controlled and
  the moves don't pile up in the undo history. While mapped, the device owns
  that parameter — turning it by hand gets overwritten on the next move.
- To change the logic: edit `magnettime.js` (or `patcher.json`) and run
  `python3 pack.py` to rebuild the device. The .amxd carries its own copy of
  the script, so editing the loose .js alone will not change the device.

## Twister resolution — how to get heavy detents

A CC mapped through Live gives 128 absolute steps for the *whole* range, so a
detent can never be wider than a slice of those 128. That is the ceiling on
how much weight is possible, whatever the curve does.

Reading the encoder directly lifts it. In Midi Fighter Utility set the encoder
to a **relative** mode (either the 3Fh/41h style or the 1/127 style — the
device detects which), then in the device set **ENC** to On and turn the
encoder once to bind it. Remove the Live MIDI mapping on the Time knob so the
two don't both drive it.

Clicks held on each division, magnet 85%, 31–2400 ms at 120 BPM:

| | 1/16 | 1/8 | 1/4 | 1/2 | 1/1 |
|---|------|-----|-----|-----|-----|
| Live MIDI map, 128 steps | 21 | 15 | 15 | 15 | 9 |
| ENC on, Ticks = 400      | 67 | 46 | 46 | 47 | 30 |
| ENC on, Ticks = 1200     | 203 | 140 | 140 | 140 | 90 |

Ticks trades weight against sweep speed. If `ctlin` can't reach your port in
your setup, ENC simply does nothing and the Live mapping keeps working.

## Repo layout

| File | |
|------|---|
| `Magnet Time.amxd` | the device — self-contained, this is the only file Live needs |
| `magnettime.js`    | the logic, embedded into the .amxd at pack time |
| `patcher.json`     | the Max patcher (36 objects, 19 connections) |
| `pack.py`          | rebuilds the .amxd from the two sources |

### On the .amxd format

An .amxd is an **xpcoll collective**, not a plain patcher. After the `ampf` /
`meta` / `ptch` chunks the payload is:

    'mx@c' <be 16> <be 0> <be offset-of-directory>
    <file blobs, packed from offset 16>
    dlst -> dire per file -> type / fnam / sz32 / of32 / vers / flag / mdat

That `dlst` directory is what Max means by "directory". Build an .amxd without
one and Max reports `error -1 making directory` and refuses to load it, which
is exactly what this device did for its first two builds.
