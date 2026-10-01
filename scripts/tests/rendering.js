(async () => {
  const {
    GhosttyTerminalView, native, parseGhosttyConfig, parseStyleRuns,
    readFontMetrics, readFontNames, terminalMetrics, fixture, fixtureMetrics,
  } = globalThis.ghosttyImageTestModule;
  const plugin = app.plugins.getPlugin("obsidian-claude-ghostty");
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const checks = {};
  const font = parseGhosttyConfig();
  const meta = readFontMetrics(require("fs").readFileSync(font.filePath));
  checks.resolvesConfiguredFamily = readFontNames(require("fs").readFileSync(font.filePath))
    .names.includes("SauceCodePro Nerd Font Mono");
  checks.realFontFaces = font.faces.length === 4 && font.faces.every((face) => face.filePath) &&
    new Set(font.faces.map((face) => face.filePath)).size === 4;
  checks.retinaMetrics = JSON.stringify(terminalMetrics(10.8, 18, 2, meta)) ===
    JSON.stringify({ width: 11, height: 22.5, baseline: 17.5 });
  const malformed = Buffer.alloc(12);
  malformed.writeUInt16BE(100, 4);
  try { readFontMetrics(malformed); checks.rejectTruncatedFont = false; }
  catch { checks.rejectTruncatedFont = true; }
  const query = native.createTerminal(80, 12);
  try {
    query.setDefaultColors(0xe6e5e5, 0x0d0d17);
    for (const cp of "\x1b]11;?\x07\x1b]10;?\x1b\\") query.feed(cp);
    const colors = query.takeResponses();
    checks.colorQueries = colors === "\x1b]11;rgb:0d0d/0d0d/1717\x07\x1b]10;rgb:e6e6/e5e5/e5e5\x1b\\";
    checks.responsesDrained = query.takeResponses() === "";
    query.feed("\x1b[?2027$p\x1b[?2027h\x1b[?2027$p\x1b[?2027l");
    checks.graphemeModeNegotiation = query.takeResponses() === "\x1b[?2027;2$y\x1b[?2027;1$y";
    query.feed("中\x1b[6nZ");
    checks.cursorQueryBeforeLaterOutput = query.takeResponses() === "\x1b[1;3R";
    query.feed("\x1b[2J\x1b[H\x1b[4;33mX\x1b[0mY");
    const runs = parseStyleRuns(query.dumpViewportRowStyleRuns(0));
    checks.attributeRunBoundaries = runs[0].startCol === 1 && runs[0].endCol === 1 &&
      (runs[0].flags & 8) !== 0 && runs[1].startCol === 2 && runs[1].flags === 0;
    query.resize(4, 3);
    query.feed("\x1b[2J\x1b[Hab中Z");
    checks.wideWrap = query.dumpViewportRowCells(0).join("") === "ab中" &&
      query.dumpViewportRowCells(1)[0] === "Z";
  } finally { query.free(); }

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
    testPlugin.settings = { ...plugin.settings, startupCommand: "" };
    testPlugin.consumeShellOnlyFlag = () => true;
    testPlugin.terminalFont = font;
    view.plugin = testPlugin;
    view.fontLoadPromise = null;
    await view.ensureFontLoaded();
    view.startSession(native);
    await wait(250);
    view.pty.write("printf 'COLOR_%s\\n' \"$COLORTERM\"\r");
    for (let i = 0; i < 30 && !view.vt.dumpViewport().includes("COLOR_truecolor"); i++) await wait(100);
    checks.trueColorEnvironment = view.vt.dumpViewport().includes("COLOR_truecolor");
    view.vt.feed("\x1b[2J\x1b[H" + fixture);
    view.scheduleRender(true);
    await wait(100);
    const cells = view.vt.dumpViewportRowCells(0);
    checks.wideCjkCell = cells[1] === "中" && cells[2] === "" && cells[3] === "B";
    checks.combiningCell = cells[5] === "e\u0301";
    checks.zwjEmoji = cells[7] === "👩‍💻" && cells[8] === "" && cells[10] === "Z";
    checks.flagEmoji = cells[12] === "🇺🇸" && cells[13] === "";
    checks.skinToneEmoji = cells[17] === "👍🏽" && cells[18] === "";
    checks.variationSelector = cells[22] === "❤️" && cells[23] === "";
    view.selectionAnchor = { col: 3, row: 1 };
    view.selectionFocus = { col: 4, row: 1 };
    checks.selectionStartsOnWideTail = view.getSelectedText() === "中B";
    view.clearSelection();
    const url = view.findPlainUrlLinkAt(7, 2);
    checks.urlAfterWidePrefix = url?.startCol === 7 && url.uri === "https://example.com/😀";
    checks.urlEndHitTesting = !!url &&
      view.findPlainUrlLinkAt(url.endCol - 1, 2)?.uri === url.uri &&
      view.findPlainUrlLinkAt(url.endCol, 2) === null;
    const { width, height, baseline } = view.getCharSize();
    const dpr = view.devicePixelRatio;
    checks.devicePixelGrid = [width, height, baseline].every((metric) => Number.isInteger(metric * dpr));
    if (fixtureMetrics) {
      checks.measuredGhosttyCellParity = width * dpr === fixtureMetrics.width &&
        height * dpr === fixtureMetrics.height;
    }
    const pixel = (col, row) => {
      const rgba = view.canvasContext.getImageData(Math.floor((col + .1) * width * dpr),
        Math.floor((row + .1) * height * dpr), 1, 1).data;
      return (rgba[0] << 16) | (rgba[1] << 8) | rgba[2];
    };
    checks.inlineCodeBackground = pixel(0, 2) === 0x242c37 && pixel(17, 2) === 0x0d0d17;
    checks.inputBackground = pixel(0, 3) === 0x131b23;
    const styles = parseStyleRuns(view.vt.dumpViewportRowStyleRuns(4));
    checks.boldItalicAttributes = styles.some((run) => (run.flags & 6) === 6);
    const faint = parseStyleRuns(view.vt.dumpViewportRowStyleRuns(5));
    checks.faintAndBrightColors = !!(faint[0].flags & 16) && faint.some((run) => run.fg === 0x6096ff);
    const ctx = view.canvasContext;
    const boxPixels = Math.max(1, Math.ceil(meta.underlineThickness / meta.unitsPerEm * font.size * dpr));
    const centerY = Math.round(6 * height * dpr) + Math.floor((height * dpr - boxPixels) / 2);
    let connected = true;
    for (let x = 2 * width * dpr; x < 4 * width * dpr; x++) {
      const p = ctx.getImageData(Math.floor(x), centerY, 1, 1).data;
      if (((p[0] << 16) | (p[1] << 8) | p[2]) !== 0xe6e5e5) connected = false;
    }
    checks.boxLinesHaveNoPixelGaps = connected;
    checks.fontBasedBoxStroke = boxPixels === 2 &&
      ctx.getImageData(Math.round(3 * width * dpr), centerY + 1, 1, 1).data[0] === 0xe6 &&
      ctx.getImageData(Math.round(3 * width * dpr), centerY + 2, 1, 1).data[0] === 0x0d;
    const track = ctx.getImageData(Math.round(3 * width * dpr), Math.round(12 * height * dpr),
      Math.round(7 * width * dpr), Math.round(height * dpr)).data;
    const trackColor = parseStyleRuns(view.vt.dumpViewportRowStyleRuns(12))[0].fg;
    const expectedTrack = [trackColor >> 16, (trackColor >> 8) & 255, trackColor & 255]
      .map((value, channel) => Math.round([13, 13, 23][channel] * (191 / 255) + value * (64 / 255)));
    checks.smoothProgressTrack = Array.from({ length: track.length / 4 }, (_, i) =>
      expectedTrack.every((value, channel) => Math.abs(track[i * 4 + channel] - value) <= 1)).every(Boolean);

    const scratch = document.createElement("canvas");
    const blockContext = scratch.getContext("2d");
    const blockView = Object.create(view);
    blockView.canvasContext = blockContext;
    const shapes = [
      ["top", .5], ["bottom", .125], ["bottom", .25], ["bottom", .375],
      ["bottom", .5], ["bottom", .625], ["bottom", .75], ["bottom", .875],
      ["full", 1], ["left", .875], ["left", .75], ["left", .625],
      ["left", .5], ["left", .375], ["left", .25], ["left", .125],
      ["right", .5], ["shade", 64 / 255], ["shade", 128 / 255], ["shade", 192 / 255],
      ["top", .125], ["right", .125],
      ["quadrants", 4], ["quadrants", 8], ["quadrants", 1], ["quadrants", 13],
      ["quadrants", 9], ["quadrants", 7], ["quadrants", 11], ["quadrants", 2],
      ["quadrants", 6], ["quadrants", 14],
    ];
    let blockPixels = true;
    let alphaPreserved = true;
    for (const [ratio, pw, ph] of [[1, 11, 23], [2, 22, 45], [1.25, 15, 31]]) {
      for (const opacity of [1, .55]) {
        for (let index = 0; index < shapes.length; index++) {
          scratch.width = pw + 2;
          scratch.height = ph + 2;
          blockContext.fillStyle = "#0d0d17";
          blockContext.fillRect(0, 0, scratch.width, scratch.height);
          blockContext.scale(ratio, ratio);
          blockContext.fillStyle = "#20e080";
          blockContext.globalAlpha = opacity;
          blockView.devicePixelRatio = ratio;
          blockView.drawBlockGlyph(String.fromCharCode(0x2580 + index), 1 / ratio, 1 / ratio, pw / ratio, ph / ratio);
          alphaPreserved &&= blockContext.globalAlpha === opacity;
          const data = blockContext.getImageData(0, 0, scratch.width, scratch.height).data;
          const [kind, fraction] = shapes[index];
          for (let py = 0; py < scratch.height; py++) {
            for (let px = 0; px < scratch.width; px++) {
              const bx = px - 1, by = py - 1;
              let covered = bx >= 0 && bx < pw && by >= 0 && by < ph;
              if (covered) {
                if (kind === "top") covered = by < Math.round(ph * fraction);
                if (kind === "bottom") covered = by >= ph - Math.round(ph * fraction);
                if (kind === "left") covered = bx < Math.round(pw * fraction);
                if (kind === "right") covered = bx >= pw - Math.round(pw * fraction);
                if (kind === "quadrants") {
                  const halfW = Math.round(pw / 2), halfH = Math.round(ph / 2);
                  covered = Boolean(
                    (fraction & 1 && bx < halfW && by < halfH) ||
                    (fraction & 2 && bx >= pw - halfW && by < halfH) ||
                    (fraction & 4 && bx < halfW && by >= ph - halfH) ||
                    (fraction & 8 && bx >= pw - halfW && by >= ph - halfH));
                }
              }
              const alpha = covered ? opacity * (kind === "shade" ? fraction : 1) : 0;
              const offset = (py * scratch.width + px) * 4;
              for (let channel = 0; channel < 3; channel++) {
                const background = [13, 13, 23][channel];
                const foreground = [32, 224, 128][channel];
                const expected = Math.round(background + (foreground - background) * alpha);
                if (Math.abs(data[offset + channel] - expected) > 1) blockPixels = false;
              }
            }
          }
        }
      }
    }
    checks.blockElementsPixelCoverage = blockPixels;
    checks.blockElementsPreserveFaintAlpha = alphaPreserved;
    checks.blockElementsLeaveTextToFont = !blockView.drawBlockGlyph("A", 0, 0, width, height) &&
      !blockView.drawBlockGlyph("█\u0301", 0, 0, width, height);
    diagnostic = { fontFaces: font.faces, metrics: { width, height, baseline }, dpr, firstRow: cells.slice(0, 28) };
    if (globalThis.ghosttyRenderingScreenshotPath) {
      const png = require("electron").nativeImage.createFromDataURL(view.canvasEl.toDataURL()).crop({
        x: 0, y: 0, width: Math.ceil(80 * width * dpr), height: Math.ceil(13 * height * dpr),
      }).toPNG();
      require("fs").writeFileSync(globalThis.ghosttyRenderingScreenshotPath, png);
    }
  } finally {
    leaf?.detach();
  }
  return { pass: Object.values(checks).every(Boolean), checks, diagnostic };
})();
