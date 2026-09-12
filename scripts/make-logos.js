#!/usr/bin/env node
'use strict';

/**
 * Turn the source artwork into the two assets the app actually serves.
 *
 *   npm run make-logos
 *
 * design/blueman.png is 1254x1254 and 2 MB — fine as a master, far too heavy
 * to send on every page load for a 32px mark. This writes:
 *
 *   public/logo.png  512px, for the hero on the landing page
 *
 * The artwork appears there and nowhere else. It is a detailed square — three
 * faces, a chalkboard, a helmet — which needs room; shrunk into a 32px header
 * slot it is an unreadable blue smudge, so the header keeps a plain mark.
 *
 * Needs Pillow:  pip install Pillow
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const root = path.join(__dirname, '..');

const PY = `
from PIL import Image
import os
src = Image.open(r"${path.join(root, 'design/blueman.png')}").convert("RGBA")
w, h = src.size

full = src.resize((512, 512), Image.LANCZOS)
full.save(r"${path.join(root, 'public/logo.png')}", optimize=True)


for f in ("public/logo.png",):
    p = os.path.join(r"${root}", f)
    im = Image.open(p)
    print(f"  {f:22} {im.size[0]}x{im.size[1]}  {os.path.getsize(p)//1024} KB")
`;

try {
  console.log('\nBuilding logo assets from design/blueman.png\n');
  console.log(execFileSync('python3', ['-c', PY], { encoding: 'utf8' }));
} catch (err) {
  console.error('\n✖ Could not build the logos.');
  console.error('  This needs Pillow:  pip install Pillow\n');
  console.error(String(err.stderr || err.message).trim(), '\n');
  process.exit(1);
}
