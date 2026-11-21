// Live probe for Cmd+click on plain-text URLs (see CLAUDE.md).
// Run via: scripts/live-test.sh scripts/tests/plain-url-links.js
(async () => {
  let probeLeaf;
  try {
  const VIEW_TYPE = "ghostty-terminal-view";
  // Own shell-only tab, so the probe never writes into a terminal running an agent.
  const probePlugin = app.plugins.getPlugin("obsidian-claude-ghostty");
  const probeBefore = new Set(app.workspace.getLeavesOfType(VIEW_TYPE));
  await probePlugin.openNewTerminal(undefined, { shellOnly: true });
  const leaf = app.workspace.getLeavesOfType(VIEW_TYPE).find((l) => !probeBefore.has(l));
  if (!leaf) return { error: "probe terminal did not open" };
  probeLeaf = leaf;
  for (let i = 0; i < 50 && !(leaf.view.pty && leaf.view.vt); i++) await new Promise((r) => setTimeout(r, 100));
  const view = leaf.view;
  if (!view.pty || !view.vt || !view.canvasEl) {
    return { error: "view not fully initialized" };
  }

  const result = {};
  const marker = "PLAINLINK";
  const expectedUrl = "https://example.com/foo?bar=1";

  view.pty.write(`printf '${marker} see ${expectedUrl}. for info\\n'\r`);
  await new Promise((r) => setTimeout(r, 600));

  const { cols, rows } = view.viewportSize;
  let row = -1;
  let rowText = "";
  for (let r = 0; r < rows; r++) {
    const text = view.rowTextToCells(view.vt.dumpViewportRow(r), cols).join("");
    if (text.includes(marker)) {
      row = r + 1; // HoveredLink rows are 1-indexed
      rowText = text;
    }
  }
  if (row === -1) return { error: "marker line not found", cols, rows };
  result.rowText = rowText.trim();

  const urlStartIdx = rowText.indexOf(expectedUrl);
  const midCol = urlStartIdx + Math.floor(expectedUrl.length / 2) + 1; // 1-indexed

  // --- pure logic: findLinkAt should return the trimmed URL (no trailing period) ---
  const link = view.findLinkAt(midCol, row);
  result.findLinkAt = link;
  result.findLinkAtOk = link?.uri === expectedUrl;

  // --- full pipeline: mousemove + click through the real DOM handlers ---
  const rect = view.canvasEl.getBoundingClientRect();
  const { width, height } = view.getCharSize();
  const clientX = rect.left + (midCol - 0.5) * width;
  const clientY = rect.top + (row - 0.5) * height;

  const opens = [];
  const origOpen = window.open;
  window.open = (...args) => {
    opens.push(args);
    return null;
  };

  const move = (metaKey) =>
    view.screenEl.dispatchEvent(
      new MouseEvent("mousemove", { clientX, clientY, metaKey, bubbles: true })
    );
  const click = (metaKey) =>
    view.screenEl.dispatchEvent(
      new MouseEvent("click", { clientX, clientY, metaKey, bubbles: true, cancelable: true })
    );

  move(false);
  result.hoverWithoutModifier = view.hoveredLink;

  move(true);
  result.hoverWithModifier = view.hoveredLink;

  click(false);
  result.opensAfterClickWithoutModifier = opens.length;

  move(true); // click handler checks event.metaKey directly, but re-arm hover state too
  click(true);
  result.opensAfterClickWithModifier = opens.slice();

  window.open = origOpen;

  result.pass =
    result.findLinkAtOk &&
    result.hoverWithoutModifier === null &&
    result.hoverWithModifier?.uri === expectedUrl &&
    result.opensAfterClickWithoutModifier === 0 &&
    result.opensAfterClickWithModifier.length === 1 &&
    result.opensAfterClickWithModifier[0][0] === expectedUrl;

  return result;
  } finally {
    probeLeaf?.detach();
  }
})();
