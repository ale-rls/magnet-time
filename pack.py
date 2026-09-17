#!/usr/bin/env python3
"""Pack patcher.json + its dependencies into a Max for Live device.

An .amxd is an xpcoll collective:

    ampf <u32 le 4>  'aaaa'|'mmmm'|'iiii'      device type
    meta <u32 le 4>  <u32 le 7>
    ptch <u32 le N>  <payload>

and the payload is

    'mx@c' <u32 be 16> <u32 be 0> <u32 be dir_offset>
    <file data, packed back to back, first byte at offset 16>
    dlst <u32 be size>
      dire <u32 be size>                        one per embedded file
        type <12> four-char code: JSON / TEXT / 'PNG '
        fnam <8+n> name, NUL-padded to a multiple of 4
        sz32 <12> byte length of the file's data
        of32 <12> offset of that data inside the payload
        vers <12> 0
        flag <12> 17 for the main patcher, 0 for dependencies
        mdat <12> modification date, seconds since 1904-01-01

Max reads that directory to find the patcher and everything it references.
Omit dlst and Max reports "error -1 making directory" and refuses to load.
"""
import json, struct, sys, datetime

DEVICE   = "Magnet Time.amxd"
PATCHER  = "patcher.json"
DEPS     = [("magnettime.js", b"TEXT")]
DEVTYPE  = b"aaaa"          # audio effect ('mmmm' midi effect, 'iiii' instrument)

def mac_time():
    delta = datetime.datetime.now() - datetime.datetime(1904, 1, 1)
    return int(delta.total_seconds()) & 0xFFFFFFFF

def be(cid, body):
    return cid + struct.pack(">I", 8 + len(body)) + body

def u32(cid, v):
    return be(cid, struct.pack(">I", v))

def fnam(name):
    b = name.encode("utf-8") + b"\0"
    b += b"\0" * (-len(b) % 4)
    return be(b"fnam", b)

def entry(name, ftype, size, offset, flag):
    body = (u32(b"type", struct.unpack(">I", ftype)[0])
            + fnam(name)
            + u32(b"sz32", size)
            + u32(b"of32", offset)
            + u32(b"vers", 0)
            + u32(b"flag", flag)
            + u32(b"mdat", mac_time()))
    return be(b"dire", body)

def main():
    patcher = json.dumps(json.load(open(PATCHER)), indent=1).encode("utf-8")

    files = [(DEVICE, b"JSON", patcher, 17)]
    for name, ftype in DEPS:
        files.append((name, ftype, open(name, "rb").read(), 0))

    blob, dirs, off = b"", b"", 16
    for name, ftype, data, flag in files:
        dirs += entry(name, ftype, len(data), off, flag)
        blob += data
        off += len(data)

    payload = (b"mx@c" + struct.pack(">III", 16, 0, off) + blob + be(b"dlst", dirs))
    out = (b"ampf" + struct.pack("<I", 4) + DEVTYPE
           + b"meta" + struct.pack("<I", 4) + struct.pack("<I", 7)
           + b"ptch" + struct.pack("<I", len(payload)) + payload)
    open(DEVICE, "wb").write(out)

    print("%s  %d bytes" % (DEVICE, len(out)))
    for name, _, data, _ in files:
        print("   embedded %-20s %7d bytes" % (name, len(data)))

if __name__ == "__main__":
    main()
