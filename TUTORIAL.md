# Tutorial: patching the overheat cut-out on a Samsung Galaxy M32 (SM-M325F)

Read section 0 and 1 before you download anything. They decide whether the rest of this
document is worth your time.

---

## 0. What this tool is, and what it is not

Samsung's battery driver (`sec_battery`) reads a thermistor and, past a temperature written
into the device tree, forces the phone to power off. On the M32 that number is **70.0 °C**
(`battery,overheatlimit_threshold = 700`, in units of 0.1 °C).

This tool changes that one number in your own firmware file. It does not touch Samsung's
code, it does not need root, and it does not disable thermal protection in general.

**It has not been confirmed to fix anything.** The author built and verified it
byte-for-byte; nobody has flashed it and reported back. Section 1 explains why that
matters for your phone specifically.

Also true:

- Flashing a modified partition trips the **Knox e-fuse**. That is a physical one-time
  fuse, not a software flag. Samsung Pay, Secure Folder and parts of your warranty are
  gone permanently, even if you flash the stock file back afterwards.
- The 70 °C cut-out exists so a failing lithium cell gets powered off instead of
  continuing to heat. Raising it to 200 °C means the phone will keep running while
  genuinely hot. If you do flash this, do not charge unattended and do not use it under a
  pillow.

---

## 1. Ten minutes of checking before you flash

The reason section 0 is that blunt: on the one device this was investigated on, every
sensor read normal at the time of the complaint.

You need a PC and a USB cable. You do **not** need root for any of this.

1. Turn on **Settings → Developer options → USB debugging**. If Developer options is
   missing, tap **Settings → About phone → Software information → Build number** seven
   times first.
2. Install the platform-tools from Samsung/Google
   (`https://developer.android.com/tools/releases/platform-tools`), plug the phone in, and
   run:

```
adb devices
```

The first line should be your serial number followed by `device`. If it says `unauthorized`,
accept the popup on the phone.

Now the four checks:

| Command (PowerShell) | What a healthy answer looks like | What an unhealthy answer looks like |
|---|---|---|
| `adb shell dumpsys battery \| Select-String temperature` | `temperature: 300` … `360` (that is 30.0–36.0 °C, idle) | `temperature: 600`+ while the phone feels cool to the touch |
| `adb shell dumpsys thermalservice \| Select-String "BAT\|SKIN\|AP"` | all sensors within a few degrees of each other | one sensor far above the others, or `0.0` |
| `adb shell getprop ro.boot.bootreason` | anything that is not a temperature reason (the investigated device read `reboot,diwarme_maintenancemode` — a deliberate maintenance reboot) | `reboot,thermal`, or any value naming a temperature or charger trip |
| `adb shell dumpsys battery \| Select-String "voltage\|level"` | 3700–4400 mV at sane percentages | a voltage that collapses when the screen lights up |

How to read them:

- **`dumpsys battery` reports a normal temperature while the phone is powering off** → the
  kernel thinks it is hot but the reported value is fine. That points at the sensor path or
  the lookup table, and this patch may help.
- **`bootreason` ends in `thermal`** → the driver really did trip. This patch addresses the
  symptom; the underlying cause is still there.
