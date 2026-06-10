// Minimal uucode build config used for the target (lib) build.
// The lib only needs uucode's type system (x.types.GraphemeBreakNoControl),
// not any data tables. An empty tables array compiles without running the
// full UCD table generator.
const config = @import("config.zig");

pub const tables = [_]config.Table{};
