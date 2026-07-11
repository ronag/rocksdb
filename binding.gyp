{
    "variables": {
        "openssl_fips": "0",
        "rocks_level_march%": "<!(node -p \"process.env.ROCKS_LEVEL_MARCH || ''\")",
    },
    "targets": [
        {
            "target_name": "leveldown",
            "defines": ["BOOST_REGEX_STANDALONE=yes"],
            # Match rocksdb.gyp: binding.cc instantiates rocksdb inline code
            # (including assert()s), so Release must compile with NDEBUG too.
            "configurations": {
                "Release": {"defines": ["NDEBUG"]},
            },
            "conditions": [
                [
                    "OS == 'linux'",
                    {
                        "direct_dependent_settings": {
                            "libraries": [],
                        },
                        # resolve-lib.js is invoked with a path relative to
                        # this gyp file's directory (gyp runs <!() commands
                        # with cwd = the .gyp file's dir): interpolating
                        # <(module_root_dir) into the command string breaks
                        # under /bin/sh when the package path contains a
                        # space or quote.
                        "include_dirs": [
                            "<!(node scripts/resolve-lib.js --prefix-include)",
                            "/usr/lib/x86_64-linux-gnu/include",
                            "/usr/lib/include",
                        ],
                        "libraries": [
                            "<!(node scripts/resolve-lib.js re2)",
                            "<!@(node scripts/resolve-lib.js absl)",
                        ],
                        "cflags_cc": [
                            "-flto",
                            "-std=c++23",
                        ],
                        "cflags!": ["-fno-exceptions"],
                        "cflags_cc!": ["-fno-exceptions"],
                        "ldflags": [
                            "-flto",
                            "-fuse-linker-plugin",
                        ],
                        # CPU tuning is opt-in for deployment prebuilds. Local
                        # source builds stay portable, and the flag is only
                        # valid on x64.
                        "conditions": [
                            [
                                "target_arch == 'x64' and rocks_level_march != ''",
                                {
                                    "cflags": ["-march=<(rocks_level_march)", "-mtune=<(rocks_level_march)"],
                                    "cflags_cc": ["-march=<(rocks_level_march)", "-mtune=<(rocks_level_march)"],
                                },
                            ],
                        ],
                    },
                ],
                [
                    "OS == 'mac'",
                    {
                        "direct_dependent_settings": {
                            "libraries": [],
                        },
                        "include_dirs": [
                            "<!(node scripts/resolve-lib.js --prefix-include)",
                            "/opt/homebrew/include",
                            "/usr/local/include",
                        ],
                        # Link re2 + abseil by absolute path to the static
                        # archives (resolve-lib.js prefers the from-source
                        # prefix, else Homebrew). Using `-L<dir> -lre2` instead
                        # would let the linker pick up Homebrew's libre2.dylib,
                        # leaving the addon with a runtime dependency on a
                        # Homebrew install that a shipped prebuild can't assume.
                        "libraries": [
                            "<!(node scripts/resolve-lib.js re2)",
                            "<!@(node scripts/resolve-lib.js absl)",
                        ],
                        "xcode_settings": {
                            "WARNING_CFLAGS": [
                                "-Wno-sign-compare",
                                "-Wno-unused-variable",
                                "-Wno-unused-function",
                                "-Wno-ignored-qualifiers",
                            ],
                            # Host arch only: the deps are built single-arch
                            # (CMAKE_OSX_ARCHITECTURES), so a universal
                            # compile just built every TU twice and threw the
                            # foreign slice away at link.
                            "OTHER_CPLUSPLUSFLAGS": [
                                "-mmacosx-version-min=13.4.0",
                                "-std=c++23",
                                "-fno-omit-frame-pointer",
                                "-momit-leaf-frame-pointer",
                            ],
                            "GCC_ENABLE_CPP_RTTI": "YES",
                            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
                            "MACOSX_DEPLOYMENT_TARGET": "13.4.0",
                        },
                    },
                ],
            ],
            "dependencies": ["<(module_root_dir)/deps/rocksdb/rocksdb.gyp:rocksdb"],
            "include_dirs": ["<!(node -e \"require('napi-macros')\")"],
            "sources": ["binding.cc"],
        }
    ],
}
