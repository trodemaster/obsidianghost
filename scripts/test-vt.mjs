// Headless checks for the libghostty-vt WebAssembly adapter (native/ghostty-wasm.ts).
// Runs in plain Node, so CI can run it without Obsidian:  node scripts/test-vt.mjs [path/to/ghostty-vt.wasm]
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const wasmPath = process.argv[2] || join(root, "native", "ghostty-vt.wasm");
const dir = mkdtempSync(join(tmpdir(), "ghostty-vt-test-"));
const outfile = join(dir, "adapter.cjs");

try {
  await build({
    entryPoints: [join(root, "native", "ghostty-wasm.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "es2020",
    outfile,
    logLevel: "silent",
  });
  const { loadGhosttyVtWasm } = createRequire(import.meta.url)(outfile);
  const native = await loadGhosttyVtWasm(readFileSync(wasmPath));
  const checks = {};
  const term = () => native.createTerminal(80, 12);

  checks.version = /^libghostty-vt 1\.\d+\.\d+/.test(native.version());

  let t = term();
  try {
    t.setDefaultColors(0xe6e5e5, 0x0d0d17);
    for (const ch of "\x1b]11;?\x07\x1b]10;?\x1b\\") t.feed(ch);
    checks.colorQueries = t.takeResponses() === "\x1b]11;rgb:0d0d/0d0d/1717\x07\x1b]10;rgb:e6e6/e5e5/e5e5\x1b\\";
    checks.responsesDrained = t.takeResponses() === "";
    t.feed("\x1b[?2027$p\x1b[?2027h\x1b[?2027$p\x1b[?2027l");
    checks.graphemeModeNegotiation = t.takeResponses() === "\x1b[?2027;2$y\x1b[?2027;1$y";
    t.feed("中\x1b[6nZ");
    checks.cursorQueryBeforeLaterOutput = t.takeResponses() === "\x1b[1;3R";
    t.feed("\x1b[c");
    checks.deviceAttributes = /^\x1b\[\?[\d;]+c$/.test(t.takeResponses());

    t.feed("\x1b[2J\x1b[H\x1b[4;33mX\x1b[0mY");
    const runs = t.dumpViewportRowStyleRuns(0);
    checks.attributeRunBoundaries = runs[0].startCol === 1 && runs[0].endCol === 1 &&
      (runs[0].flags & 8) !== 0 && runs[1].startCol === 2 && runs[1].flags === 0 &&
      runs[runs.length - 1].endCol === 80;
    checks.defaultColorsInRuns = runs[1].fg === 0xe6e5e5 && runs[1].bg === 0x0d0d17;
    checks.rowText = t.dumpViewportRow(0) === "XY";

    t.feed("\x1b[2J\x1b[H\x1b[7mI\x1b[0m");
    const inverse = t.dumpViewportRowStyleRuns(0)[0];
    checks.inverseSwapsColors = inverse.fg === 0x0d0d17 && inverse.bg === 0xe6e5e5;

    t.setPalette([[1, 0x112233], [9, 0x445566]]);
    t.feed("\x1b[2J\x1b[H\x1b[31mR\x1b[1;31mB\x1b[0m\x1b[48;2;1;2;3mG\x1b[0m");
    const colored = t.dumpViewportRowStyleRuns(0);
    checks.paletteOverride = colored[0].fg === 0x112233;
    checks.boldBrightensBaseColors = colored[1].fg === 0x445566 && (colored[1].flags & 2) !== 0;
    checks.trueColorBackground = colored[2].bg === 0x010203;

    t.feed("\x1b[2J\x1b[H\x1b]8;;https://example.com/a\x1b\\link\x1b]8;;\x1b\\ plain");
    checks.hyperlinkAt = t.hyperlinkAt(1, 1) === "https://example.com/a" &&
      t.hyperlinkAt(4, 1) === "https://example.com/a" && t.hyperlinkAt(6, 1) === null;

    t.feed("\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\");
    checks.kittyLeftToPlugin = t.takeResponses() === "";

    t.takeDirtyViewportRows(12);
    t.feed("\x1b[5;1Hchanged");
    const dirty = t.takeDirtyViewportRows(12);
    checks.dirtyRowsTracked = dirty.includes(4) && !dirty.includes(8);
    checks.dirtyRowsDrained = t.takeDirtyViewportRows(12).length === 0;

    t.feed("\x1b[?25l");
    checks.hiddenCursorInvalid = t.cursorPosition().valid === false;
    t.feed("\x1b[?25h\x1b[3;7H");
    const cursor = t.cursorPosition();
    checks.cursorPosition = cursor.valid && cursor.col === 7 && cursor.row === 3;
  } finally {
    t.free();
  }

  t = term();
  try {
    t.takeViewportScrollDelta();
    for (let i = 0; i < 100; i++) t.feed(`line ${i}\r\n`);
    t.takeViewportScrollDelta();
    checks.scrollUp = t.scrollViewport(-5) === 0 && t.takeViewportScrollDelta() === -5;
    checks.scrolledContent = t.dumpViewportRow(0) === "line 84";
    checks.scrollToBottom = t.scrollViewport(10000) === 0 && t.takeViewportScrollDelta() === 5;
    checks.cursorHiddenWhenScrolledAway = (t.scrollViewport(-20), !t.cursorPosition().valid);
  } finally {
    t.free();
  }

  t = native.createTerminal(4, 3);
  try {
    t.feed("ab中Z");
    checks.wideWrap = t.dumpViewportRowCells(0).join("") === "ab中" && t.dumpViewportRowCells(1)[0] === "Z";
    checks.wideTailEmpty = t.dumpViewportRowCells(0)[3] === "";
    t.feed("\x1b[2J\x1b[H\u{10eeee}̅̅");
    checks.keepsDiacritics = t.dumpViewportRowCells(0)[0] === "\u{10eeee}̅̅";
    checks.resize = t.resize(6, 2, 22, 45) === 0 && t.dumpViewportRowCells(0).length === 6;
  } finally {
    t.free();
  }

  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  console.log(JSON.stringify({ pass: failed.length === 0, failed, checks }, null, 2));
  if (failed.length) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