- **The phone is genuinely hot** (you can't hold it) → stop. Do not patch. A hot phone that
  shuts down is working correctly.
- **Battery percentage jumps around, or voltage sags under load** → this is the far more
  common cause on an eight-year-old phone. A 5,000 mAh cell that has aged drops below the
  brownout voltage for a split second and the power management IC cuts power. That looks
  exactly like a thermal shutdown, and no device-tree number can fix it. A replacement
  battery for this model is a ~£26 part and a known fix for false-overheat reports on
  M32/4G-class phones.

One more thing worth knowing, because it rules out a whole class of guesses: an
**open-circuit or disconnected thermistor reads cold, not hot** on this NTC table. A
severed sensor wire cannot produce a false overheat reading. Only a shorted or corroded one
(low ADC → high temperature), or a lookup table that does not match the hardware, can. If a
shop "fixed" your phone and this started afterwards, a pinched connector or a swapped
battery with a different thermistor is the suspect.

---

## 2. Get your own firmware file

The tool reads the `dtbo.img.lz4` member out of an AP tar. **It must be the AP file for the
firmware you are actually running** - not a guess, not a neighbouring region's build.

Find your build number:

```
adb shell getprop ro.build.version.incremental   # e.g. M325FXXSDDYE3
adb shell getprop ro.product.model               # e.g. SM-M325F
```

Or on the phone: **Settings → About phone → Software information → Baseband version** —
the build string is in there.

Download the matching **AP** file (it is the largest of the five, roughly 5–7 GB) from a
firmware archive that indexes by model + region + build:

- <https://samfw.com> — pick your exact model, region/CSC, and version.
- <https://sammobile.org> / <https://frija.com> — same idea.

Keep the file where it is; nothing needs to be extracted. `--input` takes the `.tar.md5`
directly and reads only the ~30 MB it needs.

> Do not use someone else's AP file to "test" the tool. Patching reads and writes that
> exact file, and flashing a firmware build for a different CSC or model can leave the
> phone unable to boot.

---

## 3. Get the tool

Go to the **Releases** page of this repository and take the file for your OS. You do not
need Node.js, npm, Python, 7-Zip or any build step.

| You are on | Download |
|---|---|
| Windows 10/11 (64-bit) | `patch-dtbo-windows-x64.exe` |
| Apple Silicon Mac (M1–M4) | `patch-dtbo-macos-arm64` |
| Intel Mac | `patch-dtbo-macos-x64` |
| Linux | `patch-dtbo-linux-x64` |

**Check what you downloaded** before running it (PowerShell):

```powershell
(Get-FileHash .\patch-dtbo-windows-x64.exe -Algorithm SHA256).Hash.ToLower()
```

Compare against `SHA256SUMS.txt` in the same release. On macOS/Linux:
`shasum -a 256 patch-dtbo-macos-arm64` or `sha256sum patch-dtbo-linux-x64`.

The binaries are not code-signed, so:

- **Windows**: SmartScreen says "unauthorised script/unknown publisher" → "More info" →
  "Run anyway". Only do that after the checksum matches.
- **macOS**: Gatekeeper blocks first launch → right-click the file → **Open** → **Open**,
  or `xattr -d com.apple.quarantine ./patch-dtbo-macos-arm64`.
- **Linux**: `chmod +x patch-dtbo-linux-x64`.

Alternative, if you already have Node 18+: download `patch-dtbo.mjs` from the release and
run `node patch-dtbo.mjs ...` in place of the binary in every command below. Or, if you
want the source: `npm install -g m32-thermal-patch`, then `patch-dtbo ...`.

---

## 4. Look first, without changing anything

Open PowerShell (Windows) or Terminal (macOS/Linux), `cd` to the folder holding the AP file,
and run the **read-only** listing. `--list` never writes a file.

```powershell
.\patch-dtbo-windows-x64.exe --input .\AP_M325FXXSDDYE3.tar.md5 --list
```

Output on the M32 with firmware M325FXXSDDYE3 looks like this:

```
input archive : AP_M325FXXSDDYE3.tar.md5
member        : dtbo.img.lz4 (60204 bytes, lz4 frame)
DTB structures: @96 (87246 B), @87342 (87187 B)

locating targets:
  DTB@96      battery,overheatlimit_threshold      now=700    (70.0 C)  @8752 len=4
  DTB@96      battery,overheatlimit_recovery       now=680    (68.0 C)  @8768 len=4
  DTB@87342   battery,overheatlimit_threshold      now=700    (70.0 C)  @95998 len=4
  DTB@87342   battery,overheatlimit_recovery       now=680    (68.0 C)  @96014 len=4
```

What to check in that output:

- **`now=700 (70.0 C)`** — the stock value. If it says `now=2000`, your file is already
  patched; do not patch it again.
- **Two `DTB@` lines** — the M32 dtbo contains two overlay trees and the tool must patch
  both. Patching one leaves the other authoritative at boot.
- **`--list` also prints every thermal property it can find.** Read them. The patch moves
  `overheatlimit_*`; these other numbers are what actually stop *charging* and *throttle*
  the CPU, and they are unchanged by this tool:

| Property | Stock | What it does |
|---|---|---|
| `battery,overheatlimit_threshold` | 700 = 70.0 °C | **forced power-off** ← this is what we raise |
| `battery,overheatlimit_recovery` | 680 = 68.0 °C | where the driver will let the phone boot again |
| `battery,usb_protection_temp` | 610 = 61.0 °C | stops USB charging |
| `battery,wire_warm_overheat_thresh` | 500 = 50.0 °C | "phone is too hot to charge" popup |
| `battery,temp_high_threshold_*` | 500 / 480 | charging throttling bands |
| `battery,temp_highlimit_*` | 800 / 780 | other high-temperature cut bands |
| `battery,temp_check_count` | 20 | how many consecutive hot reads before acting |
| `battery,adc_check_count` | 5 | ADC debounce count |

**If a noisy sensor is the problem, `temp_check_count` and `adc_check_count` are the safer
fix** — raising the debounce means one glitchy sample cannot trigger anything, without
removing the cut-out at 70 °C. `--threshold/--recovery` are the only knobs this build
exposes; if you come here wanting to change those instead, open an issue and say so.

---

## 5. Patch it

```powershell
.\patch-dtbo-windows-x64.exe --input .\AP_M325FXXSDDYE3.tar.md5 --apply
```

Wait for the tail of the output:

```
patched 4 properties; 8 bytes changed, all inside those properties; image size unchanged (178752)
artifact      : out\AP_dtbo_patched.tar.md5 (68354 B member, 70198 B archive) md5=5d9981a1...

verification - re-parsed out\AP_dtbo_patched.tar.md5:
  properties in tree: 3929 -> 3929
  properties changed: 4 (expected 4)
    ... battery,overheatlimit_threshold = u32=2000
    ... battery,overheatlimit_recovery = u32=1980

OK: every other property in the device tree is byte-identical to your input.
```

That last block is not decoration. The tool re-reads the file it just wrote, decodes it
again, and refuses to exit successfully unless (a) the property count is unchanged, (b)
exactly the intended properties differ, and (c) nothing else moved. If you ever see
`VERIFICATION FAILED`, delete `out/` and do not flash anything.

Pick your number deliberately. Defaults are 2000/1980 (200.0 °C) which is effectively
"never". If you want the cut-out to stay meaningful, choose something like 850 (85 °C):

```powershell
.\patch-dtbo-windows-x64.exe --input .\AP_M325FXXSDDYE3.tar.md5 --apply --threshold 850 --recovery 830
```

The tool refuses values below 0 or above 4000, and refuses to run at all if the value it
found is not in 0–1200, precisely so a mistaken double-patch cannot produce a nonsense
limit.

Result: `out/AP_dtbo_patched.tar.md5`, about 70 KB. Your 5 GB input file is untouched.

---

## 6. Flash it

You need **Odin** (Samsung's own download-mode flasher; v3.14.1 or the newer 3.14.4 both
work), a good USB cable, a USB port on the back of a desktop if you have one, and the
Samsung USB drivers (installed with the Smart Switch desktop app if you don't have them).

1. **Charge the phone above 50 %.** A flash that dies halfway is the classic way to end up
   with a brick. This is not superstition: the write is to the partition table's AP slot and
   there is no resumable path.
2. Power the phone off completely.
3. Hold **Volume Down**, and while holding it, plug in the USB cable. The warning screen
   appears. Press **Volume Up** once to continue into Downloading mode.
4. Launch Odin **as Administrator** (Windows). You should see `Android Signature` /
   `COMx: [LSB_AND...]` in the top-left box. If it says "Detect" never happened, you have a
   driver or cable problem — fix that before continuing.
5. Click **AP** and select `out\AP_dtbo_patched.tar.md5`.
   Leave **BL**, **CSC** and **HOME_CSC** empty. Do **not** tick **Re-Partition**. Do not
   tick **FOTA** update either.
6. Everything else stays default (`Auto Reboot` + `F. Reset Time` on). Click **Start**.
7. The write itself is short - the payload is 70 KB, not the 5 GB archive it came from - and
   Odin ends with a green **PASS** and `All threads completed..!!`. The phone reboots on its
   own. First boot takes longer than usual; leave it alone for a few minutes.

If Odin shows a red **FAIL!** or `[FAIL] ... INVALID_...`, the phone is still in Downloading
mode. The most common cause is a checksum mismatch on the tar (`MD5 verification failed`) -
which means the file was corrupted in transit, not that this tool mis-patched it. Re-run
section 5 and re-download if needed.

---

## 7. Did it take?

With the phone booted and USB debugging on:

```powershell
adb shell getprop ro.build.version.incremental   # still your build number?
adb shell dumpsys thermalservice | Select-String "Thermal Status|BAT|SKIN"
```

Be honest about what you can and cannot see without root:

- **Without root you cannot read back the device tree.** `/proc/device-tree` and
  `/sys/class/thermal/*/*temp` are root-only on this firmware (verified: `Permission denied`
  as shell). So you can confirm the phone boots normally on the same build and that thermal
  reporting still works, but you cannot print `2000` from the running phone.
- **With root (Magisk/TWRP)** the confirmation is direct:

```sh
find /proc/device-tree -name "*overheatlimit*"
od -An -tu4 $(find /proc/device-tree -name "battery,overheatlimit_threshold" | head -1)
# expect: 2000
```

So the real test is behavioural: use the phone for a few days and see whether the false
power-offs stopped. If they stopped, you have your answer. If they continued, the patch was
not the fix and section 8 is what you want.

---

## 8. Rollback

Power off, back into Downloading mode (Volume Down + plug, then Volume Up), and flash the
**original AP file from section 2** in the AP slot. That restores the stock device tree
byte-for-byte, because you only ever wrote a modified copy of a file you still own.

Knox stays tripped. Nothing restores it.

---

## 9. If something went wrong

| Symptom | Meaning | Do |
|---|---|---|
| `no "dtbo.img*" member found` | you passed a BL/CP/CSC tar, not the AP one | use the AP file; the member list is in section 2 |
| `no valid DTB found in image` | that file is not a dtbo image | you passed the wrong file |
| `current value 2000 is outside 0..1200 … refusing` | this file is already patched | don't patch twice; flash the artifact you already have |
| `requested value 99999 is implausible` | typo in `--threshold` | realistic range is 0–4000 (0.1 °C units) |
| Windows "Windows protected your PC" | unsigned binary, expected | checksum, then More info → Run anyway |
| `macOS cannot be opened` | quarantine | right-click → Open, or `xattr -d com.apple.quarantine` |
| Odin `MD5 verification failed` | truncated download or corrupted copy | re-download, compare checksums, re-run section 5 |
| Odin shows nothing on COM port | drivers/cable | different cable/port, reinstall drivers, run Odin as admin |
| Phone stuck on logo after flash | bad flash or mismatched build | reflash the **stock** AP file (section 8); if that fails, flash all five stock tars in BL/AP/CP/CSC/HOME_CSC |

---

## 10. Tell everyone what happened

This is the part that makes the next person's day cheaper. Open an issue with:

- model and **exact** build number (`adb shell getprop ro.build.version.incremental`)
- the full `--list` output — it contains no serial, no account, no personal data
- whether you flashed it, and what the phone did afterwards
- if the shutdowns continued: what `dumpsys battery` and `ro.boot.bootreason` said at the
  moment it happened

Also worth adding: whether a battery swap solved it. If your firmware has a different
layout than section 4 shows, say so - that is how this table grows.
