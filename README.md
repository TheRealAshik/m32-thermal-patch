# m32-thermal-patch

Raise the Samsung `sec_battery` **emergency overheat shutdown** threshold inside a
device's own `dtbo.img`, and prove byte-for-byte that nothing else in the device
tree moved. Written for the Galaxy M32 (SM-M325F) "false overheating, phone powers
itself off" problem, but the DTB walk is generic, so it works against any Samsung
`dtbo.img.lz4` that carries a `battery,overheatlimit_threshold` property.

**No dependencies.** Node 18+ only. No Python, no `dtc`, no `lz4` binary, no
AOSP toolchain.

---

## Read this before you flash anything

**This patch has not been confirmed to fix the problem it targets.** It was built
and verified statically — every byte is checked — but it has never been flashed and
booted. If you flash it, you are the test.

**It removes a safety cutoff.** `overheatlimit_threshold` is the last thing that
powers a 5000 mAh lithium cell off when it genuinely gets too hot. After this patch
the phone will not shut itself down on high battery temperature, at all, ever.
Thermal runaway does not announce itself.

**Flashing an unsigned partition to a Samsung device trips the Knox e-fuse.** That
is permanent and irreversible: Samsung Pay, Secure Folder and warranty claims are
gone, and no amount of reflashing stock brings them back.

### Most "false overheating" M32s are not this bug

When the case that produced this tool was instrumented over ADB, **every thermal
sensor read normal**:

```
Thermal Status: 0        IsStatusOverride: false        HAL Ready: true
AP 35.9   PA 35.7   BAT 33.1   SKIN 35.0   SUBBAT 0.0   USB 0.0
```

and the recorded reboot reason was `reboot,diwarme_maintenancemode` — Samsung's
deliberate maintenance warm reboot, **not** a thermal emergency shutdown. The phone
was also sitting at **13 % charge, 3741 mV, on a fuel gauge last calibrated
2021-06-27**. An aged cell sagging under load causes shutdowns that look exactly
like a thermal cut, and no thermal patch will touch it.

So before you spend your Knox fuse, run these three read-only commands:

```bash
adb shell dumpsys thermalservice           # current temps + Thermal Status
adb shell dumpsys battery                  # "temperature:" is in 0.1 C
adb shell getprop ro.boot.bootreason       # how did it last reboot?
```

- A real thermal trip shows up as an elevated `BAT`/`AP` value and a thermal
  bootreason, not `diwarme_maintenancemode`.
