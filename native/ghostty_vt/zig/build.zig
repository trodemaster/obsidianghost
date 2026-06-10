const std = @import("std");
const TerminalOptions = @import("ghostty_src/terminal/build_options.zig").Options;
const TerminalArtifact = @import("ghostty_src/terminal/build_options.zig").Artifact;

pub fn build(b: *std.Build) void {
    const optimize = b.standardOptimizeOption(.{});
    const target = b.standardTargetOptions(.{});

    // uucode provides unicode data (replaces ziglyph in Ghostty v1.3+).
    //
    // HOST dependency: used by props_uucode.zig and symbols_uucode.zig codegen
    // executables at build time. They call uucode.get(.width, cp) etc., so they
    // need the full UCD tables. We use Ghostty's uucode_config.zig which lists
    // width, grapheme_break_no_control, is_symbol, etc.
    //
    // The uucode build system first runs its own table generator (uucode_build_tables)
    // with the provided build_config_path to produce tables.zig, then compiles the
    // uucode library with that tables.zig. We capture the generated tables path so we
    // can share it with the TARGET dependency.
    const uucode_host = b.dependency("uucode", .{
        .target = b.graph.host,
        .optimize = optimize,
        .build_config_path = b.path("ghostty_src/build/uucode_config.zig"),
    });
    // Grab the generated tables so we can pass it to the target dependency
    // (avoids running the UCD table generator twice).
    const uucode_tables_path = uucode_host.namedLazyPath("tables.zig");

    // TARGET dependency: used by lib.zig.  lib.zig → ghostty_src/unicode/props.zig
    // → uucode.x.types.GraphemeBreakNoControl.  That type lives in uucode's source
    // code, not its generated tables, so we pass the already-built tables.zig to
    // skip re-generating and provide a stable dependency.
    const uucode_target = b.dependency("uucode", .{
        .target = target,
        .optimize = optimize,
        .tables_path = uucode_tables_path,
        .build_config_path = b.path("uucode_empty_config.zig"),
    });

    // Code-generation executables — run at build time to produce the lookup
    // table Zig source that is anonymously imported by the library.
    const props_exe = b.addExecutable(.{
        .name = "props-unigen",
        .root_module = b.createModule(.{
            .root_source_file = b.path("ghostty_src/unicode/props_uucode.zig"),
            .target = b.graph.host,
            .optimize = optimize,
        }),
    });
    props_exe.root_module.addImport("uucode", uucode_host.module("uucode"));
    // props_uucode.zig imports lut.zig and props.zig from the same dir:
    props_exe.root_module.addImport("lut", b.createModule(.{
        .root_source_file = b.path("ghostty_src/unicode/lut.zig"),
        .target = b.graph.host,
        .optimize = optimize,
    }));

    const symbols_exe = b.addExecutable(.{
        .name = "symbols-unigen",
        .root_module = b.createModule(.{
            .root_source_file = b.path("ghostty_src/unicode/symbols_uucode.zig"),
            .target = b.graph.host,
            .optimize = optimize,
        }),
    });
    symbols_exe.root_module.addImport("uucode", uucode_host.module("uucode"));
    symbols_exe.root_module.addImport("lut", b.createModule(.{
        .root_source_file = b.path("ghostty_src/unicode/lut.zig"),
        .target = b.graph.host,
        .optimize = optimize,
    }));

    const props_run = b.addRunArtifact(props_exe);
    const symbols_run = b.addRunArtifact(symbols_exe);

    // Ghostty's UnicodeTables.zig routes the captured stdout through a WriteFiles
    // step to give the output a ".zig" extension — Zig 0.15 requires anonymous module
    // source files to have that extension for the module-lookup to succeed.
    const wf = b.addWriteFiles();
    const props_output = wf.addCopyFile(props_run.captureStdOut(), "props.zig");
    const symbols_output = wf.addCopyFile(symbols_run.captureStdOut(), "symbols.zig");

    const lib = b.addLibrary(.{
        .name = "ghostty_vt",
        .root_module = b.createModule(.{
            .root_source_file = b.path("lib.zig"),
            .target = target,
            .optimize = optimize,
        }),
        .linkage = .static,
    });
    lib.linkLibC();
    lib.root_module.addImport("uucode", uucode_target.module("uucode"));

    // Wire up the terminal_options module required by Ghostty v1.3.1 internals.
    // c_abi = false: our shim uses Zig-to-Zig stream dispatch (Handler.vt()); enabling
    // c_abi would force C-ABI-compatible union construction for all action types, which
    // fails on SemanticPrompt (non-extern struct). Our exported C functions use the
    // standard Zig `export fn … callconv(.c)` mechanism instead.
    const term_build_opts = TerminalOptions{
        .artifact = .lib,
        .oniguruma = false,
        .simd = false,
        .slow_runtime_safety = false,
        .c_abi = false,
    };
    term_build_opts.add(b, lib.root_module);

    props_output.addStepDependencies(&lib.step);
    lib.root_module.addAnonymousImport("unicode_tables", .{
        .root_source_file = props_output,
    });
    symbols_output.addStepDependencies(&lib.step);
    lib.root_module.addAnonymousImport("symbols_tables", .{
        .root_source_file = symbols_output,
    });

    const include_step = b.addInstallHeaderFile(
        b.path("../include/ghostty_vt.h"),
        "ghostty_vt.h",
    );

    const lib_install = b.addInstallLibFile(lib.getEmittedBin(), "libghostty_vt.a");
    b.getInstallStep().dependOn(&include_step.step);
    b.getInstallStep().dependOn(&lib_install.step);
}
