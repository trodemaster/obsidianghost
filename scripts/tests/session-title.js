// Provider-independent tab/header title synchronization regression probe.
// Run via: scripts/live-test.sh scripts/tests/session-title.js
(async () => {
  const VIEW_TYPE = "ghostty-terminal-view";
  const plugin = app.plugins.getPlugin("obsidian-claude-ghostty");
  if (!plugin) throw new Error("plugin not found");

  const before = new Set(app.workspace.getLeavesOfType(VIEW_TYPE));
  await plugin.openNewTerminal(undefined, { shellOnly: true });
  const leaf = app.workspace.getLeavesOfType(VIEW_TYPE).find((item) => !before.has(item));
  if (!leaf) throw new Error("no new leaf");

  try {
    const initialTabText = leaf.tabHeaderInnerTitleEl?.textContent;
    leaf.view.parseOscTitleFromStream("\x1b]2;Agent session topic\x07");
    const result = {
      initialTabText,
      finalTabText: leaf.tabHeaderInnerTitleEl?.textContent,
      getDisplayText: leaf.view.getDisplayText(),
      titleElText: leaf.view.titleEl?.textContent,
    };
    result.pass =
      initialTabText === "Agent" &&
      result.getDisplayText === "Agent session topic" &&
      result.finalTabText === result.getDisplayText &&
      result.titleElText === result.getDisplayText;
    return result;
  } finally {
    leaf.detach();
  }
})();
