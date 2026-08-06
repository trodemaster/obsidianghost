// Regression probe: Claude Code's own session descriptor (set via OSC 0/2 terminal-title
// sequences) should uplevel into both the tab label and the view header. See HANDOFF.md.
//
// setSessionTitle() tracks the right string (verifiable via getDisplayText()), but
// Obsidian doesn't re-render a leaf's tab/header from a generic "layout-change" workspace
// event — WorkspaceLeaf#updateHeader() (undocumented, not in obsidian.d.ts, but present at
// runtime) is what actually does that. This probe checks the *rendered* DOM text, not just
// the JS-side field, since that's exactly the gap that shipped without it.
//
// Run via: scripts/live-test.sh scripts/tests/session-title.js
(async () => {
  const VIEW_TYPE = "ghostty-terminal-view";
  const plugin = app.plugins.getPlugin("obsidian-claude-ghostty");
  if (!plugin) return { error: "plugin not found" };

  const before = new Set(app.workspace.getLeavesOfType(VIEW_TYPE));
  await plugin.openNewTerminal();
  const leaf = app.workspace.getLeavesOfType(VIEW_TYPE).find((l) => !before.has(l));
  if (!leaf) return { error: "no new leaf" };

  const initialTabText = leaf.tabHeaderInnerTitleEl?.textContent;

  // Nudge a fresh exchange in case --continue resumed a session with no title yet.
  await new Promise((r) => setTimeout(r, 2500));
  leaf.view.pty.write("say the word banana and nothing else\r");

  let tabText = initialTabText;
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    tabText = leaf.tabHeaderInnerTitleEl?.textContent;
    if (tabText && tabText !== "Claude") break;
  }

  const result = {
    initialTabText,
    finalTabText: tabText,
    getDisplayText: leaf.view.getDisplayText(),
    titleElText: leaf.view.titleEl?.textContent,
  };
  result.tabUpdatedFromDefault = result.finalTabText !== "Claude";
  result.tabMatchesGetDisplayText = result.finalTabText === result.getDisplayText;
  result.titleElMatchesGetDisplayText = result.titleElText === result.getDisplayText;
  result.pass =
    result.tabUpdatedFromDefault &&
    result.tabMatchesGetDisplayText &&
    result.titleElMatchesGetDisplayText;

  leaf.detach();
  return result;
})();
