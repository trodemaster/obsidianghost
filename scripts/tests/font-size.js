// Per-computer font size: default from the Ghostty config, live re-layout of open
// terminals, other computers' sizes ignored, and reset to the Ghostty size.
// Run via: obsidian-cli vault=orac eval code="eval(require('fs').readFileSync('/absolute/path/to/scripts/tests/font-size.js','utf8'))"
// Needs one open terminal. saveData is stubbed, so data.json is never written.
(async () => {
  const VIEW_TYPE = "ghostty-terminal-view";
  const plugin = app.plugins.getPlugin("obsidian-claude-ghostty");
  if (!plugin) throw new Error("plugin not found");
  const leaf = app.workspace.getLeavesOfType(VIEW_TYPE)[0];
  if (!leaf?.view.vt) throw new Error("Open a terminal in the test vault first");
  const view = leaf.view;
  const computer = require("os").hostname().split(".")[0].toLowerCase() || "default";
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const original = structuredClone(plugin.settings);
  const { saveData, loadData } = plugin;
  const checks = {};
  const state = () => ({ size: plugin.terminalFont.size, cell: { ...view.getCharSize() }, grid: { ...view.viewportSize } });

  try {
    plugin.saveData = async () => {};

    await plugin.setFontSize(null);
    await wait(150);
    const base = state();
    checks.defaultIsGhosttySize = base.size === plugin.ghosttyFont.size;

    const bigger = Math.min(72, base.size + 6);
    await plugin.setFontSize(bigger);
    await wait(150);
    const big = state();
    checks.sizeApplied = big.size === bigger && plugin.settings.fontSizes[computer] === bigger;
    checks.cellsGrowLive = big.cell.width > base.cell.width && big.cell.height > base.cell.height;
    checks.gridShrinksLive = big.grid.cols < base.grid.cols && big.grid.rows <= base.grid.rows;

    plugin.loadData = async () => ({ fontSizes: { otherhost: 40 } });
    await plugin.loadSettings();
    checks.otherComputersSizeIgnored = plugin.terminalFont.size === plugin.ghosttyFont.size;
    plugin.loadData = async () => ({ fontSizes: { [computer]: 500 } });
    await plugin.loadSettings();
    checks.outOfRangeFallsBack = plugin.terminalFont.size === plugin.ghosttyFont.size;

    plugin.settings = structuredClone(original);
    await plugin.setFontSize(null);
    await wait(150);
    const reset = state();
    checks.resetRestoresLayout = reset.cell.width === base.cell.width && reset.grid.cols === base.grid.cols;

    return { ...checks, base, big, pass: Object.values(checks).every(Boolean) };
  } finally {
    plugin.loadData = loadData;
    plugin.settings = structuredClone(original);
    // Still with the saveData stub: re-apply the original size to the open terminals.
    await plugin.setFontSize(original.fontSizes?.[computer] ?? null).catch(() => {});
    plugin.saveData = saveData;
  }
})();
