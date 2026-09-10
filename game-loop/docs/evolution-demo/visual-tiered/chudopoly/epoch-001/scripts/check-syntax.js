const { execFileSync } = require('child_process');
const { readdirSync, readFileSync, existsSync } = require('fs');
const { join } = require('path');

// '.' is intentionally non-recursive (node_modules); named roots recurse.
const shallowRoots = ['.'];
const deepRoots = ['server', 'scripts', 'test', 'tools', 'public/js', 'public/src'];

function checkFile(file) {
  if (file.endsWith('.mjs')) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  } else if (file.startsWith(join('public', 'src'))) {
    // .js ES modules: --check alone would parse them as CommonJS.
    execFileSync(process.execPath, ['--input-type=module', '--check'], {
      input: readFileSync(file), stdio: ['pipe', 'inherit', 'inherit'],
    });
  } else {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  }
}

function walk(root, recurse) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) {
      if (recurse && entry.name !== 'node_modules' && entry.name !== 'fixtures' && entry.name !== 'shots') walk(file, true);
      continue;
    }
    if (!entry.isFile() || !/\.(js|mjs)$/.test(entry.name)) continue;
    try {
      checkFile(file);
    } catch (err) {
      console.error(`Syntax check failed: ${file}`);
      process.exit(1);
    }
  }
}

shallowRoots.forEach(r => walk(r, false));
deepRoots.forEach(r => walk(r, true));
console.log('Syntax check passed.');
