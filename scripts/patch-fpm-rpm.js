const fs = require('fs');
const os = require('os');
const path = require('path');

// Homebrew's rpm (6.x) ignores fpm's "--define buildroot ..." override and
// resolves its own internal build root, so every file in %files comes back
// "not found". Only the deprecated "--buildroot" CLI flag still works. fpm
// (bundled by electron-builder, last updated 2015) never got fixed for this.
const BROKEN = '"--define", "buildroot #{build_path}/BUILD",';
const FIXED = '"--buildroot", "#{build_path}/BUILD",';

if (process.platform !== 'darwin') process.exit(0);

const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'electron-builder', 'fpm');
if (!fs.existsSync(cacheDir)) process.exit(0);

for (const entry of fs.readdirSync(cacheDir)) {
  const rpmRb = path.join(cacheDir, entry, 'lib/app/lib/fpm/package/rpm.rb');
  if (!fs.existsSync(rpmRb)) continue;
  const original = fs.readFileSync(rpmRb, 'utf8');
  if (!original.includes(BROKEN)) continue;
  fs.writeFileSync(rpmRb, original.replace(BROKEN, FIXED));
  console.log(`Patched ${rpmRb} for rpm 6.x --buildroot compatibility`);
}
