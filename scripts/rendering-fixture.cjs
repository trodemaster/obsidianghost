const fixture = "\x1b[?2027h" + [
  "A中B e\u0301 👩‍💻 Z 🇺🇸 C 👍🏽 D ❤️ E",
  "中 👩‍💻 https://example.com/😀.",
  "\x1b[48;2;36;44;55m CODE BACKGROUND \x1b[0m",
  "\x1b[48;2;19;27;35m INPUT PANEL                                                    \x1b[0m",
  "regular | \x1b[1mbold\x1b[22m | \x1b[3mitalic\x1b[23m | \x1b[1;3mbold italic\x1b[0m",
  "\x1b[2mfaint\x1b[0m | \x1b[90mmuted\x1b[0m | \x1b[94mbright\x1b[0m",
  "┌────┬────┐",
  "│中  │😀  │",
  "├────┼────┤",
  "│e\u0301   │Z   │",
  "└────┴────┘",
  "\x1b[31mred\x1b[0m | \x1b[32mgreen\x1b[0m | \x1b[4munderline\x1b[0m | \x1b[9mstrikethrough\x1b[0m",
  "\x1b[32m██▌░░░░░░░\x1b[0m progress | ░▒▓█",
  "▀▁▂▃▄▅▆▇█ ▉▊▋▌▍▎▏▐▔▕ ▖▗▘▙▚▛▜▝▞▟",
].join("\r\n") + "\x1b[?2027l";
module.exports = fixture;

if (require.main === module) {
  process.stdout.write("\x1b]2;Ghostty rendering fixture\x07\x1b[2J\x1b[H" + fixture + "\x1b[0m\r\n");
  const measure = process.argv.indexOf("--measure");
  if (process.argv.includes("--hold") || measure >= 0) {
    process.stdout.write("\r\nPress q to close the fixture.\r\n");
    process.stdin.setRawMode(true);
    process.stdin.on("data", (data) => {
      const match = /\x1b\[6;(\d+);(\d+)t/.exec(data.toString());
      if (match && measure >= 0) {
        require("fs").writeFileSync(process.argv[measure + 1], JSON.stringify({
          height: Number(match[1]), width: Number(match[2]),
        }));
      }
      if (data.toString() === "q" || data.includes(3)) process.exit(0);
    });
    if (measure >= 0) process.stdout.write("\x1b[16t");
  }
}
