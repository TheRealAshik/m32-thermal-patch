// Dependency-free bundler: src/*.mjs -> one self-contained ESM file.
//
// The release artifact must run with `node patch-dtbo.mjs` (nothing to install) and be
// injectable into a Single Executable Application. Both need a single file, so the
// module graph is flattened by rewriting `export` declarations into names and
// `import {a, b} from './x.mjs'` into references to that module's namespace object.
//
// Deliberately strict: an import we cannot resolve aborts the build instead of
// producing a bundle that silently runs with with half its code missing.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');
const ENTRY = join(SRC, 'patch-dtbo.mjs');

const nsOf = (file) => 'ns_' + basename(file, '.mjs').replace(/[^A-Za-z0-9_]/g, '_');

const modules = new Map(); // abs path -> { ns, deps }

// Every import statement in this project is either a sibling under src/ (inlined into
// a closure, so its bindings must be re-pointed at that closure) or a node: builtin
// (hoisted to the top of the bundle, where `import` is still legal).
const ANY_IMPORT_RE = /^import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"];?\s*$/gm;

function collect(file) {
  const abs = resolve(file);
  if (modules.has(abs)) return;
  const src = readFileSync(abs, 'utf8');
  const deps = [...src.matchAll(ANY_IMPORT_RE)]
    .filter((m) => m[2].startsWith('./'))
    .map((m) => resolve(dirname(abs), m[2]));
  modules.set(abs, { ns: nsOf(abs), deps });
  for (const d of deps) collect(d);
}
collect(ENTRY);

// Each module body is flattened into a closure, so a top-level `import` inside it is no
// longer legal. ESM output therefore hoists every builtin import into one block at the top
// of the file; CJS output replaces it in place with `require()`, which is legal anywhere -
// and CJS is what a Single Executable Application executes.
function render(abs, style, builtins) {
  const { ns } = modules.get(abs);
  const exported = new Set();
  let body = readFileSync(abs, 'utf8')
    .replace(/^#!.*\n/, '')
    .replace(/\/\/# sourceMappingURL.*$/gm, '');

  body = body.replace(ANY_IMPORT_RE, (_m, names, spec) => {
    const list = names.replace(/\s+/g, ' ').trim();
    if (!spec.startsWith('./')) {
      if (style === 'cjs') return `const { ${list} } = require('${spec}');`;
      if (!builtins.has(spec)) builtins.set(spec, new Set());
      for (const n of list.split(',').map((s) => s.trim()).filter(Boolean)) builtins.get(spec).add(n);
      return '';
    }
    const target = resolve(dirname(abs), spec);
    if (!modules.has(target)) {
      throw new Error(`${basename(abs)} imports "${spec}" which is not a module under src/ - refusing to bundle a partial binary`);
    }
    return `const {${list}} = ${nsOf(target)};`;
  });
  if (/(^|\n)\s*import\s+/.test(body)) {
    throw new Error(`${basename(abs)} uses an import form this bundler does not handle (default, namespace, or side-effect)`);
  }

  body = body.replace(/^export\s+(async\s+)?function\s+([A-Za-z0-9_$]+)/gm, (_m, as, name) => {
    exported.add(name);
    return `${as ? 'async ' : ''}function ${name}`;
  });
  body = body.replace(/^export\s+(const|let|var|class)\s+([A-Za-z0-9_$]+)/gm, (_m, kind, name) => {
    exported.add(name);
    return `${kind} ${name}`;
  });

  if (basename(abs) === basename(ENTRY)) {
    // The CLI runs at import time, so it must not be wrapped in a lazy closure.
    return `// ==== src/${basename(abs)} (entry point, executes immediately) ====\n${body}\n`;
  }
  const indented = body.split('\n').map((l) => (l.length ? '  ' + l : l)).join('\n');
  return `// ==== src/${basename(abs)} ====\nconst ${ns} = (() => {\n${indented}\n  return { ${[...exported].join(', ')} };\n})();\n`;
}

// Dependencies first (they are only referenced inside closures, but keep it readable).
const ordered = [...modules.keys()].filter((p) => p !== ENTRY).concat(ENTRY);
const banner = '// GENERATED FILE - do not edit.\n// Built from src/ by tools/bundle.mjs. Edit the files in src/ and re-run this build.\n';

mkdirSync(join(ROOT, 'dist'), { recursive: true });
for (const [style, file] of [['esm', 'patch-dtbo.mjs'], ['cjs', 'patch-dtbo.cjs']]) {
  const builtins = new Map();
  const parts = ordered.map((p) => render(p, style, builtins)).join('\n');
  const hoisted = [...builtins.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([spec, names]) => `import { ${[...names].sort().join(', ')} } from '${spec}';`)
    .join('\n');
  const shebang = style === 'esm' ? '#!/usr/bin/env node\n' : '';
  const out = `${shebang}${banner}\n${hoisted ? hoisted + '\n\n' : ''}${parts}`;
  const target = join(ROOT, 'dist', file);
  writeFileSync(target, out);
  console.log(`bundled ${ordered.length} modules (${style}) -> dist/${file} (${out.length} bytes)`);
}
