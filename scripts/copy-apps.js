const fs = require('fs');
const path = require('path');

const appsDir = path.resolve(__dirname, '..', 'apps');
const distDir = path.resolve(__dirname, '..', 'dist');

const SKIP = new Set(['config.yaml']);

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    entry.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

for (const folder of fs.readdirSync(appsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)) {

  copyDir(path.join(appsDir, folder), path.join(distDir, folder));
  console.log(`Copied apps/${folder} → dist/${folder}/`);
}
