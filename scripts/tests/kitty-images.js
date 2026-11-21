// Run with npm run test:images (optional vault argument defaults to daneel).
// The probe upgrades ONLY a new shell-only leaf; it never reloads active agents.
(async () => {
  const { KittyGraphics, GhosttyTerminalView, terminalRowCells, decodeImageCell, native, parseGhosttyConfig } = globalThis.ghosttyImageTestModule;
  const plugin = app.plugins.getPlugin("obsidian-claude-ghostty");
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const checks = {};
  const replies = [];
  const graphics = new KittyGraphics(() => {}, (data) => replies.push(data));
  const source = document.createElement("canvas");
  source.width = 2; source.height = 2;
  const sourceCtx = source.getContext("2d");
  sourceCtx.fillStyle = "#ff0000"; sourceCtx.fillRect(0, 0, 1, 1);
  sourceCtx.fillStyle = "#00ff00"; sourceCtx.fillRect(1, 0, 1, 1);
  sourceCtx.fillStyle = "#0000ff"; sourceCtx.fillRect(0, 1, 1, 1);
  sourceCtx.fillStyle = "#ffffff"; sourceCtx.fillRect(1, 1, 1, 1);
  const png = source.toDataURL("image/png").split(",")[1];
  const command = (c, payload = "") => `\x1b_G${c};${payload}\x1b\\`;
  const upload = command("a=T,U=1,i=31,c=2,r=2,f=100,m=1,q=2", png.slice(0, 40)) +
    command("m=0", png.slice(40));
  for (const cp of upload) graphics.feed(cp);
  await wait(100);
  checks.chunkedPngLoaded = graphics.images.get(31)?.image.naturalWidth === 2;
  checks.quietHasNoReplies = replies.length === 0;
  const canvas = document.createElement("canvas");
  canvas.width = 20; canvas.height = 20;
  const ctx = canvas.getContext("2d");
  for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) {
    graphics.drawCell(ctx, { id: 31, row, col }, col * 10, row * 10, 10, 10);
  }
  const pixel = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data).join(",");
  checks.renderedPixelColors = pixel(2, 2) === "255,0,0,255" &&
    pixel(17, 2) === "0,255,0,255" && pixel(2, 17) === "0,0,255,255" &&
    pixel(17, 17) === "255,255,255,255";
  graphics.feed(command("a=d,d=i,i=31,q=2"));
  checks.deletePlacementRetainsImage = !graphics.placements.has(31) && graphics.images.has(31);
  graphics.feed(command("a=p,U=1,i=31,c=4,r=2,q=2"));
  checks.resizePlacement = graphics.placements.get(31)?.cols === 4;
  graphics.feed(command("a=d,d=I,i=31,q=2"));
  checks.deleteImage = !graphics.images.has(31) && graphics.bytes === 0;
  graphics.feed(command("a=T,U=1,i=31,c=2,r=2,f=100,q=2", png));
  graphics.feed(command("a=d,d=A,q=2"));
  await wait(100);
  checks.deletingDuringDecode = graphics.images.size === 0 && graphics.placements.size === 0 && graphics.bytes === 0;
  graphics.feed("\x1b]2;" + command("a=T,U=1,i=31,c=2,r=2,f=100,q=2", png) + "\x07");
  checks.oscPayloadNotAnImage = graphics.images.size === 0;
  const oversized = Buffer.from(png, "base64");
  oversized.writeUInt32BE(16384, 16); oversized.writeUInt32BE(16384, 20);
  graphics.feed(command("a=t,i=99,f=100", oversized.toString("base64")));
  checks.memoryLimitError = replies.some((data) => data.includes("i=99;ENOMEM")) && graphics.images.size === 0;
  graphics.feed(command("a=t,i=99,f=32", png));
  checks.unsupportedFormatError = replies.some((data) => data.includes("i=99;ENOTSUP"));
  graphics.feed(command("a=t,i=99,f=100", "????"));
  checks.invalidBase64Error = replies.some((data) => data.includes("i=99;EINVAL:invalid base64"));
  graphics.feed(command("a=q,i=32,f=100", png));
  await wait(100);
  checks.queryReply = replies.some((data) => data.includes("i=32;OK")) && !graphics.images.has(32);
  const cells = terminalRowCells("x\u{10eeee}\u0305\u030d\u030dZ", 4);
  const first = decodeImageCell(cells[1], 31);
  checks.placeholderCellAlignment = cells[2] === "Z" && first.id === 0x100001f && first.row === 0 && first.col === 1;
  checks.implicitColumn = decodeImageCell("\u{10eeee}", 31, first).col === 2;
  checks.combiningText = terminalRowCells("e\u0301x", 2).join("") === "e\u0301x";

  const before = new Set(app.workspace.getLeavesOfType("ghostty-terminal-view"));
  let leaf;
  let diagnostic;
  try {
    await plugin.openNewTerminal(undefined, { shellOnly: true });
    leaf = app.workspace.getLeavesOfType("ghostty-terminal-view").find((item) => !before.has(item));
    const view = leaf.view;
    const exited = new Promise((resolve) => view.pty.onExit(resolve));
    view.stopSession();
    await exited;
    view.contentEl.empty();
    Object.setPrototypeOf(view, GhosttyTerminalView.prototype);
    const testPlugin = Object.create(plugin);
    testPlugin.settings = { ...plugin.settings, agentCommands: {} };
    testPlugin.consumeShellOnlyFlag = () => true;
    testPlugin.terminalFont = parseGhosttyConfig();
    view.plugin = testPlugin;
    view.fontLoadPromise = null;
    await view.ensureFontLoaded();
    view.startSession(native);
    await wait(200);
    // Feed through the real PTY callback, including native VT storage, style runs,
    // browser decoding, canvas redraw, and placement encoded in RGB foreground.
    const placeholders = `\x1b[38;2;0;0;31m\u{10eeee}\u0305\u0305\u{10eeee}\u0305\u030d\r\n` +
      `\u{10eeee}\u030d\u0305\u{10eeee}\u030d\u030d\x1b[0m\r\nIMAGE_READY\r\n`;
    const output = "\x1b[2J\x1b[H" + upload + placeholders;
    const encoded = Buffer.from(output).toString("base64");
    view.pty.write(`printf '%s' '${encoded}' | /usr/bin/base64 -D\r`);
    await wait(400);
    view.renderFrame();
    diagnostic = {
      rows: Array.from({ length: 6 }, (_, row) => view.vt.dumpViewportRow(row)),
      imageIds: Array.from(view.graphics.images.keys()),
      size: view.viewportSize,
    };
    checks.nativeKeepsDiacritics = view.vt.dumpViewportRowCells(0)[0] === "\u{10eeee}\u0305\u0305";
    const { width, height } = view.getCharSize();
    const dpr = view.devicePixelRatio;
    const rendered = view.canvasContext.getImageData(Math.floor(width * .25 * dpr), Math.floor((height - width * .5) * dpr), 1, 1).data;
    checks.ptyCanvasImage = rendered[0] > 200 && rendered[1] < 30 && rendered[2] < 30;
    checks.followingTextAligned = view.vt.dumpViewportRow(2).startsWith("IMAGE_READY");
    // Image follows native viewport rows rather than an absolute DOM overlay.
    view.vt.feed("\x1b[H\x1b[M");
    view.scheduleRender(true);
    await wait(80);
    const moved = view.canvasContext.getImageData(Math.floor(width * .25 * dpr), Math.floor(width * .5 * dpr), 1, 1).data;
    checks.imageMovesWithText = moved[2] > 200 && moved[0] < 30;
  } finally {
    leaf?.detach();
    graphics.dispose();
  }
  return { pass: Object.values(checks).every(Boolean), checks, diagnostic };
})();
