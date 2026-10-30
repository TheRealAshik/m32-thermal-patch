// Builds a Single Executable Application so users do not need Node.js installed.
//
//   node tools/build-sea.mjs --node /path/to/node --target win    # repo root
//
// Node's SEA flow is three steps: prepare a blob from a CJS entry, copy the Node
// binary, then inject the blob at the binary's NODE_SEA_FUSE sentinel. The sentinel is
// one exact 46-character string followed by ':' and '0'; guessing it is the usual way
// this build fails, so it is read out of the binary that is being patched.

import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
};

const NODE_BIN = resolve(arg('node', process.execPath));
const TARGET = arg('target', process.platform);
const DIST = join(ROOT, 'dist');
// CI passes --out so each platform job uploads a uniquely named file; the default follows
// the same convention so a local build and a release build produce the same artifact name.
const PLAT_LABEL = { win32: 'windows', darwin: 'macos', linux: 'linux' };
const label = PLAT_LABEL[TARGET];
if (!label) throw new Error(`unknown --target ${TARGET} (expected win32, darwin or linux)`);
const NAME = arg('out', `patch-dtbo-${label}-${process.arch}${TARGET === 'win32' ? '.exe' : ''}`);
if (TARGET === 'win32' && !NAME.endsWith('.exe')) {
  console.warn(`warning: --out ${NAME} has no .exe suffix; Windows users will not be able to double-click it`);
}
const OUT = join(DIST, NAME);

if (!statSync(NODE_BIN).isFile()) {
  throw new Error(`--node ${NODE_BIN} is not a file. On Windows give the full path, e.g. "C:\\Program Files\\nodejs\\node.exe"`);
}

// npx is an shim on Windows and must go through the shell, which then needs every path
// with a space quoted - the usual Node install path "C:\Program Files\nodejs" is exactly
// where an unquoted command breaks.
const run = (cmd, args) => {
  const shell = process.platform === 'win32';
  const quote = (s) => (/[ "&^|]/.test(s) ? `"${s}"` : s);
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = shell
    ? spawnSync([quote(cmd), ...args.map(quote)].join(' '), { cwd: ROOT, stdio: 'inherit', shell: true })
    : spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
};

// 1. blob - built from the CJS bundle, because SEA executes CommonJS.
run(process.execPath, ['tools/bundle.mjs']);
run(process.execPath, ['--experimental-sea-config', 'tools/sea-config.json']);

// 2. copy the runtime in place of the output name.
copyFileSync(NODE_BIN, OUT);
if (TARGET === 'darwin') {
  // Injecting into a signed Mach-O invalidates the signature and postject refuses to
  // touch it, so strip first and re-sign ad-hoc afterwards.
  run('codesign', ['--remove-signature', OUT]);
}

// 3. sentinel straight from the bytes being patched.
const binary = readFileSync(OUT);
const at = binary.indexOf('NODE_SEA_FUSE');
if (at === -1) throw new Error(`${NODE_BIN} has no NODE_SEA_FUSE sentinel - this Node build does not support Single Executable Applications`);
const end = binary.indexOf(0x3a, at); // ':'
const fuse = binary.subarray(at, end).toString('latin1');
if (!/^NODE_SEA_FUSE_[0-9a-f]{32}$/.test(fuse)) throw new Error(`sentinel read from ${NODE_BIN} looks wrong: ${JSON.stringify(fuse)}`);

const postject = ['postject', OUT, 'NODE_SEA_BLOB', join(DIST, 'patch-dtbo.blob'), '--sentinel-fuse', fuse];
if (TARGET === 'darwin') postject.push('--macho-segment-name', 'NODE_SEA');
run('npx', ['--yes', ...postject]);

if (TARGET === 'darwin') run('codesign', ['--sign', '-', '--force', OUT]);

console.log(`\nbuilt ${NAME} (${(statSync(OUT).size / 1048576).toFixed(1)} MiB) from Node ${process.version} at ${NODE_BIN}`);
console.log('Unsigned binaries: Windows SmartScreen and macOS Gatekeeper will warn on first run. The fuse was ' + fuse);