- If `temperature: 331` (33.1 °C) and the phone still dies, your problem is
  **power**, not heat — see [Battery health](#battery-health) below.
- If you can catch the dialog appearing *while* the temperature reads low, that is
  genuine evidence for this patch.

**These commands need no root.** Nothing above modifies the device.

---

## What the flag actually is

There is no build-time feature flag and no toggle in Settings. The cutoff is a
device-tree property read by the kernel battery driver at probe time:

| Property | Stock | Meaning |
|---|---|---|
| `battery,overheatlimit_threshold` | `700` (70.0 °C) | emergency power-off |
| `battery,overheatlimit_recovery` | `680` (68.0 °C) | recovery hysteresis |

The value is a `u32` big-endian count of **tenths of a degree**, and it lives in
**every** overlay DTB in the image — the M32's `dtbo.img` contains two. Patch one
and the other can still shut the phone off.

### What this patch does NOT fix

Only the 70 °C power-off is affected. These are separate properties and are left
untouched, so the corresponding dialogs keep appearing:

| Property | Value | Symptom it causes |
|---|---|---|
| `battery,usb_protection_temp` | `610` (61 °C) | USB charging cutoff |
| `battery,chg_temp_check_type` / charge path | `530` (53 °C) | "Charging has been stopped. Your phone's temperature is too high." |
| `battery,temp_high_threshold_*` | `500` (50 °C) | high-temp warning |
| `battery,dchg_high_temp` | `500` (50 °C) | discharge throttling |
| `battery,wire_warm_overheat_thresh` | `500` (50 °C) | charging warm stage |
| `battery,thermal_source` | `4` | *which* sensor feeds the battery temperature |

Pass `--threshold 2000 --recovery 1980` for the shutdown only, or read
[Investigating other thresholds](#investigating-other-thresholds).

---

## Usage

You supply your **own** firmware. This repo ships no Samsung binaries — see
[Why no firmware files](#why-no-firmware-files).

```bash
# 1. Inspect. Read-only, writes nothing:
node src/patch-dtbo.mjs --input AP_M325FXXSDDYE3_..._tar.md5 --list

# 2. Dry run - shows exactly what it would change and where:
node src/patch-dtbo.mjs --input AP_M325FXXSDDYE3_..._tar.md5

# 3. Build the patched archive into ./out :
node src/patch-dtbo.mjs --input AP_M325FXXSDDYE3_..._tar.md5 --apply --outdir out
```

Works on a whole AP `.tar.md5`, or on a bare `dtbo.img.lz4` / `dtbo.img` you have
already extracted. To get `dtbo.img.lz4` out of an AP tar yourself:

```bash
tar -xf AP_M325FXXSDDYE3.tar.md5 dtbo.img.lz4
```

Verified output on the M325FXXSDDYE3 AP tar:

```
input archive : ../AP_magisk_patched-31100_CvbO4.tar
member        : dtbo.img.lz4 (60204 bytes, lz4 frame)
DTB structures: @96 (87246 B), @87342 (87187 B)

locating targets:
  DTB@96      battery,overheatlimit_threshold    now=700    (70.0 C)  @8752 len=4
  DTB@96      battery,overheatlimit_recovery     now=680    (68.0 C)  @8768 len=4
  DTB@87342   battery,overheatlimit_threshold    now=700    (70.0 C)  @95998 len=4
  DTB@87342   battery,overheatlimit_recovery     now=680    (68.0 C)  @96014 len=4

patched 4 properties; 8 bytes changed, all inside those properties; image size unchanged (178752)

verification - re-parsed out\AP_dtbo_patched.tar.md5:
  properties in tree: 3929 -> 3929
  properties changed: 4 (expected 4)

OK: every other property in the device tree is byte-identical to your input.
```

### Safety behaviour

The tool refuses to write, with no partial output, when:

- the property it found is not a plausible temperature (must be `0..1200`, i.e. 0-120 °C) —
  this also makes re-running it on an already-patched image a no-op instead of a corruption;
- the requested value is outside `0..4000`;
- `battery,overheatlimit_threshold` cannot be found by name under a `/battery` node
  (i.e. a layout it does not understand);
- any changed byte falls outside a patched property's own range;
- re-reading the finished artifact from disk shows any property changed, added or
  lost beyond the intended set.

To go back to a stock threshold explicitly: `--threshold 700 --recovery 680`.

---

## Flashing

Only if you have done the diagnosis above and accept the Knox consequence.

1. **Charge the phone above 50 %.** A flash that dies halfway is how a recoverable
   mod becomes a dead board. This is not a suggestion.
2. Keep a copy of your **original** AP tar. It is your rollback.
3. Run Odin as administrator (3.14.x is what this was built against).
4. Download mode: power off, then **hold Volume Down while plugging in USB**;
   press **Volume Up** at the warning screen.
5. `AP` slot → `out/AP_dtbo_patched.tar.md5`. Leave **BL**, **CSC**, **HOME_CSC** empty.
6. Options tab: **Auto Reboot** and **F. Reset Time** on, **Re-Partition absolutely off**
   — Re-Partition with a partial image wipes the device.
7. Start. A 70 KB payload finishes in seconds and prints `PASS!`. The first boot
   afterwards takes several minutes while dexopt runs; that is normal.

**Unverified:** that Odin accepts a single-member AP tar. It is common practice,
but it has not been tested here. If Odin rejects it, rebuild against the full AP
tar instead — the tool already reads and reuses the stock member header.

### Confirm the patch is live

The overlay DTB is applied into the running device tree at boot, so:

```bash
adb shell 'find /proc/device-tree /firmware/devicetree/base -name "*overheatlimit*"'
adb shell 'od -An -tu4 $(find /proc/device-tree -name "*overheatlimit_threshold*" | head -1)'
```

It should print `2000`. Reading `PASS!` in Odin is not confirmation; this is.

### Rollback

Hold **Volume Down + Power** until it reboots, enter download mode again, and flash
your original AP tar.

---

## How it works

`dtbo.img` is a raw LZ4 *frame* (`magic 0x184D2204`, `FLG=0x6c`, `BD=0x50`) holding
several flattened DTB structures plus a trailing AVB/`cert1` signature area.
Everything is hand-rolled in `src/`:

- **`lz4.mjs`** — xxh32, LZ4 frame decoder and encoder. The encoder is validated by
  reproducing Samsung's *own stored* header (`0x7a`) and content checksums, and by
  re-encoding the untouched original to a byte-identical round trip.
- **`dtb.mjs`** — FDT walk. A dtbo's DTBs are **not required to be 4-byte aligned**;
  on the M32 the second one starts at `87342` (`% 4 == 2`), so all alignment is done
  relative to each DTB's own base. Aligning on absolute file offsets silently reads
  wrong values out of the second tree — that bug is easy to introduce and hard to
  notice.
- **`tar.mjs`** — ustar reader/`tar.md5` writer. A `.tar.md5` is a plain ustar
  archive followed by an `md5sum`-format text line. Member name, mode, uid/gid and
  mtime are copied from the stock header so the archive stays as close to original
  as possible.
- **`patch-dtbo.mjs`** — the CLI. Locates targets **by property name**, never by
  hardcoded offset, so it survives firmware version changes.

### Battery health

```bash
adb shell dumpsys battery | grep -iE "temp|voltage|level|health"
```

`voltage` under ~3400 mV at non-zero `level`, or a level that jumps or collapses
under load, points at the cell rather than the thermistor. `dumpsys batterystests`
/ a battery replacement is the fix for that, and it costs less than a Knox fuse.

### Investigating other thresholds

List everything the driver was configured with, then decide per-symptom:

```bash
node src/patch-dtbo.mjs --input <your AP tar> --list | grep -i "chg\|usb\|high\|cool"
```

Raise the charge-path values (`chg_high_temp`, `usb_protection_temp`,
`temp_high_threshold_*`) the same way if the *charging* dialog is what you are
chasing — each of those has its own real safety purpose.

### A better knob than deleting the cutoff

If the sensor is only *intermittently* lying, the honest fix is not a higher
threshold but a longer debounce. The driver also reads:

| Property | Stock | Purpose |
|---|---|---|
| `battery,temp_check_count` | `20` | consecutive out-of-range samples before acting |
| `battery,adc_check_count` | `5` | raw ADC samples before accepting a value |

Raising those suppresses single-sample glitches while keeping the 70 °C protection
**intact**. That is a strictly safer change than removing the threshold, and this
tool can target those properties with a small edit to the `TARGETS` list.

---

## Why no firmware files

This repo contains no `.img`, `.lz4`, `.tar` or `.tar.md5` — `.gitignore` enforces
it. Two reasons:

1. Samsung firmware is proprietary; redistributing it, even patched, gets repos
   taken down.
2. More importantly, **a patched binary from one build is dangerous on another**.
   Byte offsets move between firmware versions. Hardcoding `8752` — which is exactly
   what the first version of this patch did — silently corrupts anyone on a
   different build. That is why the shipped tool resolves properties by name and
   refuses to write if what it finds does not look like a real temperature.

---

## Known limitations

- **Never flashed.** Structure verified, checksums verified, round trip verified;
  boot behaviour not verified.
- `dtbo.img` carries a signed trailer (`cert1` + hash tree). If the bootloader
  enforces it, a patched dtbo is rejected and the device bootloops. `vbmeta.img`
  on M325FXXSDDYE3 has `flags=0x0` (verification enforced) but lists `boot`,
  `vendor` and `system` — **not** `dtbo`, which is in your favour.
- Only `battery,overheatlimit_threshold` / `_recovery` are targeted.
- ustar only. Not tested against tar formats using pax headers or GNU long names.
- The LZ4 encoder is correct but naive; output is about 13 % larger than Samsung's
  (68,354 vs 60,204 bytes). Irrelevant for dtbo, which has ample partition space.

## License

MIT — see [LICENSE](LICENSE).
