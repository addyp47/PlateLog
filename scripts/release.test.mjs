import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const sw = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));

test("package.json version matches service worker cache and UI badge", () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.ok(sw.includes(`platelog-shell-v${pkg.version}`), `sw.js should use cache version v${pkg.version}`);
  assert.ok(html.includes(`v${pkg.version}`), `index.html should display v${pkg.version}`);
});

test("manifest.webmanifest defines required PWA fields", () => {
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2);
});
