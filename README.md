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
2. Click **MAP**, then click H-Delay's Delay knob in Live. The target name
   appears and the device auto-detects the knob's ms range.
3. MIDI-map the **Time** knob to your Midi Fighter Twister
   (Cmd+M, wiggle the encoder, Cmd+M).

## Controls

| Control    | What it does |
|------------|--------------|
| **Time**   | the knob. This is the one you map to the Twister. |
| **Magnet** | 0% = perfectly linear, same as now. 100% = the value fully parks on each division. ~85% is a good playing feel. |
| **Range**  | min/max in ms. Auto-filled from the plugin when you map. |
| **Curve**  | how the knob spans the range. Exp feels right for delay time. |
| **Grid**   | finest division that gets a magnet (1/4 … 1/32). Coarser ones are always included. |
| **Feel**   | Straight / +triplets / +dotted / all. |
| **MAP**    | arm, then click a parameter. Click again to cancel. |

The readout shows the plugin's own value text plus the division you're sitting
on, with a dot when you're locked to it.

## How the magnet works

Between two neighbouring divisions the travel is re-timed with

    e(t) = t − (s / 2π)·sin(2π t)

Its slope is `1 − s·cos(2π t)`: it drops to `1 − s` right at a division and
rises above 1 in the middle. At s = 1 the slope hits zero, so the value stops
on the division and only moves again once you push past. It's monotonic for
every s in 0…1, so the knob never jumps backwards.

Measured over 128 MIDI steps with 20–1000 ms range at 120 BPM:

| Magnet | steps parked on 1/8 | steps parked on 1/4 |
|--------|--------------------|---------------------|
| 0%     | 1                  | 0                   |
| 85%    | 4                  | 4                   |
| 100%   | 9                  | 6                   |

Tempo is tracked live, so the divisions follow tempo changes.

## Notes

- The mapping survives saving/reloading the set (it's stored in eight hidden
  device parameters, hidden from the automation list).
- Calibration reads the plugin's own value text across its range, so it works
  with non-linear parameters. If it can't read numbers it falls back to
  "manual range" — then set Range by hand to the plugin's real min/max ms.
- While mapped, the device owns that parameter — turning H-Delay's knob by
  hand will get overwritten on the next move.
- To change the logic: edit `magnettime.js` (or `patcher.json`) and run
  `python3 pack.py` to rebuild the device. The .amxd carries its own copy of
  the script, so editing the loose .js alone will not change the device.

## Twister resolution

Absolute CC mode gives 128 steps across the whole range. That's the same
resolution you have now, and the magnet spends more of those steps near the
divisions, which is the point. If you want finer travel between divisions, set
the encoder to a relative mode in Midi Fighter Utility and pick the matching
Relative mode in Live's MIDI mapping browser.

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
