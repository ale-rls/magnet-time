# Magnet Time — stronger maximum hold (v2)

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
| **Magnet** | 0% = no detents. Higher values widen the exact holds around each division. Start at 85%. |
| **Range**  | min/max in ms. On mapping it opens on the musical window (half a 1/32 up to a bit past 1/1), clamped to what the plugin supports — a plugin that runs 0-3500 ms would otherwise squeeze every division into the top third of the knob. |
| **Curve**  | how the knob spans the range. Exp feels right for delay time. |
| **Grid**   | finest division that gets a magnet (1/4 … 1/32). Coarser ones are always included. |
| **Feel**   | Straight / +triplets / +dotted / all. |
| **MAP**    | arm, then click a parameter. Click again to cancel. |
| **ENC**    | Off = the Time knob is driven by Live's MIDI mapping (128 steps). On = the device reads your encoder directly and accumulates, which is what makes the detents long. Switching it On arms a learn: turn the encoder once and it binds to that CC. |
| **Ticks**  | encoder clicks for a full sweep when ENC is On. 400 is the default; higher = heavier detents but a slower sweep. |

The readout shows the requested time and nearest division. The dot appears only
inside an exact hold, rather than merely when the value is close to a division.
The target plugin may have its own rounding or parameter resolution.

## How the magnet works

The value moves continuously between musical divisions. Around each division,
a finite band of knob travel holds the requested time **exactly** at the synced
value. Keep turning through that band to release; reversing direction works too.
Short cosine shoulders ease into and out of the hold, with steady travel between
the shoulders. This replaces the old curve that only approached a division and
concentrated much of the movement into a steep jump between divisions.

Magnet controls the hold width. At 0%, the selected Lin/Exp scale is unchanged.
The feel is unchanged through 85%. Above 85%, hold width rises more strongly.
At 100%, each musical side of an interval reserves 40% for an exact hold
(previously 12%). The remaining travel still connects the divisions continuously;
wider holds mean faster movement between them. Arbitrary range endpoints do not
get extra holds.

At 120 BPM, Range 31–2400 ms, Exp, Grid 1/16 and Ticks 400, starting at the
center of the 1/4 hold takes 26 encoder clicks to release in either direction at
100%, compared with 7 clicks at 85%. These are simulated single-tick relative
encoder messages; hardware acceleration can change the number of physical clicks.

For a 128-position sweep, 31–2400 ms, 120 BPM, grid 1/16 and Magnet 85%, the
exact holds contain 6, 5, 4, 4 and 3 positions at 1/16 through 1/1 respectively.
The largest adjacent time ratio is about 1.051, versus about 1.19 in the old
curve's documented sweep. These are script measurements, not controller testing.

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

Accumulating relative encoder messages lifts it. In Midi Fighter Utility set the encoder
to a **relative** mode (either the 3Fh/41h style or the 1/127 style — the
device detects which), then in the device set **ENC** to On and turn the
encoder once to bind it. Remove the Live MIDI mapping on the Time knob so the
two don't both drive it.

Ticks trades hold length against sweep speed. Start with 400; increase it if you
want to turn farther before leaving a division. Magnet changes the hold width
without changing the number of ticks for a full sweep.

ENC receives MIDI delivered to the device by Live. If it receives no CC messages,
learning cannot complete; use the Time knob's Live MIDI mapping with ENC Off,
or configure an appropriate MIDI route in Live. Direct encoder input must be
verified in the actual Live setup.

## Check this build in Live

1. Load this rebuilt device as a fresh instance and map it to a delay time
   parameter in milliseconds (disable the delay plugin's own tempo-sync mode).
2. At 120 BPM, select Grid 1/16, Feel Str, Curve Exp, Range 31–2400 ms,
   and Magnet 100%. Turn slowly through 125, 250, 500, 1000 and 2000 ms.
3. Each value should hold exactly while you continue turning, then release
   continuously. The dot means the requested time is held; verify the actual
   plugin readout too, because calibration and plugin resolution can differ.
4. Check both directions. Compare 85% against 100%: 100% should require noticeably
   more turning to escape. Set Magnet to 0% to compare free movement.
5. For ENC mode, learn a relative encoder, remove its Live mapping from Time,
   and start at Ticks 400. Verify learning, reversal, and unrelated CC filtering.

`node test.js` checks the curve, exact output holds, release in both directions,
MIDI message assembly and target-ID routing with mocked Max objects. It does not
replace this Live/controller check.

## Repo layout

| File | |
|------|---|
| `Magnet Time.amxd` | the device — self-contained, this is the only file Live needs |
| `magnettime.js`    | the logic, embedded into the .amxd at pack time |
| `patcher.json`     | the Max patcher |
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
