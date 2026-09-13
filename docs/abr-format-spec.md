# Adobe Photoshop Brush (`.abr`) — byte-level format specification

Target audience: an engineer writing a **from-scratch JavaScript parser** (browser/Eagle plugin
context, `DataView` + `Uint8Array`, no external libraries, no Node built-ins).

Scope: ABR major versions **1, 2** (old format) and **6, 7, 9, 10** (new `8BIM` format, minor
versions 1 and 2). Everything here is aimed at *reading*. There is no writing support
(`readAbr` only, no `writeAbr`, in the most complete reference implementation —
[ag-psd `abr.ts`](https://github.com/Agamnentzar/ag-psd/blob/master/src/abr.ts); the Rust port
states the same in its file header
[`ag_psd/abr.rs`](https://docs.rs/ag-psd/latest/src/ag_psd/abr.rs.html)).

**All multi-byte integers and IEEE doubles are big-endian.** Adobe states this for the whole
family of Photoshop files ("All data is stored in big endian byte order", §*Windows*,
[Adobe Photoshop File Formats Specification](https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/)),
and every ABR implementation reads BE (`DataView.getUint16(off, false)` in ag-psd; `QDataStream`
big-endian in Krita; `BigEndian` in the Rust tools).

Notation used below: `u8/u16/u32` = unsigned, `i16/i32` = signed, `f64` = IEEE-754 double,
`bytes(n)` = raw byte run. "Pascal string (pad *p*)" = `u8 length` + `length` bytes + zero bytes
until the total consumed length is a multiple of *p* (counting the length byte itself — this is
ag-psd's rule: `while (++length % padTo) reader.offset++`,
[`psdReader.ts`](https://github.com/Agamnentzar/ag-psd/blob/master/src/psdReader.ts)).

---

## 0. Sources used, and how much to trust each

| Source | What it covers | Trust |
| --- | --- | --- |
| Adobe *Photoshop File Formats Specification* (2019), [link](https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/) | PSD shared structures: big-endian rule, `8BIM` image-resource block, descriptor structure, Unicode string, PackBits/RLE channel data. **Does not document ABR at all.** | authoritative for shared structures |
| [`ag-psd` `abr.ts` / `psdReader.ts` / `descriptor.ts` / `psdWriter.ts`](https://github.com/Agamnentzar/ag-psd) | full v6/7/9/10 reader (minor 1 and 2), pattern reader+writer, descriptor codec | highest — widely used, and its writer round-trips its own reader |
| [`ag-psd` Rust port `abr.rs`](https://docs.rs/ag-psd/latest/src/ag_psd/abr.rs.html) | same, plus extra commentary on Photoshop-2026 quirks | high (derivative) |
| [Krita `kis_abr_brush_collection.cpp`](https://github.com/KDE/krita/blob/master/libs/brush/kis_abr_brush_collection.cpp) | v1/v2 + v6.1/v6.2, RLE | high (descends from GIMP's loader) |
| [GIMP `app/core/gimpbrush-load.c`](https://browse.dgit.debian.org/gimp.git/plain/app/core/gimpbrush-load.c) | authoritative **v1/v2 struct layout**, v6 layout, RLE | highest for v1/v2 (code lineage: `abr2gbr` © 2001 Marco Lamberto) |
| [abrupng](https://github.com/scurest/abrupng) (`src/abr/*.rs`) | v1/v2 and v6/10 image dump | medium — v6 good, **v1/v2 disagrees with GIMP (see §10.1)** |
| [brush-viewer `ABR.ksy`](https://github.com/jlai/brush-viewer/blob/main/shared/abr/ABR.ksy) | Kaitai Struct schema: VMAL, descriptors | medium — useful cross-check, one part is a workaround (§9.1) |
| [0xfeedface "Photoshop Brushes (ABR) Specification" (archived)](https://web.archive.org/web/20140107211414/http://0xfeedface.org/~shawn/graphics/photoshop/abr/abr-spec.htm) | the `desc` block: every key of a `brushPreset`, dynamics groups, blend-mode enums | high for `desc` semantics; explicitly incomplete ("FIXME") |
| [`fileformats.archiveteam.org` Photoshop brush](http://fileformats.archiveteam.org/wiki/Photoshop_brush) | version list, `samp` tables (self-described as *guesswork*) | medium; its v6.2 table is confirmed correct by my own measurements |
| [tonton-pixel, *Photoshop Styles File Format*](https://tonton-pixel.codeberg.page/photoshop-file-formats/styles-file-format.html) | descriptor-based presets, Unicode/Pascal string rules, pattern layout | high for string/padding rules |
| [`@azphalt/importer-abr`](https://www.npmjs.com/package/@azphalt/importer-abr) | naive JS parser | low — see §10.4 |
| [abrdump README](https://git.sr.ht/~fog/abrdump) | version-coverage caveats, links | medium (documentation only) |

**Measurements made during this research** (new, first-hand — cited as "measured"): I downloaded
the real Photoshop file
[`brushes_by_mar_ka_d338ela.abr`](https://github.com/KDE/krita/blob/master/libs/brush/tests/data/brushes_by_mar_ka_d338ela.abr)
(3 676 071 bytes, version 6 subversion 2, **31 sampled brushes, 36 brush presets, 0 patterns**),
parsed every block, every sample item and the whole `desc` descriptor, and verified that
(a) the descriptor parse consumes the `desc` block exactly, and (b) walking the VMAL channel
records reproduces the item boundary exactly. All numbers in §5.3/§5.4/§8 with "measured" come from
that file.

---

## 1. File header

| Offset | Type | Field |
| --- | --- | --- |
| 0 | `u16` | **Major version** (`1`, `2`, `6`, `7`, `9`, `10`) |
| 2 | `u16` | **Minor version / subversion** for 6/7/9/10; **brush count** for 1/2 |
| 4 | — | First brush record (v1/v2) *or* first `'8BIM'` block (v6+) |

The fileformats wiki states the first two bytes are the major version and (for the new format)
"Minor version number is at offset 2"
([wiki](http://fileformats.archiveteam.org/wiki/Photoshop_brush)); every implementation reads
offset 0 and 2 as two `u16`s (`readAbr`: `const version = readInt16(reader); const minorVersion = readInt16(reader);`
— [abr.ts](https://github.com/Agamnentzar/ag-psd/blob/master/src/abr.ts)).

### 1.1 Which versions exist

| Major | Meaning | Minor | Notes |
| --- | --- | --- | --- |
| 1 | oldest documented format | — (field is a **count**) | PS 6 spec lineage; brush *type* per record |
| 2 | like 1 + UCS-2 brush name | — (field is a **count**) | Krita/abrupng/GIMP share one code path for 1 and 2 |
| 6 | first `8BIM` format | **1** and **2** | minor = which `samp` record layout is used |
| 7 | `8BIM` format | 1 / 2 | ag-psd accepts; abrupng does not |
| 9 | `8BIM` format | 1 / 2 | ag-psd accepts; abrupng does not |
| 10 | `8BIM` format | 1 / 2 | ag-psd and abrupng accept |

* `ag-psd` accepts exactly `1|2` and `6|7|9|10` and, in the latter case, requires minor `1|2`
  ("`Unsupported ABR minor version` otherwise").
* `abrupng` accepts `(version == 6 || version == 10) && (subversion == 1 || subversion == 2)`
  ([`mod.rs`](https://github.com/scurest/abrupng/blob/master/src/abr/mod.rs)) — so **7 and 9 exist
  in the wild but are less handled**.
* Krita and GIMP only handle major 6 with subversion 1 or 2; GIMP rejects everything else with the
  error message `abr format version %d` computed as `version * 10 + count` — i.e. GIMP calls these
  versions **6.1 / 6.2** ([gimpbrush-load.c](https://browse.dgit.debian.org/gimp.git/plain/app/core/gimpbrush-load.c)).
* The mapping "major version = Photoshop release number" (6 → PS 6, 7 → PS 7, 9 → PS CS2, 10 → PS
  CS3+) is community convention, **not documented by Adobe**; I could not verify it from a primary
  source. Treat the numbers as opaque discriminators, not as release metadata. Version 8 is not
  observed in any implementation.

### 1.2 How minor versions differ (the only thing that matters)

**The minor version selects the structure of each `samp` item** (§5). It does *not* change the
file header, the `8BIM` block framing, or the `desc` block.

* minor `1` → "v6.1 item": 10 opaque bytes after the brush ID, then rect/depth/compression (§5.2).
* minor `2` → "v6.2 item": a **virtual memory array list (VMAL)** (§5.3, §6).

`ag-psd`, Krita, GIMP and abrupng all branch on the minor version alone (not on the major version);
follow that. 7/9/10 minor 1 behaves like 6.1 and 7/9/10 minor 2 behaves like 6.2.

### 1.3 Header sanity checks

* v1/v2: the "count" (offset 2) is a count of brush records, **not** a subversion. Krita literally
  stores it in a field named `count`, GIMP stores it in a field named `count` and comments
  "in this case, count contains format sub-version" for the v6 case.
* A valid file must have `length >= 4`. Reject `0` outright.
* Some third-party files are little-endian or have a stray 4-byte prefix; do **not** try to
  auto-detect endianness — the format is BE, and every implementation is BE.

---

## 2. Old format — versions 1 and 2

Documented by Adobe in old revisions of the file-format spec (removed from later versions), and
implemented in GIMP (`gimpbrush-load.c`, structs `AbrHeader`/`AbrBrushHeader`/`AbrSampledBrushHeader`),
Krita, `abr2png` and abrupng. The fileformats wiki says the old format "is documented in old
versions of the Photoshop file formats specification" and points at
[*Photoshop File Formats Specification V6.0 Release 2*](http://fileformats.archiveteam.org/wiki/Photoshop_brush)
(the PDF is no longer reachable at the original mirrors; a 2007 forum thread records the same URL
[clearps.com](https://clearps.com/photoshop-discussions/threads/22554-abr-brush-file-specification/)).

### 2.1 File layout

| Offset | Type | Field |
| --- | --- | --- |
| 0 | `u16` | version (`1` or `2`) |
| 2 | `u16` | **brush count** *N* |
| 4 | — | *N* brush records, back to back, no padding |

GIMP's header struct is literally `{ gint16 version; gint16 count; }`.

### 2.2 Brush record

GIMP's structs (`AbrBrushHeader`, `AbrSampledBrushHeader`) give the field order; the offsets below
are relative to the start of the record:

| Offset | Type | Field | Notes |
| --- | --- | --- | --- |
| +0 | `i16` | **type** | `1` = computed brush, `2` = sampled brush |
| +2 | `i32` | **size** | length of the record body in bytes (after this field); GIMP validates `size >= 0` |
| +6 | `i32` | `misc` | uninterpreted |
| +10 | `i16` | **spacing** | brush spacing; GIMP assigns it to the brush's `spacing` |
| +12 | — | *(version 2 only)* brush **name** | `u32` character count, then `count * 2` bytes of **UCS-2BE** (see §2.4) |
| +12 or +12+4+2·n | `i8` | `antialiasing` | boolean-ish |
| +13 or … | `i16 × 4` | `bounds[4]` | top, left, bottom, right (short bounds) |
| +21 or … | `i32 × 4` | `bounds_long[4]` | top, left, bottom, right — **authoritative** |
| +37 or … | `i16` | **depth** | bits per sample; only `8` is usable (`8 >> 3 = 1` byte/pixel) |
| +39 or … | `i8` | **compression** | `0` = raw, `1` = RLE (PackBits) |
| +40 or … | `bytes` | pixel data | `width * height * (depth/8)` bytes, or RLE with per-row `u16` lengths |

where `width = right − left`, `height = bottom − top` from `bounds_long`.

* **Computed brush (`type == 1`)**: has no pixels at all. GIMP/Krita deliberately skip it
  (`g_seekable_seek(..., size, G_SEEK_CUR)` / `"WARNING: computed brush unsupported, skipping."`).
  Useful metadata only: name/spacing (v2).
* **Sampled brush (`type == 2`)**: layout above. The short `bounds[4]` are redundant with
  `bounds_long[4]`; abr2png's `@azphalt`-style readers skip the 8 short bytes and trust the longs.
* **`size` is the resync anchor.** After reading a record (or when the type is unknown), seek to
  `recordStart + 6 + size` — the safest strategy, recommended by the JS parser
  `@azphalt/importer-abr` ("block size is authoritative — resync regardless of what we read"), and
  implied by GIMP's computed-brush skip. Note that GIMP seeks `size` from *after* the 6-byte header
  for computed brushes, i.e. it treats `size` as "bytes after the header".
* GIMP's validation rules (good sanity bounds for a JS parser): `1 ≤ width,height ≤ 10000`,
  `depth/8 == 1`, `compression ∈ {0,1}`; `height > 16384` is flagged "wide brush".

### 2.3 Per record: computed vs sampled, summarised

```
computed (type 1):  i16 type=1, i32 size, then size bytes of opaque data (no image)
sampled  (type 2):  i16 type=2, i32 size, i32 misc, i16 spacing,
                    [v2: u32 nchars + nchars*2 bytes UCS-2BE name]
                    i8 antialias, i16 bounds[4], i32 boundsLong[4],
                    i16 depth, i8 compression, <pixel data>
```

### 2.4 The v2 name string

* Stored as **UCS-2BE** (2 bytes per character). GIMP: `len = 2 * read_long(); read len bytes;
  g_convert(... "UTF-8", "UCS-2BE" ...)`. Krita reads `name_size` `ushort`s and calls
  `QString::fromUtf16`. abrupng skips `2 * len` bytes.
* **Ambiguity:** GIMP's comment says "long : number of characters in string / data : zero
  terminated UCS-2 string", but its code consumes exactly `2 * n` bytes and does **not** skip a
  terminator. The Adobe spec's general *Unicode string* rule (length counts the terminating null)
  suggests the null may be included in `n`. Implementations differ here; a practical reader should
  read `n * 2` bytes, strip a trailing `U+0000`, and — if the next field looks wrong — try
  skipping one extra `u16`. This field only affects a display name, so a wrong guess is harmless.

---

## 3. New format (6, 7, 9, 10) — the `8BIM` block series

From offset 4 the file is a **series of tagged blocks**, the same framing as Photoshop image
resources and additional-layer-info blocks (publicly documented; see *Image Resource Blocks* in the
[Adobe spec](https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/)). The fileformats wiki
describes exactly this ("This signature `8BIM` appears at offset 4; it and the rest of the file
constitute a *series of tagged blocks*") and the known keys are `'samp'`, `'patt'`, `'desc'` (plus
`'phry'`, handled by ag-psd and the Kaitai schema).

### 3.1 Block framing

| Offset (relative to block start) | Type | Field |
| --- | --- | --- |
| +0 | 4 bytes | signature `'8BIM'` (ASCII `38 42 49 4D`) |
| +4 | 4 bytes | block key/type: `'samp'`, `'desc'`, `'patt'`, `'phry'` |
| +8 | `u32` | data length *L* (bytes of data that follow) |
| +12 | `bytes(L)` | block data |
| +12+L | 0–3 bytes | zero padding so the **next block starts 4-byte aligned**: `pad = (4 − (L mod 4)) mod 4` |

Referenced implementations:

* ag-psd reads `checkSignature('8BIM')`, `type = readSignature()`, `size = readUint32()`,
  `end = offset + size`, and after the block does `while (size % 4) { reader.offset++; size++; }`.
* Kaitai: `pad size: -body_len % 4` ([ABR.ksy](https://github.com/jlai/brush-viewer/blob/main/shared/abr/ABR.ksy)).
* Krita's `abr_reach_8BIM_section` seeks `section_size` **without** the padding — a known bug
  (§10.3).

**Measured** on the sample file: `samp@4 len=3631900` (multiple of 4 → no pad), `patt@3631916
len=0`, `desc@3631928 len=44131`; the file ends at `3631940 + 44131 = 3676071`, i.e. the **last
block carries no trailing padding bytes** (the file is odd-length). So: pad *between* blocks, but
do not require padding after the final block, and never read past EOF.

### 3.2 Block keys

| Key | Content | Required? |
| --- | --- | --- |
| `'samp'` | the sampled brush tips (bitmaps) — §5 | optional (a computed-only set may omit it) |
| `'desc'` | one descriptor holding the brush presets — §8 | optional in principle; present in all real v6+ files |
| `'patt'` | sequence of PSD `'Patt'`-format patterns, for texture brushes — §8.6 | optional; **may be present with length 0** (measured) |
| `'phry'` | brush-group hierarchy descriptor — §8.7 | optional |
| anything else | unknown | **skip by length; never abort** |

Block order is not guaranteed. `ag-psd`'s switch throws `Invalid brush type` on anything unknown,
which makes it fragile against files that add keys; the Kaitai schema falls back to "read `body_len`
bytes". Prefer the tolerant behaviour.

### 3.3 Padding rules that apply *inside* blocks

* **Pascal string, pad 1** (no padding): `u8 length` + `length` bytes. Used for the `samp` item IDs
  and for pattern IDs. ag-psd: `readPascalString(reader, 1)`.
* **Unicode string**: `u32 charCount` + `charCount * 2` bytes UTF-16BE. Photoshop writes
  `charCount = name.length + 1` and appends a `U+0000` (see `writeUnicodeStringWithPadding` in
  [psdWriter.ts](https://github.com/Agamnentzar/ag-psd/blob/master/src/psdWriter.ts)); the reader
  must therefore **strip one trailing null** ([psdReader.ts](https://github.com/Agamnentzar/ag-psd/blob/master/src/psdReader.ts),
  and tonton-pixel: "Two bytes per character; **includes terminating null**").
  **Measured:** the top-level descriptor's class name in the sample file is `u32 1` followed by
  `00 00` → an empty name encoded with the terminator. Note there is **no extra padding** for
  Unicode strings in ag-psd's reader, and adding one would break the parse.
* **Integer-length-delimited sub-blocks** (`samp` items, patterns) are padded to 4 bytes by rounding
  the *length value up*, not by aligning the file offset: `len4 = len + ((4 − len % 4) % 4)`, then
  `next = startOfPayload + len4`. Since block/item starts are already 4-aligned this is equivalent
  to offset alignment, but it is what makes the arithmetic in §5.4 exact.

---

## 4. Old vs new format at a glance

```
u16 majorVersion  u16 minorOrCount
├─ 1 | 2        → old format: minorOrCount = N records, each [i16 type][i32 size][body]
└─ 6|7|9|10     → new format: minorOrCount = subversion (1 or 2)
                  then: '8BIM' + key + u32 len + body + pad-to-4, repeated to EOF
                  keys: 'samp' (bitmaps) | 'desc' (presets) | 'patt' (patterns) | 'phry' (groups)
```

Decision table for the implementer:

| Question | v1/v2 | v6+ minor 1 | v6+ minor 2 |
| --- | --- | --- | --- |
| Where are the tips? | brush records at offset 4 | `samp` block items | `samp` block items |
| Tip ID / name | v2: UCS-2 name inside the record | Pascal string in the item | Pascal string in the item |
| Rect position in the item | after misc/spacing/name/antialias/short bounds | fixed +10 from the body start | inside the VMAL channel record |
| Rect integer type | `i32` (long bounds) | `i32` | `u32` |
| Padding | none | item padding to 4 | item padding to 4 |
| Brush metadata (angles, dynamics, textures) | spacing only (v2); otherwise absent | `desc` block | `desc` block |
| Requires a descriptor parser? | no | yes (for anything but pixels) | yes |

All three shapes share the same pixel representation: a single 8-bit coverage channel, raw or
PackBits-RLE, rows top-to-bottom, left-to-right.

---

## 5. The `'samp'` block

Contains a sequence of **items**, one image tip per item, packed until the block's data end:

```
sampDataStart = blockDataOffset
sampDataEnd   = blockDataOffset + blockLength
while (offset < sampDataEnd) { read item }
```

Do **not** trust the items to add up without padding: each item is padded as in §3.3.

### 5.1 Common item prefix

| Offset (relative to item payload start, i.e. just after the `u32` length) | Type | Field |
| --- | --- | --- |
| +0 | `u8` | Pascal string length *n* |
| +1 | `bytes(n)` | **brush ID** — an ASCII UUID, e.g. `2205283b-e0f2-11df-ac64-ac9512eb12e7` (measured: `n = 36`) |
| +1+n | — | subversion-dependent body (§5.2 / §5.3) |

The `u32` length field that precedes this is **the number of bytes after itself** (it excludes the
4 length bytes and excludes padding). Verified in the sample file: item #0's length is `185004`,
the next item's length field starts exactly `4 + 185004 = 185008` bytes later.

The ID is the **join key** to the `desc` block: `brushPreset.Brsh.sampledData` holds the same UUID
as a `TEXT` value (§8.3). All 31 IDs in the sample file are 36-character UUID strings, and all
match a `sampledData` value.

> **Do not hard-code the ID length.** GIMP, Krita, abr2png and abrupng all skip a *fixed* 37 bytes
> (1 length byte + 36 chars); ag-psd reads the Pascal string properly. Read the Pascal string and
> keep the length, otherwise a file with a non-UUID ID (or a shorter one) will desynchronise.

### 5.2 Subversion 1 ("v6.1 item")

After the ID, the body is:

| Offset (from body start = after the ID) | Type | Field |
| --- | --- | --- |
| +0 | `bytes(8)` | **unknown** — opaque in every implementation |
| +8 | `u16` | depth (a pixel-depth field; `8` or `16`) |
| +10 | `i32 × 4` | rectangle: top, left, bottom, right (**signed**) |
| +26 | `u16` | depth again (the "real" depth used for decoding) |
| +28 | `u8` | compression: `0` raw, `1` RLE |
| +29 | `bytes` | pixel data |

This is the table on the [fileformats wiki](http://fileformats.archiveteam.org/wiki/Photoshop_brush)
("8 bytes unknown / uint16 Depth / 4×int32 Rectangle / uint16 Depth / byte Compression mode /
image data / 0–3 padding"), and it is exactly what the implementations do:

* GIMP/Krita/abr2png/abrupng all seek **47 bytes from the item payload start** = 37 (fixed UUID
  Pascal string) **+ 10** (the 8 unknown bytes + the first `u16` depth), then read
  `top/left/bottom/right` as `i32`, `depth` as `u16`, `compression` as `u8`.
  GIMP's comment: *"discard key and short coordinates and unknown short"*; Krita's:
  *"discard short coordinates and unknown short"*.
* `ag-psd`: `readPascalString(reader, 1)` then `skipBytes(reader, minorVersion === 1 ? 10 : 264)`,
  then the same rect/depth/compression.

**Uncertainty:** the 8 unknown bytes have never been explained. Given §5.3 they are plausibly the
first 8 bytes of a VMAL-like header (`u16 meta` + `u16 meta` + `u32 version`) with the bounds/count
fields omitted, but no source states this and no sample was available to test. Treat them as
opaque.

### 5.3 Subversion 2 ("v6.2 item") — VMAL, fully verified

The body is a **virtual memory array list** preceded by 4 meta bytes:

| Offset (from body start = after the ID) | Type | Field | Measured value (item #0) |
| --- | --- | --- | --- |
| +0 | `u16` | meta #1 | `1` |
| +2 | `u16` | meta #2 | `0` |
| +4 | `u32` | VMAL **version** | `3` |
| +8 | `u32` | VMAL **length** | `184955` |
| +12 | `u32 × 4` | VMAL **bounds**: top, left, bottom, right | `148, 255, 849, 822` |
| +28 | `u32` | **channel count** *C* | `56` |
| +32 | *C*+2 × channel record | channel records (below) | 58 records, only #55 written |

The fileformats wiki's v6.2 table (2 bytes `00 01`, 2 bytes `00 00`, "virtual memory array list")
matches the first four bytes exactly — its "guess" is correct
([wiki](http://fileformats.archiveteam.org/wiki/Photoshop_brush)).

**VMAL length semantics** (verified): `length` counts the bytes **from after the length field to the
end of the item payload**. Checked on all 31 items: `length == itemLength − 49`
(= −37 ID −4 meta −4 version −4 length), and `bodyStart + 12 + length == itemPayloadEnd` exactly,
with zero leftover. The same convention is used by ag-psd's pattern writer
(`writeUint32(vlOffset − 4, writer.offset − vlOffset)`).

**Channel records** — `C + 2` of them (the "+2" is not a typo; ag-psd's pattern reader loops
`for (i = 0; i < channelsCount + 2; i++)`, and the measurement below confirms it for `samp` too):

| Type | Field | Notes |
| --- | --- | --- |
| `u32` | `has` / is-written flag | **if `0`, the record is exactly 4 bytes and ends here** |
| `u32` | channel length *Lch* | present only if `has != 0`; equals `23 + dataLength` |
| `u32` | pixel depth | `8` or `16` |
| `u32 × 4` | top, left, bottom, right | unsigned here (unlike the v6.1 `i32` rect) |
| `u16` | pixel depth (again) | `8` or `16` |
| `u8` | compression | `0` raw, `1` RLE |
| `bytes(Lch − 23)` | channel data | `23 = 4 + 16 + 2 + 1` (depth + rect + depth + compression) |

Verified on all 31 sample items: `has = 1` for exactly one record, at **index 55 (0-based)**;
`pixelDepth = 8`, `pixelDepth2 = 8`, `compression = 1` (RLE); and
`walkConsumed == 12 + vmalLength == itemLength` with **0 leftover bytes**, which also proves that
`C + 2 = 58` records is right and that the last two records are unwritten (`has = 0`).

### 5.4 Why the "skip 264 bytes" shortcut works — and when it breaks

`ag-psd`, Krita and abrupng all hard-code, for subversion 2, a skip of **301 bytes from the item
payload start** (= 37-byte fixed ID + **264**) and then read the `i32` rect, `u16` depth, `u8`
compression (this is the v6.1-style tail, and indeed the values found there are the real image
rect/depth/compression).

**Derivation of 264** (measured): the first written channel record sits at index 55, so

```
32 (meta+version+length+bounds+count)
+ 55 × 4   (records 0..54, all has=0)          = 220
+ 12       (has + length + pixelDepth of #55) =  12
= 264
```

i.e. the shortcut is a **hard-coded consequence of `channelCount == 56` with the written record at
index 55** — true for every item in my sample, and (by construction) for the files ag-psd/abrupng
were tested against. It is *not* a documented invariant:

* ag-psd's pattern code writes `channelsCount = 24` and puts the alpha at record index 25, so the
  written index is demonstrably **not** always 55.
* Therefore a parser that hard-codes 264 will silently mis-read any file where the channel count or
  the written index differs.

**Recommendation:** walk the VMAL records (§5.3) to find the written record; use the fixed
`10`/`264` offsets only as a *fallback* when the walk fails, and validate the rect afterwards
(§10.5). Both approaches agree on the sample file, so a correct implementation can cross-check them
and report a warning if they disagree.

### 5.5 The depth fields

There are always **two** depth fields per item (one before/around the rect, one after it, name them
`pixelDepth` and `pixelDepth2` in the VMAL; the wiki calls the v6.1 one "Depth" twice). Observed
values are `8`/`8`. ag-psd accepts `8` and `16` and rejects anything else (`Invalid depth`), and
treats `depth` non-8 as 2 bytes per sample.

* 8-bit: 1 byte per pixel.
* 16-bit: 2 bytes per pixel, **big-endian**; ag-psd converts to 8-bit with `readUint16() >> 8`.
* 16-bit RLE is **not implemented anywhere** (`throw new Error('not implemented (16bit RLE)')`), so a
  16-bit RLE tip cannot be decoded by any public implementation; fall back to metadata-only.

### 5.6 The compression byte

| Value | Meaning |
| --- | --- |
| 0 | raw, uncompressed |
| 1 | RLE (PackBits), **8-bit only in practice** |
| other | invalid — reject the item, keep going |

---

## 6. Virtual memory array list (VMAL)

The VMAL is a PSD-family structure; in ABR it appears (a) inside every subversion-2 `samp` item and
(b) inside every `'patt'` pattern record. The name comes from the implementations themselves
(ag-psd's comment `// virtual memory array list`); Adobe's PSD specification documents the same
rect/depth/compression channel framing for image data but does not name this list, so the layout
below is reconstructed from implementation code plus my measurements — and those agree exactly.

```
VMAL:
  u32 version          // = 3 in every observed case (samp and patt)
  u32 length           // bytes after this field, up to the end of the enclosing structure
  u32 top, left, bottom, right   // bounds of the whole list
  u32 channelCount C
  Channel[C + 2] channels
Channel:
  u32 has              // 0 => unwritten, record is exactly 4 bytes
  if has != 0:
    u32 length         // = 23 + dataLength
    u32 pixelDepth
    u32 top, left, bottom, right
    u16 pixelDepth2
    u8  compression
    bytes(length - 23) data
```

Corroboration:

* `ag-psd` `readPattern` reads, after the pattern name and ID: `version2 = u32` (must be `3`),
  `u32` (unused), `u32 × 4` bounds, `u32 channelsCount`, then loops `channelsCount + 2` times
  reading `has`, `length`, `pixelDepth`, `top/left/bottom/right`, `pixelDepth2`, `compression`, and
  `dataLength = length − (4 + 16 + 2 + 1)`.
* `ag-psd` `writePattern` writes exactly that, with `length = data.length + 4 + 16 + 2 + 1` — so the
  `23` constant is confirmed from both directions.
* Kaitai's `v62`/`channel` types describe the same shape (with `is_written`, `length`,
  `unused_depth`, then `image_data{top,left,bottom,right,depth,compression,bitmap}`)
  ([ABR.ksy](https://github.com/jlai/brush-viewer/blob/main/shared/abr/ABR.ksy)).

Gotchas:

* Only channels with `has != 0` **and** `length > 0` carry an image; the `pixelDepth`/rect/depth2/
  compression fields are only present for those.
* The number of records is `channelCount + 2`, not `channelCount`. If you use the Kaitai schema as
  written (only `channelCount` records) you will not consume the two trailing records; that is
  harmless only because they are 4-byte zero records and the enclosing item length is authoritative.
* `length` of an unwritten record does not exist — never read it unconditionally.

---

## 7. Decoding the embedded channel data

The channel that matters for a brush tip is the one that is written (in the sample file: index 55).
It is a **single 8-bit coverage/alpha channel**, even though the VMAL advertises 56 channels. The
other channels are unwritten stubs.

### 7.1 Raw (compression = 0)

* 8-bit: exactly `width * height` bytes, **row-major, top row first, left-to-right**, one byte per
  pixel. Origin is the VMAL (or record) rect; you can crop against the VMAL bounds if they differ
  (in the sample they are identical).
* 16-bit: `width * height * 2` bytes, big-endian per sample; convert with `>> 8` (ag-psd) or
  `>> 8` after `getUint16(off, false)`.
* Do not assume the raw length from the rect alone: Photoshop pads/uses the record length. ag-psd
  *does* compute `alpha.byteLength` from the rect for raw data, and logs
  `Invalid length (…)` in PSD when it disagrees — for ABR it just reads `w*h` bytes. Read `w*h`
  (8-bit) and then resume at the record boundary, not at the read cursor.

### 7.2 RLE (compression = 1) — PackBits with `u16` row lengths

Layout: **all row byte-counts first**, then the packed row data, in row order.

```
u16 rowLength[0..height-1]     // big-endian, one per row, read before any packed byte
bytes rowLength[0]             // packed row 0
bytes rowLength[1]             // packed row 1
...
```

Decoding one packed row (PackBits; GIMP/Krita/abr2png/ag-psd all implement exactly this):

```
i = 0; x = 0
while (i < rowLength && x < width) {
    h = data[i++]            // as signed byte
    if (h > 128)  { n = 256 - h; value = data[i++]; write value n times }   // h in [129..255]
    else if (h < 128) { n = h + 1; copy next n bytes literally }
    else { /* h == 128: NOP, skip */ }
}
```

Equivalently: `h ∈ [0..127]` → copy `h+1` literal bytes; `h ∈ [-127..-1]` (i.e. unsigned
`129..255`) → repeat the next byte `1 − h` = `256 − h` times; `h == -128`/`128` → no-op.

Notes and traps:

* Row lengths are **`u16` (2 bytes)**, *not* `u32`. (PSD/PSB uses 4-byte row lengths for large
  documents — irrelevant for ABR; ag-psd's `readDataRLE(..., large)` is called with `large = false`
  from the ABR path.)
* Krita/GIMP/abr2png drive the loop by the **compressed** row length (`for j < cscanline_len[i]`),
  ag-psd by the **output** width (`x < width`) with a guard — use both: stop at either bound.
* Decoded output is exactly `width` bytes per row; total `width * height`.
* The rect can be bigger than the VMAL bounds or vice versa; row lengths always refer to the
  channel's own rect width.
* Guard the output buffer: a malformed file can overflow `width * height` (GIMP explicitly checks
  `data >= buffer + buffer_size` and reports "RLE compressed brush data corrupt").

### 7.3 Useful sanity limits

* `width, height ≥ 1`, and `≤ 30000` (Adobe's document limit) — GIMP uses 10000 for ABR brushes.
* `width * height ≤ ~64 000 000` (the `@azphalt` parser uses this as "implausible bounds").
* `pixelDepth ∈ {8,16}`; `compression ∈ {0,1}`.
* The declared item/block length must fit inside the file; else the file is truncated.

---

## 8. Version 7+ semantics: how a brush set is split into presets and tips

The `'samp'` block holds only **bitmaps** (plus a UUID). Everything a user calls a "brush" —
name, diameter, spacing, angle, roundness, hardness, dynamics, texture, dual brush, tool options —
lives in the `'desc'` block as one **descriptor**. The link is the UUID:

```
desc.Brsh[i]                          // a brushPreset descriptor
  .'Brsh'                             // a brush-shape descriptor
     .sampledData  (TEXT, UUID)  ─────────────►  samp item's Pascal-string ID
```

So: **computed brushes** (`classId = "computedBrush"`) have *no* pixels and no `sampledData`;
**sampled brushes** (`classId = "sampledBrush"`) reference a `samp` item. Photoshop 7+ also has
`dBrush` (dynamic/bristle) and `dTips` (erodible-tip) shapes, which are parametric and likewise
have no bitmap (ag-psd; the Kaitai schema and the 0xfeedface spec predate them).

Measured in the sample file: 36 `brushPreset` entries in `desc`, 31 `samp` items, every
`sampledBrush` referenced an existing ID (multiple presets can reference the same tip — e.g. items
`21baa335…`/`21baa334…` are referenced by presets "20"/"21"/"35"/"36"; also IDs appear with
`sampledData` values that share a prefix, which are *different* tips).

### 8.1 The `'desc'` block, byte-exact

**Measured (first 64 bytes of the block, and the whole block parsed to its last byte):**

```
00 00 00 10 | 00 00 00 01 00 00 | 00 00 00 00 | 6E 75 6C 6C | 00 00 00 01 | 00 00 00 00 | 42 72 73 68 | 56 6C 4C 73 | 00 00 00 24 | 4F 62 6A 63 | 00 00 00 01 00 00 | 00 00 00 00 | 62 72 75 73 68 50 72 65 73 65 74 | ...
  version=16 | nameLen=1, "\0"    | classID len=0 | "null"      | itemCount=1  | key len=0     | "Brsh"       | "VlLs"       | list count=36 | elem type "Objc" | elem name len=1 "\0" | elem classID len=0 | "brushPreset" ...
```

So the block body is **`u32 version` (== 16) followed immediately by a descriptor**:

```
desc block:
  u32 version            // 16
  Descriptor             // §9
```

* ag-psd: `readVersionAndDescriptor(reader, true)` → `version !== 16 → throw`, then
  `readDescriptorStructure(reader, includeClass = true)`.
* The Kaitai schema's `descriptors_section_body` "unknown: size 18" is exactly those first 18 bytes
  (4 version + 4 name-length + 2 name-null + 4 classID-length + 4 `"null"`) — i.e. *not* an unknown
  region but a hard-coded skip of the outer class structure. Do not copy that skip; parse the
  descriptor properly.
* The outer descriptor's class is `"null"` and its name is empty (measured).

### 8.2 `brushPreset` — the fields, in observed file order

Measured order and types from the sample file (22–27 keys per preset; optional keys appear only when
the corresponding `use*` flag is true):

| Order | Key | OSType | Meaning |
| --- | --- | --- | --- |
| 1 | `'Nm  '` | TEXT | preset name (here often just `"18"`, `"19"`, …) |
| 2 | `'Brsh'` | Objc | the brush **shape** descriptor (§8.3) |
| 3 | `useTipDynamics` | bool | shape dynamics enabled |
| 4 | `flipX` | bool | (shape-dynamics flip) |
| 5 | `flipY` | bool | |
| 6 | `minimumDiameter` | UntF `#Prc` | 0–100 % |
| 7 | `minimumRoundness` | UntF `#Prc` | |
| 8 | `tiltScale` | UntF `#Prc` | 0–200 % |
| 9 | `szVr` | Objc `brVr` | size dynamics |
| 10 | `angleDynamics` | Objc `brVr` | |
| 11 | `roundnessDynamics` | Objc `brVr` | |
| 12 | `useScatter` | bool | |
| — | `'Spcn'` | UntF `#Prc` | spacing (also present here when scatter is on; see §10.7) |
| 13 | `'Cnt '` | doub | scatter count 1–16 (a `double`, not a long!) |
| 14 | `bothAxes` | bool | |
| 15 | `countDynamics` | Objc `brVr` | |
| 16 | `scatterDynamics` | Objc `brVr` | |
| 17 | `dualBrush` | Objc `dualBrush` | `{ useDualBrush: bool, … }` |
| 18 | `brushGroup` | Objc `brushGroup` | `{ useBrushGroup: bool }` |
| 19 | `useTexture` | bool | when true, also: `TxtC` (bool), `interpretation`, `textureBlendMode` (enum), `textureDepth`, `minimumDepth`, `textureDepthDynamics`, `Txtr` (Objc `Ptrn` = `{'Nm  ' TEXT, Idnt TEXT}`), `textureScale`, `InvT`, `protectTexture`, `textureBrightness`, `textureContrast` |
| 20 | `usePaintDynamics` | bool | flow/opacity/wetness/mix dynamics: `prVr`, `opVr` (+ `wtVr`, `mxVr` for mixer brushes) |
| — | `useColorDynamics` | bool | then `clVr`, `'H   '`, `Strt`, `Brgh`, `purity`, `colorDynamicsPerTip` |
| 21 | `Wtdg` | bool | wet edges |
| 22 | `Nose` | bool | noise |
| 23 | `'Rpt '` | bool | airbrush/"repeat" (0xfeedface: *"Airbrush – Is just a checkbox"*) |
| — | `useBrushSize`, `useBrushPose`, `overridePose*`, `brushPose*`, `toolOptions` (Objc, classId `_`/`MixB`/`SmTl`) | | newer Photoshop versions |

Also present in the 0xfeedface spec and ag-psd: `Intr` (a bool the 0xfeedface author could not
identify — ag-psd treats it as *spacing enabled*; GIMP's v6 comment for spacing says "real value
needs 8BIMdesc section parser"). Treat `Spcn` as spacing in **percent** (`value / 100`) and `Intr`
as the spacing on/off flag.

`brVr` (dynamics) group — 3 items, measured order:

| Key | OSType | Meaning |
| --- | --- | --- |
| `bVTy` | long | control index (see table) |
| `fStp` | long | fade steps |
| `jitter` | UntF `#Prc` | jitter 0–100 % |
| (`'Mnm '` | UntF `#Prc` | minimum, emitted by newer versions) |

`bVTy` control table (0xfeedface; the size/angle lists differ in length — ag-psd's table has 9
entries: `off, fade, pen pressure, pen tilt, stylus wheel, initial direction, direction, initial
rotation, rotation`):

| Value | Control |
| --- | --- |
| 0 | Off |
| 1 | Fade |
| 2 | Pen Pressure |
| 3 | Pen Tilt |
| 4 | Stylus Wheel |
| 5 | (Rotation / Initial Direction — sources differ) |
| 6 | Initial Direction |
| 7 | Direction |
| 8 | Rotation (ag-psd only) |

### 8.3 Brush-shape descriptors

`computedBrush` — measured order (8 items; matches the 0xfeedface listing exactly):

| Key | OSType | Meaning | Range |
| --- | --- | --- | --- |
| `Dmtr` | UntF `#Pxl` | diameter | 1–2500 px |
| `Hrdn` | UntF `#Prc` | hardness | 0–100 % |
| `Angl` | UntF `#Ang` | angle | −180…180° |
| `Rndn` | UntF `#Prc` | roundness | 0–100 % |
| `Spcn` | UntF `#Prc` | spacing | 0–1000 % (log slider) |
| `Intr` | bool | *(not identified by 0xfeedface)* / spacing flag | |
| `flipX` | bool | | |
| `flipY` | bool | | |

`sampledBrush` — measured order (9 items = the same 8 **minus `Hrdn`**, **plus** `'Nm  '` and
`sampledData`):
`Dmtr, Angl, Rndn, 'Nm  ', Spcn, Intr, flipX, flipY, sampledData`.
The 0xfeedface spec says the same: *"The difference between them regarding entries is just one last
extra entry in this sequence … sampledData"* (it prints `sampledData (TEXT 37)`).

* `sampledData` = the UUID that joins to a `samp` item (§5.1). Measured example:
  preset "20" → `sampledData = "22052839-e0f2-11df-ac64-ac9512eb12e7"`.
* `'Nm  '` here is the tip's internal name (`"Sampled Brush 2"`, `"texture 4"`), not the preset name.
* A **computed brush has no pixels**; do not look for it in `samp`.

`dBrush` (dynamic/bristle) and `dTips` (erodible tip) — from ag-psd, needed for Photoshop CC+
files. `dBrush`: `'Shp '` (long, index into
`round point, round blunt, round curve, round angle, round fan, flat point, flat blunt, flat curve,
flat angle, flat fan`), `Angl`, `Dmtr`, `Dnst` (density), `Lngt` (length), `clumping`, `thickness`,
`stiffness`, `physics`, `Spcn`, `Intr`, `flipX`, `flipY`.
`dTips`: `Angl`, `Dmtr`, `dtipsType` (index into `erodible point, erodible flat, erodible round,
erodible square, erodible triangle, custom`), `'Shp '`, `dtipsLengthRatio`, `dtipsHardness`,
`dtipsGridSize` (long), `dtipsErodibleTipHeightMap` (**`tdta`** raw bytes), `physics`,
`dtipsAirbrushCutoffAngle`, `dtipsAirbrushGranularity`, `dtipsAirbrushStreakiness`,
`dtipsAirbrushSplatSize`, `dtipsAirbrushSplatCount`, then `Spcn`, `Intr`, `flipX`, `flipY`.
The `dtipsErodibleTipHeightMap` is present only when `dtipsGridSize != 0` (ag-psd gates on both).

Value conversions (ag-psd, `descriptor.ts` / `abr.ts`):

| Helper | Rule |
| --- | --- |
| `parsePercent(v)` | `v.units === 'Percent' ? v.value / 100 : 1` (undefined → 1) |
| `parseAngle(v)` | `v.units === 'Angle' ? v.value : 0` (undefined → 0) |
| `parseUnitsToNumber(v, 'Pixels')` | requires `units === 'Pixels'`, returns `v.value` (undefined → throw in the Rust port) |
| `enum` values | decoded as `"BlnM.Nrml"`, `"GrdF.CstS"`, … — the type key and value key, dot-joined |

Blend modes used by brushes (`BlnM` enum, `textureBlendMode` / dual-brush `BlnM`): `Nrml, Dslv,
Drkn, Mltp, CBrn, linearBurn, darkerColor, Lghn, Scrn, CDdg, linearDodge, lighterColor, Ovrl, SftL,
HrdL, vividLight, linearLight, pinLight, hardMix, Dfrn, Xclu, blendSubtraction, blendDivide, H(/Hue),
Strt, Clr, Lmns, linearHeight, Hght, Sbtr`.
Note (from the Rust port): Photoshop 2026 writes long-form ids (`BlnM.normal`, `BlnM.colorBurn`)
instead of the historical 4-char codes, and `'Md  '` can be **missing** from `toolOptions`
(ag-psd defaults it to `BlnM.Nrml`). Compare codes case-insensitively and fall back gracefully.

### 8.4 Mapping presets to tips: the full recipe

For each `brushPreset` in `desc.Brsh[]`:

1. `presetName = preset['Nm  ']`
2. `shape = preset.Brsh`; switch on its **classId** (`computedBrush` / `sampledBrush` / `dBrush` /
   `dTips`) — the classId is available only if you parsed the class structure (ag-psd's
   `includeClass = true`), so **keep it**.
3. If `sampledBrush`: `tipId = shape.sampledData`; look up the `samp` item with the same ID. If
   missing → emit metadata-only brush with a warning (a real, easily-hit case: brushes created by
   third-party tools sometimes keep `sampledData` but drop the tip, or a preset may be a
   `computedBrush` while an unrelated tip exists).
4. Everything else (spacing, angle, roundness, hardness, dynamics, texture, tool options) comes from
   the preset descriptor; `shape.Dmtr` is the nominal diameter (**not** necessarily the bitmap's
   pixel size — in the sample, presets quote diameters 8…548 px while the tips are 567×701 etc.).
   Scale the tip bitmap to `Dmtr` if you render.
5. `flipX`/`flipY` exist both on the shape and on the preset (shape dynamics) — they are different
   settings; apply the shape-level ones to the tip and the preset-level ones only with tip dynamics.

### 8.5 Computed-only files

A file may contain `desc` with only `computedBrush` presets and **no `samp` block at all** (that is
what "no pixels" means). Handle `samp` being absent, zero-length, or containing zero items without
throwing.

### 8.6 `'patt'` — patterns for texture brushes

The block is a **sequence of patterns in the PSD `'Patt'` format**, repeated until the block's data
end (`while (reader.offset < end) patterns.push(readPattern(reader))` in ag-psd; the Kaitai schema
does not model it). It can legitimately be **present with length 0** (measured).

Pattern layout (ag-psd `readPattern`, confirmed structurally by `writePattern` and by
tonton-pixel's independent description of the styles-file pattern record —
[link](https://tonton-pixel.codeberg.page/photoshop-file-formats/styles-file-format.html)):

| Type | Field |
| --- | --- |
| `u32` | length of the rest of this pattern record; **round the value up to a multiple of 4**, and the next pattern starts there |
| `u32` | pattern version — must be `1` |
| `u32` | colour mode (`0` bitmap, `1` grayscale, `2` indexed, `3` RGB, `4` CMYK, …) |
| `i16` | x (origin) |
| `i16` | y (origin) |
| Unicode string | pattern name |
| Pascal string (pad 1) | pattern ID — a UUID (1 + 36 bytes) |
| if indexed: `768` bytes palette + `u32` unknown | |
| VMAL | `u32 version` (**3**), `u32 length`, `u32 × 4` bounds, `u32 channelsCount` (**24** in Photoshop's own files), then `channelsCount + 2` channel records exactly as §6 |

The pattern's `Idnt` is what a texture-brush preset references:
`preset.Txtr = { 'Nm  ': patternName, Idnt: patternUUID }` and texture parameters live alongside it
(`TxtC` = texture-each-tip, `textureBlendMode`, `textureDepth`, `minimumDepth`,
`textureDepthDynamics`, `textureScale`, `InvT`, `textureBrightness`, `textureContrast`,
`protectTexture`) — 0xfeedface documents all of these. ag-psd supports RGB, grayscale and indexed
patterns and throws for 16-bit pattern channels, so a parser can skip patterns it cannot decode.

### 8.7 `'phry'` — brush hierarchy (groups)

A descriptor, read exactly like `desc` (`readVersionAndDescriptor` **without** the classId), whose
payload is a `hierarchy` list of `{ 'Nm  ': TEXT, zuid: TEXT }` entries plus empty objects, e.g.
`[{'Nm  ': 'PRE_EXPORT ', zuid: '965209f2-…'}, {}, …]` (ag-psd's comment). It describes the brush
group tree in the presets panel. **Safe to ignore for rendering**; a parser should skip it (and
must not treat it as fatal). Brush groups are also mirrored per-preset by
`brushGroup = { useBrushGroup: bool }`.

---

## 9. Descriptor structure basics (needed for `desc` and `phry`)

Adobe documents the descriptor structure as "the standard structure for storing arbitrary data" —
the Photoshop PSD specification's *Descriptor structure* / *Additional Layer Information* sections
([link](https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/)), and it is the same
serialization used by the ASL/GRD/ABR presets. Cross-check: the 0xfeedface ABR spec describes each
key with `(Objc)`, `(TEXT 19)`, `(UntF) #Prc`, `(bool)`, `(long)`, `(enum)`, `(doub)` — i.e. exactly
the OSType tags below.

### 9.1 Descriptor and class structure

```
Descriptor:
  UnicodeString className          // often "" (encoded as charCount=1 + U+0000)
  ClassID  classID                 // "null", "brushPreset", "computedBrush", "sampledBrush",
                                   // "brVr", "dualBrush", "brushGroup", "Ptrn", "dBrush", "dTips", …
  u32 itemCount
  KeyedItem[itemCount]

KeyedItem:
  ClassID/ASCII key                // 4-char code as "Nm  ", "Brsh", "Dmtr", … or a length-prefixed ASCII string
  OSType  type                     // 4 raw bytes
  <value>                          // depending on type

ASCII-String-or-ClassID ("compact string"):
  i32 length
  if length == 0: 4 raw ASCII bytes     // e.g. "Nm  ", "Brsh", "null"
  else:           length ASCII bytes    // e.g. "brushPreset" (11), "sampledData" (11), "minimumDiameter" (15)

UnicodeString:
  u32 charCount                    // number of UTF-16 code units, INCLUDING a trailing null
  charCount × u16                  // UTF-16BE; strip the trailing U+0000
```

* ag-psd: `readAsciiStringOrClassId(reader)` = `length = readInt32(); readAsciiString(reader, length || 4)`;
  `readClassStructure` = `{ name: readUnicodeString(), classID: readAsciiStringOrClassId() }`;
  `readDescriptorStructure` = class structure + `itemCount = readUint32()` + the keyed items.
* **`includeClass`**: ag-psd's reader optionally records `_name` and `_classID` on each parsed
  descriptor object. You need the classId to know which brush shape a `Brsh` object is — so always
  keep it (the Rust port notes that its `read_version_and_descriptor` always includes the class,
  equivalent to `includeClass = true`).
* All keys in a well-formed Photoshop descriptor are 4-character codes, but long-form ASCII keys
  exist (`minimumDiameter`, `sampledData`, `useTipDynamics`, `physics`, `clumping`, `thickness`,
  `stiffness`, `interpretation`, `protectTexture`, …), which is why the "compact string" form is
  mandatory, not optional.

### 9.2 OSType values

| OSType | Payload |
| --- | --- |
| `'Objc'`, `'GlbO'` | a nested **Descriptor** |
| `'VlLs'` | `i32 itemCount`, then for each item: 4-byte OSType, then that value |
| `'doub'` | `f64` (big-endian) |
| `'UntF'` | 4-byte **unit code** + `f64` → `{ units, value }` |
| `'UnFl'` | 4-byte unit code + `f32` (rare; ag-psd supports it) |
| `'TEXT'` | UnicodeString (§9.1) |
| `'enum'` | two "compact strings": enum **type** then enum **value** → join as `"Type.Value"` |
| `'long'` | `i32` |
| `'comp'` | two `u32` (low, high) — 64-bit integer |
| `'bool'` | `u8` (0/1); ag-psd does `!!value` |
| `'type'`, `'GlbC'` | a class structure (`{name, classID}`) |
| `'alis'` | `i32 length` + `length` bytes |
| `'tdta'` | `i32 length` + `length` **raw** bytes (e.g. `dtipsErodibleTipHeightMap`) |
| `'obj '` | a reference structure (`i32 count`, then per item a 4-byte type `prop/Clss/Enmr/rele/Idnt/indx/name` and its payload) |
| `'ObAr'` | Photoshop's object array (version 16, name, classID, count, then typed sub-arrays) — advanced |
| `'Pth '` | a file path (LE strings) — advanced, never seen in ABR |

Kaitai's `descriptor_type` enum lists the same tags as `u32` constants:
`Objc 0x4f626a63`, `VlLs 0x566c4c73`, `TEXT 0x54455854`, `UntF 0x556e7446`, `bool 0x626f6f6c`,
`long 0x6c6f6e67`, `enum 0x656e756d`, `doub 0x646f7562`. Its `alis` constant is written
`0x976c6973`, which cannot be `'alis'` (= `0x616c6973`) — treat that entry as a typo in the schema
and use the ASCII four-character codes themselves (compare the 4 raw bytes, never a decoded number).

Unit codes (`UntF` first 4 bytes), from ag-psd's `unitsMap`, the Kaitai `float_unit` enum and
tonton-pixel:

| Code | Unit | Seen in ABR |
| --- | --- | --- |
| `'#Pxl'` | Pixels | `Dmtr` |
| `'#Prc'` | Percent | `Spcn`, `Rndn`, `Hrdn`, `jitter`, `minimumDepth`, … |
| `'#Ang'` | Angle (degrees) | `Angl`, `'H   '` |
| `'#Rsl'` | Density | — |
| `'#Rlt'` | Distance | — |
| `'#Nne'` | None | — |
| `'#Mlm'` | Millimetres, `'#Pnt'` Points, `'RrPi'` Picas, `'RrIn'` Inches, `'RrCm'` Centimetres | ag-psd maps them; not seen in ABR |

**Good news for the implementer:** the **type is in the file**, so reading a descriptor needs *no*
key→type table. (ag-psd's enormous `fieldToType` / `fieldToExtType` tables exist only to *write*
descriptors, because the writer must invent a type for each key.) A reader needs only §9.2.

**Bad news:** an unknown OSType cannot be skipped (there is no length prefix), so a reader must
either throw for it or bail out of that descriptor and continue with whatever it had already parsed.
Wrap the whole `desc` parse in `try/catch` and keep a partial result.

**Measured validation:** parsing the sample file's `desc` block with exactly the rules above —
version 16, one outer descriptor (`classID "null"`, 1 item `'Brsh'` of type `VlLs`, 36 `Objc`
elements of class `brushPreset`) — consumed **44 131 bytes = the whole block length**, with no
leftover and no unknown OSType. That is a strong end-to-end check that the layout is right.

---

## 10. GOTCHAS, ambiguities and safe fallbacks

### 10.1 v1/v2 record header order — sources disagree

* **GIMP** (and `abr2png`, whose struct was copied from it) reads `i16 type`, `i32 size`
  (`struct _AbrBrushHeader { gint16 type; gint32 size; }`,
  [gimpbrush-load.c](https://browse.dgit.debian.org/gimp.git/plain/app/core/gimpbrush-load.c)),
  and the `@azphalt` JS parser does the same (`const type = r.u16(); const size = r.u32();`).
* **abrupng** reads `u16 len` then `u16 type` and reaches the next brush at `start + 2 + len`
  ([abr1.rs](https://github.com/scurest/abrupng/blob/master/src/abr/abr1.rs)). Taken literally, this
  makes `type` equal the high half of the 32-bit size (usually `0`) and the parser would reject
  every real file — so abrupng's v1/v2 path is very likely untested/broken rather than evidence of
  a different layout.
* **`abr2png` also has a real bug**: its `abr_read_short` is declared to return `char` and reads
  **one** byte (`fread(&val, sizeof(val)=1, …)`) before byte-swapping — so its "type" value is
  garbage and its v1/v2 path cannot work either.

**Recommendation:** implement the GIMP layout, but *verify* it: after reading `type`, require
`type ∈ {1,2}`; also require the record to fit in the file (`6 + size <= fileLength`). If validation
fails, retry interpreting the first field as a `u16` size and the next as a `u16` type (abrupng's
order) and accept whichever yields plausible bounds (`width, height ≥ 1`, `depth == 8`,
`compression ∈ {0,1}`). No real v1/v2 sample was available to settle this empirically.

### 10.2 The 8 unknown bytes (v6.1) and 4 meta bytes (v6.2)

* v6.1: 8 bytes at body offset 0 are never interpreted by anyone; only their *size* (10 with the
  following `u16`) is relied on. If a future/third-party writer changes them, only the fixed-skip
  approach breaks — which is another reason to prefer length-driven parsing.
* v6.2: `00 01 00 00` measured (`u16 1`, `u16 0`). The first `u16` may be a "channels present"
  style flag, but nothing documents it. Do not validate its value; just skip it.

### 10.3 Fixed offsets and padding bugs in existing tools

* GIMP's and abr2png's `abr_reach_8bim_section` seeks `section_size` **without** adding the 0–3
  padding bytes, so if a block before the target one has `length % 4 != 0`, they land mid-block and
  fail. Always add the padding.
* Krita's `find_sample_count_v6` walks items using the padded length and *counts* them; it does not
  parse item bodies (it always uses the fixed 47/301 skip).
* ag-psd and Krita read only `>= 12` / `offset+12 <= end` for the block loop; make sure you stop at
  `fileLength` and tolerate a final block with no padding (measured).
* abrupng explicitly errors when it sees a **lowercase `'8bim'`** signature — evidence that such
  files exist in the wild. Decide deliberately: accept only `'8BIM'` (recommended), or accept both
  case variants.

### 10.4 Naive/incorrect reference implementations (do not copy)

`@azphalt/importer-abr` (npm, JS) advertises that it was "validated against independently-constructed
fixtures" only, and it is wrong in three ways for real v6 files: it reads the brush ID as a
**Unicode string** rather than a Pascal string, it never skips the 10/264-byte subversion-specific
region before the rect, and it ignores `patt`/`phry`. Its own docstring admits Photoshop compatibility
is unverified. Use it as a *warning about the domain*, not as a reference.

### 10.5 Truncation and corruption detection

Cheap, high-value checks (fail the item, not the file):

| Check | Where |
| --- | --- |
| `fileLength >= 4`; block `length` fits in the file | block loop |
| signature is `8BIM` at each block start | block loop |
| item `length` fits inside the `samp` block | item loop |
| Pascal ID length `n` satisfies `1 + n <= remaining` | item prefix |
| VMAL `version == 3` (warn, don't abort if different) and `12 + vmalLength <= itemLength` | v6.2 |
| channel walk must not run past the item payload; if it does, the item is corrupt — fall back to the fixed 264 offset | v6.2 |
| `pixelDepth ∈ {8,16}`, `pixelDepth2 ∈ {8,16}`, `compression ∈ {0,1}` | record |
| `width = right − left ≥ 1`, `height = bottom − top ≥ 1`, both `≤ 30000`, `width*height ≤ 64e6` | record |
| RLE: `height` row lengths each `≤ width*2 + 2`, then the sum `Σ rowLength ≤ remaining bytes` **before** allocating/decoding | RLE |
| RLE: never write past `width*height` decoded bytes; a row must decode to exactly `width` bytes | RLE |
| descriptor: every `VlLs`/`Objc` count is bounded by the remaining block bytes (`count * 5 <= remaining` is a cheap sanity test) | desc |
| descriptor: unknown OSType → abandon that descriptor, keep earlier presets | desc |

A useful global guard: because item and block lengths are explicit, a parser can always resynchronise
to the next boundary and continue after a bad item. **Never let one bad brush kill the whole file.**

### 10.6 Safe fallback ladder (metadata-only mode)

1. Parse header, blocks, and `desc` first. The `desc` block is independent of `samp` and gives
   names, diameters, spacing, hardness and dynamics.
2. Then parse `samp`, joining by UUID. For any tip that fails to decode (16-bit RLE, unknown
   compression, corrupt RLE, implausible bounds) keep the preset and mark
   `tip: { id, status: 'undecodable' }` instead of dropping it.
3. If `samp` is missing/empty, still return every preset with `hasPixels: false` — a computed-only
   set is a legitimate ABR.
4. If `desc` fails entirely (unknown OSType, truncation) but `samp` works, return tips with
   synthetic names (the ID, or `filename-001` like GIMP/Krita/abr2png do) and `spacing = 25`
   (GIMP's default when only `samp` is available: *"real value needs 8BIMdesc section parser"*).
5. Surface per-item errors in the result; the caller can decide.

### 10.7 Other real-world quirks

* **`Spcn` appears in two places**: in `brushPreset` (the brush's spacing) and inside the shape
  descriptor (also spacing), and additionally in some presets parallel to `useScatter` (measured:
  `useScatter`, `'Spcn'`, `'Cnt '`). ag-psd reads the preset-level `Spcn` as the brush spacing and
  ignores the shape-level one for sampled brushes. Prefer the preset-level value; fall back to the
  shape-level one, then to `25`.
* **`'Cnt '` is a `double`** (`doub`), not a long — a common cause of misparse if you assume long.
* **`Intr` is ambiguous**: 0xfeedface could not identify it (and guessed it might be "Smoothing");
  ag-psd calls it "spacing on". Both may be right in different Photoshop versions.
* **`Wtdg` / `Nose` / `'Rpt '`** are simple booleans (wet edges / noise / airbrush).
* **`Angl` units**: `#Ang` in degrees, range −180…180; `'H   '` (hue jitter) is also `#Ang`-ish in
  colours but `#Prc` in the ABR colour-dynamics block (measured: `'H   '` = `UntF #Prc`).
* **Preset names are often just numbers** (measured: `"18"`, `"19"`, `"20"`, …) because the sample
  file was authored programmatically; do not rely on names being meaningful/unique. The `samp` ID and
  `sampledData` UUID are the only stable identifiers.
* **Multiple presets share one tip** (measured). Do not assume a 1:1 mapping, and do not
  deduplicate by name.
* **Tip bitmap size ≠ brush diameter** (measured). `Dmtr` is the logical size; the bitmap is stored
  at whatever resolution Photoshop sampled it (often larger).
* **The rect in the v6.1 tail is signed (`i32`) while the VMAL rect fields are unsigned (`u32`)** —
  use `u32` for the VMAL and `i32` for the v6.1 tail, and clamp negatives to a parse error.
* **`BlnM` long-form ids** (Photoshop 2026 writes `BlnM.normal`, `BlnM.colorBurn`) — accept both
  4-char codes and long names, case-insensitively (Rust port §`blnm_decode`).
* **`'Md  '` may be absent** in `toolOptions` (default to normal).
* **Colours in `desc`**: `'Clr '`, `sdwC`, etc. are nested descriptors (`RGBC`, `HSBC`, `CMYC`, …);
  not needed for brush tips, but if you display them, `parseColor` in ag-psd shows the shape
  (`Rd  /Grn /Bl  ` doubles, `H   ` UntF `#Ang` + `Strt`/`Brgh`, `Gry `, `Lmnc`/`A   `/`B   `).
* **Do not require `desc` to contain only one item.** Iterate all top-level keyed items and take the
  one named `'Brsh'` (measured: exactly one, but the 0xfeedface spec numbers the presets with an
  extra `(Objc) brushPreset 20` header that suggests per-preset nested structures in other writers).

---

## 11. Recommended parse algorithm (pseudocode for a JS implementer)

```js
// ── utilities ───────────────────────────────────────────────────────────────
class Reader {
  constructor(bytes, offset = 0) { this.b = bytes; this.o = offset; }
  get left()   { return this.b.length - this.o; }
  u8()  { return this.b[this.o++]; }
  i8()  { const v = this.b[this.o++]; return v < 128 ? v : v - 256; }
  u16() { const v = (this.b[this.o] << 8) | this.b[this.o + 1]; this.o += 2; return v; }
  i16() { const v = this.u16(); return v < 0x8000 ? v : v - 0x10000; }
  u32() { const v = ((this.b[this.o] << 24) | (this.b[this.o+1] << 16) |
                     (this.b[this.o+2] << 8) | this.b[this.o+3]) >>> 0; this.o += 4; return v; }
  i32() { return this.u32() | 0; }
  f64() { const v = new DataView(this.b.buffer, this.b.byteOffset + this.o, 8).getFloat64(0, false);
          this.o += 8; return v; }
  f32() { const v = new DataView(this.b.buffer, this.b.byteOffset + this.o, 4).getFloat32(0, false);
          this.o += 4; return v; }
  sig() { const s = String.fromCharCode(this.b[this.o], this.b[this.o+1],
                                        this.b[this.o+2], this.b[this.o+3]); this.o += 4; return s; }
  bytes(n) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  skip(n)  { this.o += n; }
  ascii(n) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.b[this.o++]); return s; }
  pascal(padTo) {                     // §3.3
    let len = this.u8();
    const s = len ? this.ascii(len) : '';
    while (++len % padTo) this.o++;   // counts the length byte itself
    return s;
  }
  unicode() {                          // §9.1 — strips ONE trailing null
    const n = this.u32(); let s = '';
    for (let i = 0; i < n; i++) { const c = this.u16(); if (c || i < n - 1) s += String.fromCharCode(c); }
    return s;
  }
  compactString() {                    // "ascii string or class id" (§9.1)
    const len = this.i32();
    return len ? this.ascii(len) : this.ascii(4);
  }
  align4() { this.o += (4 - (this.o % 4)) % 4; }         // only correct if base was 4-aligned
}

// ── entry point ─────────────────────────────────────────────────────────────
function parseAbr(bytes) {
  const r = new Reader(bytes);
  const major = r.u16();
  const minorOrCount = r.u16();

  if (major === 1 || major === 2)           return parseOld(r, major, minorOrCount);
  if (major === 6 || major === 7 || major === 9 || major === 10) {
    if (minorOrCount !== 1 && minorOrCount !== 2) throw new Error('unsupported ABR minor version');
    return parseNew(r, major, minorOrCount);
  }
  throw new Error('unsupported ABR version ' + major);
}

// ── old format (v1/v2) ──────────────────────────────────────────────────────
function parseOld(r, major, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const type = r.i16();                 // 1 = computed, 2 = sampled
    const size = r.i32();                 // bytes after this field (GIMP layout — see §10.1)
    const end  = r.o + size;              // authoritative resync point
    let brush = { index: i, type, status: 'ok' };
    try {
      if (type === 2) {
        r.i32();                          // misc
        brush.spacing = r.i16();
        if (major === 2) {
          const n = r.u32();              // UCS-2 characters
          brush.name = decodeUtf16BE(r.bytes(n * 2));   // strip trailing NUL
        }
        r.i8();                           // antialiasing
        const b = [r.i16(), r.i16(), r.i16(), r.i16()];  // short bounds (ignored)
        const rect = [r.i32(), r.i32(), r.i32(), r.i32()]; // long bounds: t,l,b,r
        const depth = r.i16();
        const compression = r.u8();
        brush.bounds = { top: rect[0], left: rect[1], bottom: rect[2], right: rect[3] };
        brush.width  = rect[3] - rect[1];
        brush.height = rect[2] - rect[0];
        brush.alpha  = readPixels(r, brush.width, brush.height, depth, compression);
      } else {
        brush.status = 'computed';        // no pixels
      }
    } catch (e) {
      brush.status = 'error'; brush.error = String(e);
    }
    r.o = end;                            // ALWAYS resync to the record boundary
    out.push(brush);
  }
  return { major, brushes: out, presets: [], patterns: [] };
}

// ── new format (v6/v7/v9/v10) ───────────────────────────────────────────────
function parseNew(r, major, minor) {
  const sampItems = [];      // { id, bounds, width, height, alpha }
  const presets   = [];      // decoded descriptors
  const patterns  = [];

  while (r.left >= 12) {
    const start = r.o;
    if (r.sig() !== '8BIM') { r.o = start; break; }   // trailing junk / not a block
    const key = r.sig();
    const len = r.u32();
    if (len > r.left) throw new Error('truncated block ' + key);

    const blockStart = r.o, blockEnd = blockStart + len;
    try {
      if (key === 'samp') {
        while (r.o < blockEnd) {
          const itemLen = r.u32();
          const itemEnd = r.o + itemLen;             // payload end, padding excluded
          try { sampItems.push(parseSampleItem(r, minor)); }
          catch (e) { /* keep going; record the failure by index if you like */ }
          r.o = itemEnd;                             // resync (§10.5)
          while ((r.o - blockStart) % 4) r.o++;      // pad the item to 4 (relative to block)
        }
      } else if (key === 'desc') {
        const version = r.u32();                     // 16
        if (version !== 16) throw new Error('bad descriptor version');
        const d = readDescriptor(r, true);            // §9
        // the ABR convention: one outer descriptor whose 'Brsh' item is the list of presets
        if (Array.isArray(d['Brsh'])) presets.push(...d['Brsh']);
        else presets.push(d);                         // tolerate a bare descriptor
      } else if (key === 'patt') {
        while (r.o < blockEnd) patterns.push(readPattern(r));
      } else if (key === 'phry') {
        r.u32(); readDescriptor(r, false);            // ignored
      }                                              // else: unknown → skip
    } catch (e) { /* keep whatever we parsed; never abort the file */ }

    r.o = blockEnd;
    if (r.left > 0) r.align4();                      // §3.1 (do not require padding at EOF)
  }

  // join presets → sampled tips by UUID
  const byId = new Map(sampItems.map(s => [s.id, s]));
  const brushes = presets.map(p => ({
    name: p['Nm  '],
    shape: classifyShape(p['Brsh']),                 // computed/sampled/dynamic/tips
    spacing: pct(p['Spcn']) ?? 25,
    dynamics: { size: p.szVr, angle: p.angleDynamics, roundness: p.roundnessDynamics, ... },
    texture: p.useTexture ? p.Txtr : undefined,
    toolOptions: p.toolOptions,
    tip: p['Brsh'] && p['Brsh'].sampledData ? byId.get(p['Brsh'].sampledData) ?? null : null,
  }));
  return { major, minor, brushes, samples: sampItems, patterns };
}

// ── one 'samp' item ─────────────────────────────────────────────────────────
function parseSampleItem(r, minor) {
  const id = r.pascal(1);                           // §5.1
  if (minor === 1) {                                // §5.2
    r.skip(10);                                      // 8 unknown + u16 pixelDepth
    const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
    const depth = r.u16(), compression = r.u8();
    return finish(id, top, left, bottom, right, depth, compression, r);
  }
  return parseV62(id, r);                            // §5.3
}

function parseV62(id, r) {
  const body = r.o;                                  // for the fixed-offset fallback
  r.u16(); r.u16();                                  // meta (00 01 00 00)
  const vmalVersion = r.u32();                       // 3
  const vmalLength  = r.u32();
  r.u32(); r.u32(); r.u32(); r.u32();                // VMAL bounds (t,l,b,r) — not the tip rect
  const channels = r.u32();                          // 56 observed
  let rect = null, depth = 0, compression = 0, data = null;
  for (let i = 0; i < channels + 2; i++) {
    const has = r.u32();
    if (!has) continue;
    const len = r.u32(), pixelDepth = r.u32();
    const top = r.u32(), left = r.u32(), bottom = r.u32(), right = r.u32();
    const pixelDepth2 = r.u16(), comp = r.u8();
    const dataLen = len - 23;
    if (!rect) { rect = { top, left, bottom, right }; depth = pixelDepth2 || pixelDepth;
                 compression = comp; data = r.bytes(dataLen); }
    else r.skip(dataLen);
  }
  if (!rect) throw new Error('no written channel');
  return finish(id, rect.top, rect.left, rect.bottom, rect.right, depth, compression,
                null, data);
  // fallback if the walk above throws: seek to body + 37 + 264 (subversion 2) — but only
  // after validating the rect/depth/compression you find there (§5.4, §10.5).
}

// ── pixels ──────────────────────────────────────────────────────────────────
function finish(id, top, left, bottom, right, depth, compression, r, preloaded) {
  const width = right - left, height = bottom - top;
  if (!(width > 0 && height > 0 && width <= 30000 && height <= 30000)) throw new Error('bad bounds');
  const alpha = preloaded
    ? readPixels(new Reader(preloaded), width, height, depth, compression)  // bytes already read
    : readPixels(r, width, height, depth, compression);                     // read from the stream
  return { id, bounds: { top, left, bottom, right }, width, height, depth, alpha };
}

function readPixels(r, width, height, depth, compression) {
  if (depth === 16 && compression === 1) throw new Error('16-bit RLE not supported');
  if (compression === 0) {
    if (depth === 8)  return r.bytes(width * height).slice();
    const out = new Uint8Array(width * height);      // 16-bit raw, BE → high byte
    for (let i = 0; i < out.length; i++) out[i] = r.u16() >> 8;
    return out;
  }
  if (compression === 1 && depth === 8) return decodeRLE8(r, width, height);
  throw new Error('unsupported depth/compression ' + depth + '/' + compression);
}

function decodeRLE8(r, width, height) {              // §7.2
  const rowLens = new Array(height);
  let total = 0;
  for (let y = 0; y < height; y++) { rowLens[y] = r.u16(); total += rowLens[y]; }
  if (total > r.left) throw new Error('RLE rows exceed data');
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = r.bytes(rowLens[y]);
    let i = 0, x = 0, base = y * width;
    while (i < row.length && x < width) {
      const h = row[i++];
      if (h > 128)      { const n = 256 - h, v = row[i++]; for (let k = 0; k < n && x < width; k++) out[base + x++] = v; }
      else if (h < 128) { const n = h + 1; for (let k = 0; k < n && x < width; k++) out[base + x++] = row[i++]; }
      /* h === 128 → no-op */
    }
    if (x !== width) { /* short row: leave zeros, or flag a warning */ }
  }
  return out;
}

// ── descriptors ─────────────────────────────────────────────────────────────
function classifyShape(shapeDesc) {                   // §8.3
  if (!shapeDesc) return { type: 'unknown' };
  switch (shapeDesc._classID) {
    case 'computedBrush': return { type: 'computed', /* Dmtr, Hrdn, Angl, Rndn, Spcn, Intr, flipX, flipY */ };
    case 'sampledBrush':  return { type: 'sampled',  /* … + 'Nm  ', sampledData */ };
    case 'dBrush':        return { type: 'dynamic' };
    case 'dTips':         return { type: 'tips' };
    default:              return { type: shapeDesc._classID || 'unknown' };
  }
}

function readDescriptor(r, includeClass) {           // §9 — returns the descriptor object
  const name = r.unicode(), classID = r.compactString();
  const obj = includeClass ? { _name: name, _classID: classID } : {};
  const count = r.u32();
  for (let i = 0; i < count; i++) {
    const key = r.compactString();
    obj[key] = readValue(r, r.sig(), includeClass);   // OSType is 4 raw bytes
  }
  return obj;
}

function readValue(r, type, includeClass) {
  switch (type) {
    case 'Objc': case 'GlbO': return readDescriptor(r, includeClass);
    case 'VlLs': { const n = r.u32(), a = [];
                   for (let i = 0; i < n; i++) a.push(readValue(r, r.sig(), includeClass)); return a; }
    case 'TEXT': return r.unicode();
    case 'doub': return r.f64();
    case 'UnFl': { const u = r.sig(); return { units: u, value: r.f32() }; }
    case 'UntF': { const u = r.sig(); return { units: u, value: r.f64() }; }
    case 'enum': { const t = r.compactString(), v = r.compactString(); return t + '.' + v; }
    case 'long': return r.i32();
    case 'comp': return { low: r.u32(), high: r.u32() };
    case 'bool': return !!r.u8();
    case 'type': case 'GlbC': return { name: r.unicode(), classID: r.compactString() };
    case 'alis': { const n = r.i32(); return r.bytes(n); }
    case 'tdta': { const n = r.i32(); return r.bytes(n); }
    default: throw new Error('unknown OSType ' + type);   // cannot skip — bail out of this descriptor
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────
const pct = v => (v && v.units === '#Prc') ? v.value / 100 : undefined;
```

### 11.1 Minimum viable first version

1. Header + block walk (`samp`, `desc`, `patt`, `phry`, unknown → skip).
2. `samp` items: Pascal ID, then subversion 2 → VMAL walk, subversion 1 → 10-byte skip.
3. 8-bit raw + 8-bit RLE decoding (covers effectively all real brush tips).
4. `desc` descriptor reader with the §9.2 OSType table; keep `_classID`.
5. Join by `sampledData` UUID; report undecodable/missing tips as metadata-only.
6. Sanity checks from §10.5 and a per-item error list.

Everything else (16-bit, `dBrush`/`dTips`, textures, tool options) is additive and does not change
the byte layout.

---

## 12. Annotated real-world byte map (measured)

From `brushes_by_mar_ka_d338ela.abr` (major 6, minor 2), block 0 = `'samp'` at offset 4, length
3 631 900; item #0 starts at offset 16:

| File offset | Bytes | Meaning |
| --- | --- | --- |
| 4 | `38 42 49 4D` | `'8BIM'` |
| 8 | `73 61 6D 70` | `'samp'` |
| 12 | `00 36 92 AC` | block length `3 631 900` |
| 16 | `00 02 D2 AC` | item length `185 004` (bytes after this field; `4 + 185004` = next item) |
| 20 | `24` | Pascal length `36` |
| 21 | `32 32 30 35 …` | ID `2205283b-e0f2-11df-ac64-ac9512eb12e7` (36 ASCII bytes) |
| 57 | `00 01 00 00` | meta |
| 61 | `00 00 00 03` | VMAL version `3` |
| 65 | `00 02 D2 7B` | VMAL length `184 955` (= item length − 49) |
| 69 | `00 00 00 94 00 00 00 FF 00 00 03 51 00 00 03 36` | VMAL bounds: t=148 l=255 b=849 r=822 |
| 85 | `00 00 00 38` | channel count `56` (records = 58) |
| 89 … 308 | `00 00 00 00` × 55 | records 0…54, `has == 0` (4 bytes each) |
| 309 | `00 00 00 01` | record 55: `has = 1` |
| 313 | `00 02 D1 7B` | channel length `184 699` (= 23 + 184 676) |
| 317 | `00 00 00 08` | pixel depth `8` |
| 321 | `00 00 00 94 00 00 00 FF 00 00 03 51 00 00 03 36` | channel rect t=148 l=255 b=849 r=822 |
| 337 | `00 08` | pixel depth again `8` |
| 339 | `01` | compression `1` = RLE |
| 340 | `00 15 00 18 00 19 00 1B …` | row byte counts: 21, 24, 25, 27, … (701 rows) |
| … | packed rows | PackBits data, 184 676 bytes |
| 185 024 | — | start of item #1 (item #0 payload + 185 004, already 4-aligned) |

Consistency: `89 + 55*4 = 309`; `309 + 12 = 321` (rect); `321 + 16 + 2 + 1 = 340` (row counts);
`340 + 184 676 = 185 016`; `+2 trailing unwritten records (8 bytes) = 185 024` = start of the next
item. The fixed 264 shortcut lands at `57 + 264 = 321`, i.e. exactly on the rect — see §5.4.

Other measured facts from the same file: 31 `samp` items, all depth 8, all RLE, all channel count 56
with the written record at index 55; `patt` present with length 0; `desc` length 44 131 containing
36 `brushPreset` descriptors and consuming the block to its final byte.

---

## 13. Open questions / known gaps

1. **v1/v2 record header order** (§10.1) — GIMP vs abrupng disagree; no real v1/v2 sample was
   available to settle it empirically. Implement with validation + the abrupng fallback.
2. **The 8 "unknown" bytes** in the v6.1 body, and the meaning of the `00 01`/`00 00` meta pair in
   v6.2, remain unexplained by every source.
3. **Whether the written VMAL channel index is always 55** for `samp` (and what selects it). The
   fixed-offset shortcut of ag-psd/Krita/abrupng implies yes for the files they were tested on, but
   patterns use a different index, so the general rule is unknown.
4. **The `+2` extra VMAL channel records** are written/read by ag-psd and confirmed by measurement
   for `samp`, but their purpose (alpha? mask? padding?) is undocumented.
5. **No 16-bit or 6.1 sample was available**, so the 16-bit paths (`pixelDepth == 16`, 16-bit RLE)
   are described from code only; 16-bit RLE is unimplemented in every public parser.
6. **Major-version → Photoshop-release mapping** (§1.1) is unverified.
7. **`'phry'`'s full semantics** (grouping/tree) are undocumented; only the ag-psd comment shows an
   example.
8. **`toolOptions`** (classId `_` / `MixB` / `SmTl`, keys `flow, wetness, dryness, mix, Smoo, Md  ,
   Opct, smoothing*, pressureSmoothing, useLegacy, PrfA/Prs …`) is only partially reverse-engineered
   (ag-psd carries several `TODO`/`???` markers: `MgcE`, `ErsB`, `RfVr`).
