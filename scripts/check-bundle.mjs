import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const script = await readFile(join(root, 'src-tauri/target/release/nsis/x64/installer.nsi'), 'utf8');
for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
  assert.equal(config.bundle.resources['../' + name], name, 'Missing bundle resource: ' + name);
  assert(script.split(String.fromCharCode(10)).some((line) => line.trimStart().startsWith('File ') && line.includes('/oname=' + name)), 'Missing installer resource: ' + name);
  assert((await stat(join(root, name))).size > 0, 'Empty licence: ' + name);
}
const installer = join(root, 'src-tauri/target/release/bundle/nsis/ChessMind_' + config.version + '_x64-setup.exe');
assert((await stat(installer)).size > 0, 'Installer was not built');
console.log('Installer includes LICENSE and THIRD-PARTY-NOTICES.md');
