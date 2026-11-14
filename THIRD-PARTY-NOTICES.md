# Third-party notices

<!-- Written by scripts/notices.mjs. Do not edit: change the script and run `node scripts/notices.mjs`. -->

Qnet's own source is MIT-licensed; see [LICENSE](LICENSE). That licence does not relicense the
third-party components a built Qnet.app carries, which keep their own terms, and the solver
executables that link SuiteSparse's GPL code are distributed under the GPL
([below](#qnets-licence-and-the-solvers-that-are-gpl)). This file lists the components:
11 native libraries, the 16 components of the bundled Python runtime, 11 npm packages and 305 Rust crates. The licence texts are in [ThirdPartyLicenses/](ThirdPartyLicenses/),
which is copied into the app at `Contents/Resources/ThirdPartyLicenses`.

This list is regenerated from `Cargo.lock`, `package-lock.json` and the records of the staged solver
libraries and of the staged Python runtime by `node scripts/notices.mjs`;
`node scripts/notices.mjs --check` (run by `scripts/check.sh`) fails when it is out of date.

Not listed, because Qnet does not redistribute them: macOS's own frameworks (WebKit, AppKit,
Accelerate, libc++, zlib), a Python package a user installs for themselves (CVXPY), and the tools that
only build or test Qnet (TypeScript, Vite, Vitest, the Tauri CLI, CMake and Rust's procedural-macro
crates). The published papers the solvers implement are cited in Help, not redistributed.

## Native libraries (the solvers)

In `Contents/Frameworks`, loaded by the solver executables in `Contents/Resources/bin`. They are
built by `scripts/build-deps.sh` from the unmodified release archives below, each checked against
its sha256, as arm64 libraries for macOS 14.0 and later; BLAS and LAPACK are macOS's own
Accelerate. Nothing is copied from a package manager.

| Component | Version | Licence | Libraries | Texts |
| --- | --- | --- | --- | --- |
| cJSON | 1.7.19 | MIT | libcjson.1.dylib | [LICENSE](ThirdPartyLicenses/cjson/LICENSE) |
| HiGHS | 1.16.0 | MIT | libhighs.1.dylib | [LICENSE.txt](ThirdPartyLicenses/highs/LICENSE.txt) |
| LLVM OpenMP runtime (libomp) | 23.1.5 | Apache-2.0 WITH LLVM-exception | libomp.dylib | [LICENSE.TXT](ThirdPartyLicenses/libomp/LICENSE.TXT) |
| SuiteSparse | 7.14.1 | BSD-3-Clause; LGPL-2.1-or-later AND GPL-2.0-or-later AND Apache-2.0; LGPL-2.1-or-later; GPL-2.0-or-later | libamd.3.dylib, libcamd.3.dylib, libccolamd.3.dylib, libcholmod.5.dylib, libcolamd.3.dylib, libcxsparse.4.dylib, libsuitesparseconfig.7.dylib, libumfpack.6.dylib | [GPL-2.0.txt](ThirdPartyLicenses/suite-sparse/GPL-2.0.txt), [LGPL-2.1.txt](ThirdPartyLicenses/suite-sparse/LGPL-2.1.txt), [LICENSE.txt](ThirdPartyLicenses/suite-sparse/LICENSE.txt) |

| Component | Version | Source archive | sha256 |
| --- | --- | --- | --- |
| cJSON | 1.7.19 | https://github.com/DaveGamble/cJSON/archive/refs/tags/v1.7.19.tar.gz | `7fa616e3046edfa7a28a32d5f9eacfd23f92900fe1f8ccd988c1662f30454562` |
| HiGHS | 1.16.0 | https://github.com/ERGO-Code/HiGHS/releases/download/v1.16.0/source-archive.tar.gz | `05ba0a408e31fe933e4ee4ec9d0e244a0e3c5bd2613e7b138701f62708eceed9` |
| LLVM OpenMP runtime (libomp) | 23.1.5 | https://github.com/llvm/llvm-project/releases/download/llvmorg-23.1.5/llvm-project-23.1.5.src.tar.xz | `fb50b1eac93ddeb3aa8dab4cfe324dff74f4a9c2bdee6160c9e36188f8d06a6e` |
| SuiteSparse | 7.14.1 | https://github.com/DrTimothyAldenDavis/SuiteSparse/archive/refs/tags/v7.14.1.tar.gz | `81e560e1f74546df139edb765b3f5bc865866da23062312ffe8fd821063c8397` |

| Library | From | Library version | Licence | Used by |
| --- | --- | --- | --- | --- |
| libamd.3.dylib | SuiteSparse 7.14.1 | 3.3.4 | BSD-3-Clause | bna_fm_cbc, bna_fm_gauss, srbm_solver, mc_solver, bnet |
| libcamd.3.dylib | SuiteSparse 7.14.1 | 3.3.5 | BSD-3-Clause | bna_fm_cbc, bna_fm_gauss, srbm_solver, mc_solver, bnet |
| libccolamd.3.dylib | SuiteSparse 7.14.1 | 3.3.5 | BSD-3-Clause | bna_fm_cbc, bna_fm_gauss, srbm_solver, mc_solver, bnet |
| libcholmod.5.dylib | SuiteSparse 7.14.1 | 5.3.5 | LGPL-2.1-or-later AND GPL-2.0-or-later AND Apache-2.0 | bna_fm_cbc, bna_fm_gauss, srbm_solver, mc_solver, bnet |
| libcjson.1.dylib | cJSON 1.7.19 | 1.7.19 | MIT | mc_solver |
| libcolamd.3.dylib | SuiteSparse 7.14.1 | 3.3.5 | BSD-3-Clause | bna_fm_cbc, bna_fm_gauss, srbm_solver, mc_solver, bnet |
| libcxsparse.4.dylib | SuiteSparse 7.14.1 | 4.4.2 | LGPL-2.1-or-later | rbm_mlmc |
| libhighs.1.dylib | HiGHS 1.16.0 | 1.16.0 | MIT | fBNAlp_solver, srbm_lp |
| libomp.dylib | LLVM OpenMP runtime (libomp) 23.1.5 | 5.0.0 | Apache-2.0 WITH LLVM-exception | bna_fm_cbc, bna_fm_gauss, fBNAlp_solver, fBNAsim, srbm_solver, srbm_lp, rbm_mlmc, mc_solver, jackson_sim, bnet |
| libsuitesparseconfig.7.dylib | SuiteSparse 7.14.1 | 7.14.1 | BSD-3-Clause | bna_fm_cbc, bna_fm_gauss, srbm_solver, mc_solver, bnet |
| libumfpack.6.dylib | SuiteSparse 7.14.1 | 6.3.8 | GPL-2.0-or-later | bna_fm_cbc, bna_fm_gauss, mc_solver, bnet |

### Qnet's licence, and the solvers that are GPL

Qnet's own code is MIT-licensed: the application, the interface, and the source of every solver in
`solvers/`. 5 of the solver executables in a built Qnet.app link SuiteSparse's UMFPACK or CHOLMOD, which
contain code under the GNU General Public License. **Those 5 executables are distributed under the
GPL, version 2 or (at your option) any later version (GPL-2.0-or-later)**, with their source
available:

| Executable | In the app | Its source | GPL libraries it links |
| --- | --- | --- | --- |
| `bna_fm_cbc` | `Contents/Resources/bin/finite/fBNAfm/bna_fm_cbc` | `solvers/finite/fBNAfm/` | libcholmod, libumfpack |
| `bna_fm_gauss` | `Contents/Resources/bin/finite/fBNAfm/bna_fm_gauss` | `solvers/finite/fBNAfm/` | libcholmod, libumfpack |
| `srbm_solver` | `Contents/Resources/bin/finite/fBNAsm/srbm_solver` | `solvers/finite/fBNAsm/` | libcholmod |
| `mc_solver` | `Contents/Resources/bin/infinite/BNAmd/mc_solver` | `solvers/infinite/BNAmd/` | libcholmod, libumfpack |
| `bnet` | `Contents/Resources/bin/infinite/BNAsm/bnet` | `solvers/infinite/BNAsm/` | libcholmod, libumfpack |

- Their own source is in Qnet's repository, in the folders above. It is MIT-licensed, which the GPL
  accepts in a combined work; the MIT terms continue to apply to that source on its own.
- SuiteSparse 7.14.1 is built unmodified from https://github.com/DrTimothyAldenDavis/SuiteSparse/archive/refs/tags/v7.14.1.tar.gz
  (sha256 `81e560e1f74546df139edb765b3f5bc865866da23062312ffe8fd821063c8397`) by `scripts/build-deps.sh`, and `scripts/stage-solvers.sh` compiles and links
  the solvers against it: the two scripts are the build.
- The GPL's text is `ThirdPartyLicenses/suite-sparse/GPL-2.0.txt`.

Nothing else Qnet's own programs link is under the GPL. The application does not link SuiteSparse:
it starts each solver as a separate program and reads what it prints. The other solver executables
link no GPL library. The bundled Python runtime carries GCC's runtime libraries inside NumPy's wheel,
under the GPL version 3 with the GCC Runtime Library Exception; see “The GNU runtime libraries inside
NumPy's wheel” below.

### Licences that ask for more than a notice

- **SuiteSparse.** UMFPACK (`libumfpack`) and CHOLMOD's MatrixOps, Modify and Supernodal modules (in
  `libcholmod`) are GPL-2.0-or-later; CHOLMOD's Check, Cholesky, Utility and Partition modules and
  CXSparse are LGPL-2.1-or-later; CHOLMOD's headers are Apache-2.0; AMD, CAMD, COLAMD, CCOLAMD and
  SuiteSparse_config are BSD-3-Clause. The libraries are built unmodified as separate dynamic
  libraries in `Contents/Frameworks`, loaded only by solver executables, which run as separate
  processes. What follows for the executables that link the GPL ones is stated above; the LGPL
  libraries can be replaced by a rebuilt copy, since they are separate files. SuiteSparse's source: https://github.com/DrTimothyAldenDavis/SuiteSparse.
- **libomp** is Apache-2.0 with the LLVM exception; its licence file also carries the older
  University of Illinois and MIT terms for parts of the runtime.
- **MPL-2.0 crates** (cssparser 0.37.0, dtoa-short 0.3.5, option-ext 0.2.0, selectors 0.38.0) are compiled into the application
  unmodified. The Mozilla Public License is a file-level copyleft: the source of those files stays
  available under the MPL, from https://github.com/servo/rust-cssparser, https://github.com/upsuper/dtoa-short, https://github.com/soc/option-ext.git, https://github.com/servo/stylo and crates.io.
- **The Python runtime** carries GCC's runtime libraries (GPL-3.0-or-later with the GCC Runtime
  Library Exception; LGPL-2.1-or-later) inside NumPy's wheel; see “The GNU runtime libraries inside
  NumPy's wheel” below.

Nothing else here is copyleft. Unicode-3.0 (the ICU4X crates' data), Zlib, ISC, BSL-1.0, CC0-1.0 and
the Unlicense are permissive; aws-lc-sys and ring (the TLS cryptography, derived from BoringSSL) carry several permissive
licences at once, and their licence files are kept whole.

## Bundled Python runtime

In `Contents/Resources/python`: the Python interpreter and NumPy that Qnet's Python solvers run with, so that no
Python has to be installed. `scripts/stage-python.sh` assembles it from the unmodified archives
below, each checked against its sha256: CPython 3.15.2 as built by python-build-standalone (arm64,
macOS 11.0 and later), which links the libraries listed with it into the interpreter, and NumPy
2.5.4's wheel from PyPI. Nothing in it is compiled or changed by Qnet; parts a solver has no use for
(the test suites, IDLE, Tk, pip, headers) are left out. The licence texts are the runtime's own
files, kept there and copied to `ThirdPartyLicenses/python/texts/` (32 distinct texts for 32 licence files).

| Component | Version | Licence | What it is | Texts |
| --- | --- | --- | --- | --- |
| CPython | 3.15.2 | Python-2.0 AND CNRI-Python | interpreter and standard library | [cpython-86e6141582.txt](ThirdPartyLicenses/python/texts/cpython-86e6141582.txt), [cpython-b0e25a78cf.txt](ThirdPartyLicenses/python/texts/cpython-b0e25a78cf.txt) |
| bzip2 |  | bzip2-1.0.6 | linked into the interpreter (modules: _bz2) | [bzip2-1f38bbc7ca.txt](ThirdPartyLicenses/python/texts/bzip2-1f38bbc7ca.txt) |
| Expat | 2.10.0 | MIT | linked into the interpreter (modules: pyexpat) | [expat-122f2c2700.txt](ThirdPartyLicenses/python/texts/expat-122f2c2700.txt) |
| libedit |  | BSD-3-Clause | linked into the interpreter (modules: readline) | [libedit-29cea33c32.txt](ThirdPartyLicenses/python/texts/libedit-29cea33c32.txt) |
| libffi |  | MIT | linked into the interpreter (modules: _ctypes) | [libffi-deaf3a42ef.txt](ThirdPartyLicenses/python/texts/libffi-deaf3a42ef.txt) |
| XZ Utils (liblzma) |  | 0BSD | linked into the interpreter (modules: _lzma) | [liblzma-9a4062de0a.txt](ThirdPartyLicenses/python/texts/liblzma-9a4062de0a.txt) |
| libuuid |  | BSD-3-Clause | linked into the interpreter (modules: _uuid) | [libuuid-122ee1f7e2.txt](ThirdPartyLicenses/python/texts/libuuid-122ee1f7e2.txt) |
| mpdecimal | 4.0.0 | BSD-2-Clause | linked into the interpreter (modules: _decimal) | [mpdecimal-669512af72.txt](ThirdPartyLicenses/python/texts/mpdecimal-669512af72.txt) |
| ncurses |  | X11 | linked into the interpreter (modules: _curses, _curses_panel) | [ncurses-87a4c44423.txt](ThirdPartyLicenses/python/texts/ncurses-87a4c44423.txt) |
| OpenSSL | 3.5.9 | Apache-2.0 | linked into the interpreter (modules: _hashlib, _ssl) | [openssl-3-7d5450cb2d.txt](ThirdPartyLicenses/python/texts/openssl-3-7d5450cb2d.txt) |
| SQLite | 3.53.1 | blessing | linked into the interpreter (modules: _sqlite3) | [sqlite-38bef3d28b.txt](ThirdPartyLicenses/python/texts/sqlite-38bef3d28b.txt) |
| zlib |  | Zlib | linked into the interpreter (modules: _sqlite3, binascii, zlib) | [zlib-e32ff4e00d.txt](ThirdPartyLicenses/python/texts/zlib-e32ff4e00d.txt) |
| zlib-ng |  | Zlib | linked into the interpreter (modules: _sqlite3, binascii, zlib) | [zlib-ng-6c9f0d975b.txt](ThirdPartyLicenses/python/texts/zlib-ng-6c9f0d975b.txt) |
| Zstandard | 1.5.7 | BSD-3-Clause | linked into the interpreter (modules: _remote_debugging, _zstd) | [zstd-7055266497.txt](ThirdPartyLicenses/python/texts/zstd-7055266497.txt) |
| NumPy | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | array library the CTMC and adaptive BAR solvers import | [numpy-649a589ab3.txt](ThirdPartyLicenses/python/texts/numpy-649a589ab3.txt), [numpy-libdivide-fbc539f47d.txt](ThirdPartyLicenses/python/texts/numpy-libdivide-fbc539f47d.txt), [numpy-pythoncapi-compat-3f2c1ffa76.txt](ThirdPartyLicenses/python/texts/numpy-pythoncapi-compat-3f2c1ffa76.txt), [numpy-highway-e340270d4f.txt](ThirdPartyLicenses/python/texts/numpy-highway-e340270d4f.txt), [numpy-multiarray-f7b14309e5.txt](ThirdPartyLicenses/python/texts/numpy-multiarray-f7b14309e5.txt), [numpy-x86-simd-sort-211e7d737d.txt](ThirdPartyLicenses/python/texts/numpy-x86-simd-sort-211e7d737d.txt), [numpy-svml-c17011467b.txt](ThirdPartyLicenses/python/texts/numpy-svml-c17011467b.txt), [numpy-pocketfft-a85ca13fdf.txt](ThirdPartyLicenses/python/texts/numpy-pocketfft-a85ca13fdf.txt), [numpy-lapack-lite-a14cc25e10.txt](ThirdPartyLicenses/python/texts/numpy-lapack-lite-a14cc25e10.txt), [numpy-ma-05f3b88351.txt](ThirdPartyLicenses/python/texts/numpy-ma-05f3b88351.txt), [numpy-random-103166b62b.txt](ThirdPartyLicenses/python/texts/numpy-random-103166b62b.txt), [numpy-distributions-469778be8f.txt](ThirdPartyLicenses/python/texts/numpy-distributions-469778be8f.txt), [numpy-mt19937-0e111337b2.txt](ThirdPartyLicenses/python/texts/numpy-mt19937-0e111337b2.txt), [numpy-pcg64-e7d4f4fb20.txt](ThirdPartyLicenses/python/texts/numpy-pcg64-e7d4f4fb20.txt), [numpy-philox-6f5828a572.txt](ThirdPartyLicenses/python/texts/numpy-philox-6f5828a572.txt), [numpy-sfc64-9d40988460.txt](ThirdPartyLicenses/python/texts/numpy-sfc64-9d40988460.txt), [numpy-splitmix64-268b0ca067.txt](ThirdPartyLicenses/python/texts/numpy-splitmix64-268b0ca067.txt) |
| OpenBLAS and the GNU Fortran runtime (inside the NumPy wheel) |  | BSD-3-Clause (OpenBLAS); BSD-3-Clause-Open-MPI (LAPACK inside OpenBLAS); GPL-3.0-or-later WITH GCC-exception-3.1 (libgfortran, libgcc_s); LGPL-2.1-or-later (libquadmath) | linear algebra for NumPy: libgcc_s.1.1.dylib, libgfortran.5.dylib, libquadmath.0.dylib, libscipy_openblas64_.dylib | [numpy-649a589ab3.txt](ThirdPartyLicenses/python/texts/numpy-649a589ab3.txt) |

| Archive | sha256 | Components |
| --- | --- | --- |
| https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.15.2%2B20261110-aarch64-apple-darwin-install_only_stripped.tar.gz | `7e58607647b5b4832092a339ff1c55eeeccee128221232509b8fc8d27957065e` | CPython |
| https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.15.2%2B20261110-aarch64-apple-darwin-pgo%2Blto-full.tar.zst | `53af18af034de253bac9b08d95c861d5b08a6d46a87ec5c9d8b34577fe48b4ad` | bzip2, Expat and 11 more |
| https://files.pythonhosted.org/packages/be/75/fee0b8c6d94b44b2fdfae74f6a4ad5a138739589a8aebaec28ce4e713ed5/numpy-2.5.4-cp315-cp315-macosx_11_0_arm64.whl | `81e3420b27048b65eb14c3acf0c174a8cb0e023277716110347d2dcb26026dad` | NumPy, OpenBLAS and the GNU Fortran runtime (inside the NumPy wheel) |

### The GNU runtime libraries inside NumPy's wheel

NumPy 2.5.4's wheel carries its own
linear algebra in `Contents/Resources/python/lib/python3.15/site-packages/numpy/.dylibs/`: OpenBLAS (`libscipy_openblas64_.dylib`, BSD-3-Clause) and,
because OpenBLAS's LAPACK is compiled from Fortran, three libraries from GCC: `libgcc_s.1.1.dylib`, `libgfortran.5.dylib`
(GPL-3.0-or-later with the GCC Runtime Library Exception 3.1) and `libquadmath.0.dylib` (LGPL-2.1-or-later).
They are the unmodified files of the wheel, inside the Python runtime only: NumPy loads them, and
neither the application nor any solver executable in `Contents/Resources/bin` links them. The GCC
Runtime Library Exception is what lets libgfortran and libgcc_s be distributed with software under
other licences; its text and the GPL version 3 are in NumPy's licence file, `ThirdPartyLicenses/python/texts/numpy-649a589ab3.txt`,
which also states libquadmath's terms. libquadmath is a separate dynamic library, so it can be
replaced by a rebuilt copy; the LGPL-2.1 text is `ThirdPartyLicenses/suite-sparse/LGPL-2.1.txt`. Their source is
GCC's: https://gcc.gnu.org/ (libgfortran, libgcc, libquadmath).

## The interface (npm packages)

Bundled into the page the app shows. 11 packages: the `dependencies` of `package.json` and what they need.

| Package | Version | Licence | Used for | Texts |
| --- | --- | --- | --- | --- |
| @tauri-apps/api | 2.12.4 | Apache-2.0 OR MIT | The page's calls to the app (commands, events, windows, menus) | [LICENSE-APACHE-2.0](ThirdPartyLicenses/npm/@tauri-apps/api/LICENSE-APACHE-2.0), [LICENSE-MIT](ThirdPartyLicenses/npm/@tauri-apps/api/LICENSE-MIT), [LICENSE.spdx](ThirdPartyLicenses/npm/@tauri-apps/api/LICENSE.spdx) |
| @tauri-apps/plugin-dialog | 2.8.4 | MIT OR Apache-2.0 | Open, save and message dialogs | [LICENSE.spdx](ThirdPartyLicenses/npm/@tauri-apps/plugin-dialog/LICENSE.spdx) |
| @tauri-apps/plugin-opener | 2.7.2 | MIT OR Apache-2.0 | Opening links and files in other apps | [LICENSE.spdx](ThirdPartyLicenses/npm/@tauri-apps/plugin-opener/LICENSE.spdx) |
| @xterm/addon-search | 0.15.0 | MIT | Find in the Shell pane | [LICENSE](ThirdPartyLicenses/npm/@xterm/addon-search/LICENSE) |
| @xterm/addon-web-links | 0.11.0 | MIT | Links in the Shell pane | [LICENSE](ThirdPartyLicenses/npm/@xterm/addon-web-links/LICENSE) |
| @xterm/xterm | 5.5.0 | MIT | The Shell pane's terminal | [LICENSE](ThirdPartyLicenses/npm/@xterm/xterm/LICENSE) |
| lucide-react | 1.62.0 | ISC | Icons | [LICENSE](ThirdPartyLicenses/npm/lucide-react/LICENSE) |
| marked | 16.4.2 | MIT | Markdown reader (src/windows/help/markdown.ts) | [LICENSE.md](ThirdPartyLicenses/npm/marked/LICENSE.md) |
| react | 19.3.1 | MIT | Interface library | [LICENSE](ThirdPartyLicenses/npm/react/LICENSE) |
| react-dom | 19.3.1 | MIT | Interface library (rendering) | [LICENSE](ThirdPartyLicenses/npm/react-dom/LICENSE) |
| scheduler | 0.28.0 | MIT | Needed by react-dom | [LICENSE](ThirdPartyLicenses/npm/scheduler/LICENSE) |

## The application (Rust crates)

Compiled into the Qnet executable, together with Rust's standard library (MIT OR Apache-2.0).
305 crates: everything the app links for aarch64-apple-darwin. Each distinct licence text is kept
once in `ThirdPartyLicenses/rust/texts/` (237 texts for 555 licence files); texts that differ in anything but line
endings and trailing blanks, a copyright line included, are kept separately. Where a licence
expression offers a choice (`OR`), every text the crate ships is kept.

17 crates ship no licence text in their package (alloc-stdlib, block2, dispatch2, krilla, krilla-svg, objc2, objc2-app-kit, objc2-core-foundation, objc2-core-graphics, objc2-encode, objc2-exception-helper, objc2-foundation, objc2-io-surface, objc2-osa-kit, objc2-quartz-core, objc2-web-kit, selectors); for those the standard text of the licence they declare is kept, with the authors and repository from the crate's manifest.

| Crate | Version | Licence | Used | Texts |
| --- | --- | --- | --- | --- |
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | through krilla, krilla-svg, resvg and 5 more | [LICENSE-0BSD](ThirdPartyLicenses/rust/texts/other-861399f8c2.txt), [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-8ada45cd9f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| aho-corasick | 1.1.5 | Unlicense OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [COPYING](ThirdPartyLicenses/rust/texts/other-01c266bced.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-0f96a83840.txt), [UNLICENSE](ThirdPartyLicenses/rust/texts/unlicense-7e12e5df4b.txt) |
| alloc-no-stdlib | 3.0.0 | BSD-3-Clause | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/bsd-c0c56f26d9.txt) |
| alloc-stdlib | 0.3.0 | BSD-3-Clause | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [standard text](ThirdPartyLicenses/rust/texts/standard-bsd-8bc8ebec2e.txt) |
| anyhow | 1.0.104 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| arrayref | 0.3.9 | BSD-2-Clause | through krilla, krilla-svg, resvg and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/bsd-1bc7e6f475.txt) |
| arrayvec | 0.7.8 | MIT OR Apache-2.0 | through krilla, krilla-svg, resvg and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-4da95ec4ec.txt) |
| atomic-waker | 1.1.2 | Apache-2.0 OR MIT | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt), [LICENSE-THIRD-PARTY](ThirdPartyLicenses/rust/texts/mit-6226d0632e.txt) |
| aws-lc-rs | 1.19.0 | ISC AND (Apache-2.0 OR ISC) | through reqwest, tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/apache-2.0-b50b376e7d.txt) |
| aws-lc-sys | 0.47.0 | ISC AND (Apache-2.0 OR ISC) AND Apache-2.0 AND MIT AND BSD-3-Clause AND (Apache-2.0 OR ISC OR MIT) AND (Apache-2.0 OR ISC OR MIT-0) | through reqwest, tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/mit-728536b416.txt) |
| base64 | 0.21.7 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-0dd882e53d.txt) |
| base64 | 0.22.1 | MIT OR Apache-2.0 | used directly | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-0dd882e53d.txt) |
| base64 | 0.23.1 | MIT OR Apache-2.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-ab499c75a0.txt) |
| bit-set | 0.8.0 | Apache-2.0 OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-8173d5c29b.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-f51ac2c59a.txt) |
| bit-vec | 0.8.0 | Apache-2.0 OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-8173d5c29b.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-f51ac2c59a.txt) |
| bitflags | 2.13.2 | MIT OR Apache-2.0 | through krilla, krilla-svg, reqwest and 7 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-6485b8ed31.txt) |
| block2 | 0.6.2 | MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [standard text](ThirdPartyLicenses/rust/texts/standard-mit-85d2205f83.txt) |
| brotli | 9.1.1 | BSD-3-Clause AND MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE.BSD-3-Clause](ThirdPartyLicenses/rust/texts/bsd-c0c56f26d9.txt), [LICENSE.MIT](ThirdPartyLicenses/rust/texts/mit-3d180008e3.txt) |
| brotli-decompressor | 6.3.1 | BSD-3-Clause OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/bsd-c0c56f26d9.txt) |
| bs58 | 0.5.1 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-42d3bf7e7d.txt) |
| bumpalo | 3.20.3 | MIT OR Apache-2.0 | through krilla, krilla-svg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-65f94e99dd.txt) |
| bytemuck | 1.25.2 | Zlib OR Apache-2.0 OR MIT | through krilla, krilla-svg, resvg and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-e3ba223bb1.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-9df9ba60a1.txt), [LICENSE-ZLIB](ThirdPartyLicenses/rust/texts/zlib-84b34dd760.txt) |
| byteorder-lite | 0.1.0 | Unlicense OR MIT | through krilla, krilla-svg, resvg | [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-0f96a83840.txt), [UNLICENSE](ThirdPartyLicenses/rust/texts/unlicense-7e12e5df4b.txt) |
| bytes | 1.12.1 | MIT | through reqwest, tauri, tauri-plugin-dialog and 3 more | [LICENSE](ThirdPartyLicenses/rust/texts/mit-45f522cace.txt) |
| camino | 1.2.6 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| cargo-platform | 0.1.9 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-8ada45cd9f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| cargo_metadata | 0.19.2 | MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| cfb | 0.14.0 | MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/mit-ebaac853b5.txt) |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 | through getrandom, krilla, krilla-svg and 7 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-378f5840b2.txt) |
| chacha20 | 0.10.2 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a9040321c3.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-b8c6939380.txt) |
| chrono | 0.4.45 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE.txt](ThirdPartyLicenses/rust/texts/apache-2.0-and-mit-2200505cea.txt) |
| color_quant | 1.1.0 | MIT | through krilla, krilla-svg, resvg | [LICENSE](ThirdPartyLicenses/rust/texts/mit-592dc80f1a.txt) |
| cookie | 0.18.2 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-2773e20df8.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-f28420c190.txt) |
| core-foundation | 0.10.1 | MIT OR Apache-2.0 | through reqwest, security-framework, tauri and 3 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-62065228e4.txt) |
| core-foundation | 0.9.4 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-62065228e4.txt) |
| core-foundation-sys | 0.8.7 | MIT OR Apache-2.0 | through reqwest, security-framework, tauri and 3 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-62065228e4.txt) |
| core-graphics | 0.25.0 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [COPYRIGHT](ThirdPartyLicenses/rust/texts/other-ec82b96487.txt), [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-62065228e4.txt) |
| core-graphics-types | 0.2.0 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-62065228e4.txt) |
| core_maths | 0.1.1 | MIT | through krilla, krilla-svg, resvg and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/mit-46f625f4d0.txt) |
| crc32fast | 1.5.5 | MIT OR Apache-2.0 | through krilla, krilla-svg, resvg and 5 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-b40930bbcf.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-61d383b05b.txt) |
| crossbeam-channel | 0.5.17 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-5734ed989d.txt), [LICENSE-THIRD-PARTY](ThirdPartyLicenses/rust/texts/mit-b16db96b93.txt) |
| crossbeam-utils | 0.8.23 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-5734ed989d.txt) |
| cssparser | 0.37.0 | MPL-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/mpl-2.0-1f256ecad1.txt) |
| ctor | 1.0.13 | Apache-2.0 OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a8ad31b1c3.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-fd80a26fbb.txt) |
| data-url | 0.3.2 | MIT OR Apache-2.0 | through krilla-svg, resvg, usvg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-b38f11f609.txt) |
| deranged | 0.5.9 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-Apache](ThirdPartyLicenses/rust/texts/apache-2.0-edd65bdd88.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-231c837c45.txt) |
| derive_more | 2.1.1 | MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/mit-8a35369f3c.txt) |
| dirs | 7.0.0 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-d3174ad63e.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-6a2e0ade09.txt) |
| dirs-sys | 0.5.0 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-d3174ad63e.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-6a2e0ade09.txt) |
| dispatch2 | 0.3.1 | Zlib OR Apache-2.0 OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [standard text](ThirdPartyLicenses/rust/texts/standard-mit-b68f36e04e.txt) |
| dom_query | 0.28.0 | MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/mit-ac481b3d81.txt) |
| dpi | 0.1.2 | Apache-2.0 AND MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/apache-2.0-a8ad31b1c3.txt), [LICENSE-LIBM-MIT](ThirdPartyLicenses/rust/texts/mit-9eff396a99.txt) |
| dtoa | 1.0.11 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| dtoa-short | 0.3.5 | MPL-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/mpl-2.0-1f256ecad1.txt) |
| dunce | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/cc0-1.0-a2010f3434.txt) |
| dyn-clone | 1.0.20 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| embed_plist | 1.2.2 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-cfc7749b96.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-daacc37f68.txt) |
| equivalent | 1.0.3 | Apache-2.0 OR MIT | through krilla, krilla-svg, tauri and 3 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-7365cc8878.txt) |
| erased-serde | 0.4.11 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| errno | 0.3.14 | MIT OR Apache-2.0 | through tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-8764a59767.txt) |
| euclid | 0.22.14 | MIT OR Apache-2.0 | through krilla, krilla-svg, resvg and 1 more | [COPYRIGHT](ThirdPartyLicenses/rust/texts/other-ec82b96487.txt), [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-62065228e4.txt) |
| fastrand | 2.5.0 | Apache-2.0 OR MIT | through tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| fdeflate | 0.3.7 | MIT OR Apache-2.0 | through krilla, krilla-svg, resvg and 4 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-0d542e0c88.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-c77a4cf9da.txt) |
| filetime | 0.2.29 | MIT OR Apache-2.0 | through tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-378f5840b2.txt) |
| flate2 | 1.1.11 | MIT OR Apache-2.0 | through krilla, krilla-svg, resvg and 5 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-025436edff.txt) |
| float-cmp | 0.9.0 | MIT | through krilla, krilla-svg, resvg and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/mit-40be1e7782.txt) |
| fnv | 1.0.7 | Apache-2.0 OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-65fdb6c76c.txt) |
| foldhash | 0.2.0 | Zlib | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/zlib-1d4c38d566.txt) |
| font-types | 0.11.3 | MIT OR Apache-2.0 | through krilla, krilla-svg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-021661359a.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-8a62fa27ff.txt) |
| fontdb | 0.23.0 | MIT | through krilla-svg, resvg, usvg | [LICENSE](ThirdPartyLicenses/rust/texts/mit-59a1fdac3b.txt) |
| foreign-types | 0.5.0 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-b40930bbcf.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-333ea3aaa3.txt) |
| foreign-types-shared | 0.3.1 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-b40930bbcf.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-333ea3aaa3.txt) |
| form_urlencoded | 1.2.2 | MIT OR Apache-2.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-20c7855c36.txt) |
| futures-channel | 0.3.34 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-275c491d6d.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-6652c868f3.txt) |
| futures-core | 0.3.34 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-275c491d6d.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-6652c868f3.txt) |
| futures-io | 0.3.34 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-275c491d6d.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-6652c868f3.txt) |
| futures-sink | 0.3.34 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-275c491d6d.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-6652c868f3.txt) |
| futures-task | 0.3.34 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-275c491d6d.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-6652c868f3.txt) |
| futures-util | 0.3.34 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-275c491d6d.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-6652c868f3.txt) |
| getrandom | 0.2.17 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-aaff376532.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-42fa16951c.txt) |
| getrandom | 0.3.4 | MIT OR Apache-2.0 | used directly | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-aaff376532.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-29e9fe5074.txt) |
| getrandom | 0.4.3 | MIT OR Apache-2.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-aaff376532.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-523a42c25d.txt) |
| gif | 0.14.2 | MIT OR Apache-2.0 | through krilla, krilla-svg, resvg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-77257f3d21.txt) |
| glob | 0.3.4 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-6485b8ed31.txt) |
| hashbrown | 0.12.3 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-ff8f68cb07.txt) |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 | through krilla, krilla-svg, tauri and 3 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-ff8f68cb07.txt) |
| heck | 0.5.0 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-7b63ecd5f1.txt) |
| hex | 0.4.3 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-b40930bbcf.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-f7bdb3426d.txt) |
| html5ever | 0.39.0 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-86dd7f026f.txt) |
| http | 1.5.0 | MIT OR Apache-2.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-8bb1b50b0e.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-dc91f8200e.txt) |
| http-body | 1.1.0 | MIT | through reqwest, tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/mit-248378d0a3.txt) |
| http-body-util | 0.1.5 | MIT | through reqwest, tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/mit-248378d0a3.txt) |
| httparse | 1.10.1 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-1626f2c950.txt) |
| hyper | 1.12.0 | MIT | through reqwest, tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/mit-2d01890414.txt) |
| hyper-rustls | 0.27.10 | Apache-2.0 OR ISC OR MIT | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-ISC](ThirdPartyLicenses/rust/texts/other-7cfafc877e.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-709e3175b4.txt) |
| hyper-util | 0.1.21 | MIT | through reqwest, tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/mit-9e0a97848e.txt) |
| iana-time-zone | 0.1.65 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-696759d65d.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-da28ccc6b1.txt) |
| icu_collections | 2.4.0 | Unicode-3.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE](ThirdPartyLicenses/rust/texts/unicode-3.0-f367c1b8e1.txt) |
| icu_locale_core | 2.4.0 | Unicode-3.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE](ThirdPartyLicenses/rust/texts/unicode-3.0-f367c1b8e1.txt) |
| icu_normalizer | 2.4.0 | Unicode-3.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE](ThirdPartyLicenses/rust/texts/unicode-3.0-f367c1b8e1.txt) |
| icu_normalizer_data | 2.4.0 | Unicode-3.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE](ThirdPartyLicenses/rust/texts/unicode-3.0-f367c1b8e1.txt) |
| icu_properties | 2.4.0 | Unicode-3.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE](ThirdPartyLicenses/rust/texts/unicode-3.0-f367c1b8e1.txt) |
| icu_properties_data | 2.4.0 | Unicode-3.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE](ThirdPartyLicenses/rust/texts/unicode-3.0-f367c1b8e1.txt) |
| icu_provider | 2.4.0 | Unicode-3.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE](ThirdPartyLicenses/rust/texts/unicode-3.0-f367c1b8e1.txt) |
| idna | 1.1.0 | MIT OR Apache-2.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-b38f11f609.txt) |
| idna_adapter | 1.2.2 | Apache-2.0 OR MIT | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-8b43ce8acc.txt) |
| image-webp | 0.2.4 | MIT OR Apache-2.0 | through krilla, krilla-svg, resvg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-0d542e0c88.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-c77a4cf9da.txt) |
| imagesize | 0.14.0 | MIT | through krilla, krilla-svg, resvg and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/mit-fa0d694967.txt) |
| indexmap | 1.9.3 | Apache-2.0 OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-ecc269ef87.txt) |
| indexmap | 2.14.2 | Apache-2.0 OR MIT | through krilla, krilla-svg, tauri and 3 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-ecc269ef87.txt) |
| infer | 0.22.0 | MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/mit-270b0d8189.txt) |
| ipnet | 2.12.2 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-87d9feb923.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-47dc9ff291.txt) |
| itoa | 1.0.19 | MIT OR Apache-2.0 | through krilla, krilla-svg, reqwest and 5 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| jiff | 0.2.42 | Unlicense OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [COPYING](ThirdPartyLicenses/rust/texts/other-01c266bced.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-0f96a83840.txt), [UNLICENSE](ThirdPartyLicenses/rust/texts/unlicense-7e12e5df4b.txt) |
| jiff-core | 0.1.4 | Unlicense OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [COPYING](ThirdPartyLicenses/rust/texts/other-01c266bced.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-0f96a83840.txt), [UNLICENSE](ThirdPartyLicenses/rust/texts/unlicense-7e12e5df4b.txt) |
| json-patch | 4.2.0 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-b40930bbcf.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-87f7527b10.txt) |
| jsonptr | 0.7.1 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-2cf31f2ae7.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-2bc107bdc1.txt) |
| keyboard-types | 0.8.3 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-dd57ede7eb.txt) |
| krilla | 0.8.2 | MIT OR Apache-2.0 | used directly | [standard text](ThirdPartyLicenses/rust/texts/standard-mit-ef47fda4d9.txt) |
| krilla-svg | 0.8.1 | MIT OR Apache-2.0 | used directly | [standard text](ThirdPartyLicenses/rust/texts/standard-mit-ef47fda4d9.txt) |
| kurbo | 0.13.1 | Apache-2.0 OR MIT | through krilla, krilla-svg, resvg and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-cfc7749b96.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23c23145f6.txt) |
| libc | 0.2.191 | MIT OR Apache-2.0 | used directly | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-123a331b5d.txt) |
| libm | 0.2.16 | MIT | through krilla, krilla-svg, resvg and 1 more | [LICENSE.txt](ThirdPartyLicenses/rust/texts/apache-2.0-and-mit-3823dda7cf.txt) |
| litemap | 0.8.3 | Unicode-3.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE](ThirdPartyLicenses/rust/texts/unicode-3.0-f367c1b8e1.txt) |
| lock_api | 0.4.14 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-c9a75f18b9.txt) |
| log | 0.4.35 | MIT OR Apache-2.0 | through krilla, krilla-svg, reqwest and 6 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-6485b8ed31.txt) |
| lru-slab | 0.1.3 | MIT OR Apache-2.0 OR Zlib | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-cfc7749b96.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-1466d9b4f3.txt), [LICENSE-ZLIB](ThirdPartyLicenses/rust/texts/zlib-0978587727.txt) |
| markup5ever | 0.39.0 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-86dd7f026f.txt) |
| memchr | 2.8.3 | Unlicense OR MIT | through krilla, krilla-svg, reqwest and 7 more | [COPYING](ThirdPartyLicenses/rust/texts/other-01c266bced.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-0f96a83840.txt), [UNLICENSE](ThirdPartyLicenses/rust/texts/unlicense-7e12e5df4b.txt) |
| memmap2 | 0.9.12 | MIT OR Apache-2.0 | through krilla-svg, resvg, usvg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-04ea4849db.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-0d25d03b5a.txt) |
| mime | 0.3.18 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-8b87502edd.txt) |
| minisign-verify | 0.3.0 | MIT | through tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/mit-42c8695fbc.txt) |
| miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 | through krilla, krilla-svg, resvg and 4 more | [LICENSE](ThirdPartyLicenses/rust/texts/mit-4108245a1f.txt), [LICENSE-APACHE.md](ThirdPartyLicenses/rust/texts/apache-2.0-0d542e0c88.txt), [LICENSE-MIT.md](ThirdPartyLicenses/rust/texts/mit-799e9ca9d1.txt), [LICENSE-ZLIB.md](ThirdPartyLicenses/rust/texts/zlib-0a54e647fe.txt) |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 | through krilla, krilla-svg, resvg and 5 more | [LICENSE](ThirdPartyLicenses/rust/texts/mit-4108245a1f.txt), [LICENSE-APACHE.md](ThirdPartyLicenses/rust/texts/apache-2.0-0d542e0c88.txt), [LICENSE-MIT.md](ThirdPartyLicenses/rust/texts/mit-799e9ca9d1.txt), [LICENSE-ZLIB.md](ThirdPartyLicenses/rust/texts/zlib-0a54e647fe.txt) |
| mio | 1.2.4 | MIT | through reqwest, tauri, tauri-plugin-dialog and 3 more | [LICENSE](ThirdPartyLicenses/rust/texts/mit-07919255c7.txt) |
| muda | 0.20.0 | Apache-2.0 OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-2ab5537b8c.txt), [LICENSE.spdx](ThirdPartyLicenses/rust/texts/other-135bd40d7e.txt) |
| new_debug_unreachable | 1.0.6 | MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-f7715d38a3.txt) |
| num-conv | 0.2.2 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-Apache](ThirdPartyLicenses/rust/texts/apache-2.0-0d542e0c88.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-e2e245f2b5.txt) |
| num-traits | 0.2.19 | MIT OR Apache-2.0 | through krilla, krilla-svg, resvg and 5 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-6485b8ed31.txt) |
| objc2 | 0.6.5 | MIT | used directly | [standard text](ThirdPartyLicenses/rust/texts/standard-mit-85d2205f83.txt) |
| objc2-app-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [standard text](ThirdPartyLicenses/rust/texts/standard-mit-01b3e87fab.txt) |
| objc2-core-foundation | 0.3.2 | Zlib OR Apache-2.0 OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [standard text](ThirdPartyLicenses/rust/texts/standard-mit-8f070b3fe1.txt) |
| objc2-core-graphics | 0.3.2 | Zlib OR Apache-2.0 OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [standard text](ThirdPartyLicenses/rust/texts/standard-mit-99612b2ec8.txt) |
| objc2-encode | 4.1.0 | MIT | through objc2, tauri, tauri-plugin-dialog and 2 more | [standard text](ThirdPartyLicenses/rust/texts/standard-mit-85d2205f83.txt) |
| objc2-exception-helper | 0.1.1 | Zlib OR Apache-2.0 OR MIT | through objc2, tauri, tauri-plugin-dialog and 2 more | [standard text](ThirdPartyLicenses/rust/texts/standard-mit-85d2205f83.txt) |
| objc2-foundation | 0.3.2 | MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [standard text](ThirdPartyLicenses/rust/texts/standard-mit-36bb031130.txt) |
| objc2-io-surface | 0.3.2 | Zlib OR Apache-2.0 OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [standard text](ThirdPartyLicenses/rust/texts/standard-mit-31387f52ea.txt) |
| objc2-osa-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | through tauri-plugin-updater | [standard text](ThirdPartyLicenses/rust/texts/standard-mit-807451ad81.txt) |
| objc2-quartz-core | 0.3.2 | Zlib OR Apache-2.0 OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [standard text](ThirdPartyLicenses/rust/texts/standard-mit-8ee8be9332.txt) |
| objc2-web-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [standard text](ThirdPartyLicenses/rust/texts/standard-mit-babad58092.txt) |
| once_cell | 1.21.4 | MIT OR Apache-2.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| open | 5.4.5 | MIT | through tauri-plugin-opener | [LICENSE.md](ThirdPartyLicenses/rust/texts/mit-e63690624d.txt) |
| option-ext | 0.2.0 | MPL-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE.txt](ThirdPartyLicenses/rust/texts/mpl-2.0-3f3d9e0024.txt) |
| osakit | 0.3.1 | MIT OR Apache-2.0 | through tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-5fb3573f6e.txt) |
| parking_lot | 0.12.5 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-c9a75f18b9.txt) |
| parking_lot_core | 0.9.12 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-c9a75f18b9.txt) |
| pdf-writer | 0.15.0 | MIT OR Apache-2.0 | through krilla, krilla-svg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-508a77d2e7.txt) |
| percent-encoding | 2.3.2 | MIT OR Apache-2.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-b38f11f609.txt) |
| phf | 0.13.1 | MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/mit-0ab4d106b6.txt) |
| phf_shared | 0.13.1 | MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/mit-0ab4d106b6.txt) |
| pico-args | 0.5.0 | MIT | through krilla-svg, resvg, usvg | [LICENSE](ThirdPartyLicenses/rust/texts/mit-be8e392dd4.txt) |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT | through reqwest, tauri, tauri-plugin-dialog and 3 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-0d542e0c88.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| plist | 1.10.3 | MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENCE](ThirdPartyLicenses/rust/texts/mit-b61cf1a75b.txt) |
| png | 0.18.1 | MIT OR Apache-2.0 | through krilla, krilla-svg, resvg and 4 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-eaf40297c7.txt) |
| polycool | 0.4.0 | MIT OR Apache-2.0 | through krilla, krilla-svg, resvg and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-cfc7749b96.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23c23145f6.txt) |
| potential_utf | 0.1.6 | Unicode-3.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE](ThirdPartyLicenses/rust/texts/unicode-3.0-f367c1b8e1.txt) |
| powerfmt | 0.2.1 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-Apache](ThirdPartyLicenses/rust/texts/apache-2.0-155420c640.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-070dbc7dda.txt) |
| precomputed-hash | 0.1.1 | MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/mit-7ca6700600.txt) |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| quick-error | 2.0.1 | MIT OR Apache-2.0 | through krilla, krilla-svg, resvg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-b40930bbcf.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-058f01fe18.txt) |
| quick-xml | 0.42.0 | MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-MIT.md](ThirdPartyLicenses/rust/texts/mit-f0cf9b1c62.txt) |
| quinn | 0.11.12 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-c71d239df9.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-4b2d0aca67.txt) |
| quinn-proto | 0.11.19 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-c71d239df9.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-4b2d0aca67.txt) |
| quinn-udp | 0.5.16 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-c71d239df9.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-4b2d0aca67.txt) |
| quote | 1.0.47 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| rand | 0.10.3 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [COPYRIGHT](ThirdPartyLicenses/rust/texts/other-90eb64f027.txt), [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-35242e7a83.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-209fbbe0ad.txt) |
| rand_core | 0.10.1 | MIT OR Apache-2.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [COPYRIGHT](ThirdPartyLicenses/rust/texts/other-92b81db30f.txt), [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-6df43f6f4b.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-8b6e9feec0.txt) |
| rand_pcg | 0.10.2 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [COPYRIGHT](ThirdPartyLicenses/rust/texts/other-90eb64f027.txt), [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-6df43f6f4b.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-2234e3cefe.txt) |
| raw-window-handle | 0.6.2 | MIT OR Apache-2.0 OR Zlib | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE.md](ThirdPartyLicenses/rust/texts/apache-2.0-0d542e0c88.txt), [LICENSE-MIT.md](ThirdPartyLicenses/rust/texts/mit-9c5a80639a.txt), [LICENSE-ZLIB.md](ThirdPartyLicenses/rust/texts/zlib-ae895c8576.txt) |
| read-fonts | 0.39.2 | MIT OR Apache-2.0 | through krilla, krilla-svg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-021661359a.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-8a62fa27ff.txt) |
| ref-cast | 1.0.27 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| regex | 1.13.1 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-6485b8ed31.txt) |
| regex-automata | 0.4.18 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-6485b8ed31.txt) |
| regex-syntax | 0.8.11 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-6485b8ed31.txt) |
| reqwest | 0.13.5 | MIT OR Apache-2.0 | used directly | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-751963a8b8.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-917c0fe022.txt) |
| resvg | 0.47.0 | Apache-2.0 OR MIT | used directly | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a6cba85bc9.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-f5d934dc28.txt) |
| rfd | 0.17.2 | MIT | through tauri-plugin-dialog | [LICENSE](ThirdPartyLicenses/rust/texts/mit-65fc947f4b.txt) |
| rgb | 0.8.53 | MIT | through krilla-svg, resvg | [LICENSE](ThirdPartyLicenses/rust/texts/mit-457b464bc0.txt) |
| ring | 0.17.14 | Apache-2.0 AND ISC | through reqwest, tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/other-b3d734001a.txt), [LICENSE-BoringSSL](ThirdPartyLicenses/rust/texts/apache-2.0-005fc765dd.txt), [LICENSE-other-bits](ThirdPartyLicenses/rust/texts/isc-f025ccfb7d.txt) |
| roxmltree | 0.21.2 | MIT OR Apache-2.0 | through krilla-svg, resvg, usvg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-fffe218c1e.txt) |
| rustc-hash | 2.1.3 | Apache-2.0 OR MIT | through krilla, krilla-svg, reqwest and 4 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| rustix | 1.1.6 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | through tauri-plugin-updater | [COPYRIGHT](ThirdPartyLicenses/rust/texts/other-377c2e7c53.txt), [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-Apache-2.0_WITH_LLVM-exception](ThirdPartyLicenses/rust/texts/apache-2.0-a6c48161a0.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| rustls | 0.23.46 | Apache-2.0 OR ISC OR MIT | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-ISC](ThirdPartyLicenses/rust/texts/other-7cfafc877e.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-709e3175b4.txt) |
| rustls-pki-types | 1.16.0 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-45fd05c486.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-9117d922e6.txt) |
| rustls-platform-verifier | 0.7.1 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-c71d239df9.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-1c7cf76689.txt) |
| rustls-webpki | 0.103.16 | ISC | through reqwest, tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/isc-5b698ca138.txt) |
| rustybuzz | 0.20.1 | MIT | through krilla, krilla-svg, resvg and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/mit-3a7c3f0b88.txt) |
| ryu | 1.0.23 | Apache-2.0 OR BSL-1.0 | through krilla, krilla-svg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-BOOST](ThirdPartyLicenses/rust/texts/mit-c9bff75738.txt) |
| same-file | 1.0.6 | Unlicense OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [COPYING](ThirdPartyLicenses/rust/texts/other-01c266bced.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-cb3c929a05.txt), [UNLICENSE](ThirdPartyLicenses/rust/texts/unlicense-7e12e5df4b.txt) |
| schemars | 0.8.22 | MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/mit-1954992a2b.txt) |
| schemars | 0.9.0 | MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/mit-1954992a2b.txt) |
| schemars | 1.2.3 | MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/mit-1954992a2b.txt) |
| scopeguard | 1.2.0 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-fb77f0a9c5.txt) |
| security-framework | 3.7.0 | MIT OR Apache-2.0 | used directly | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-91e934255b.txt) |
| security-framework-sys | 2.17.0 | MIT OR Apache-2.0 | through reqwest, security-framework, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-91e934255b.txt) |
| selectors | 0.38.0 | MPL-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [standard text](ThirdPartyLicenses/rust/texts/mpl-2.0-1f256ecad1.txt) |
| semver | 1.0.28 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| serde | 1.0.229 | MIT OR Apache-2.0 | used directly | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| serde-untagged | 0.1.9 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| serde_core | 1.0.229 | MIT OR Apache-2.0 | through krilla, krilla-svg, reqwest and 10 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| serde_json | 1.0.154 | MIT OR Apache-2.0 | used directly | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| serde_spanned | 1.1.3 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-05c58f1374.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-6efb0476a1.txt) |
| serde_with | 3.24.0 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-7576269ea7.txt) |
| serialize-to-javascript | 0.1.2 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-c71d239df9.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-e53a7165e8.txt) |
| servo_arc | 0.4.3 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| simd-adler32 | 0.3.10 | MIT | through krilla, krilla-svg, resvg and 5 more | [LICENSE.md](ThirdPartyLicenses/rust/texts/mit-42a3517023.txt) |
| simplecss | 0.2.2 | Apache-2.0 OR MIT | through krilla-svg, resvg, usvg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-0b5f245243.txt) |
| siphasher | 1.0.4 | MIT OR Apache-2.0 | through krilla, krilla-svg, resvg and 5 more | [COPYING](ThirdPartyLicenses/rust/texts/other-c962ee4d1d.txt), [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-cfc7749b96.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-f9c4c77baa.txt) |
| skrifa | 0.42.1 | MIT OR Apache-2.0 | through krilla, krilla-svg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-021661359a.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-8a62fa27ff.txt) |
| slab | 0.4.12 | MIT | through reqwest, tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/mit-8ce0830173.txt) |
| slotmap | 1.1.1 | Zlib | through krilla-svg, resvg, usvg | [LICENSE](ThirdPartyLicenses/rust/texts/zlib-6cec81441b.txt) |
| smallvec | 1.16.5 | MIT OR Apache-2.0 | through krilla, krilla-svg, reqwest and 6 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-0b28172679.txt) |
| socket2 | 0.6.5 | MIT OR Apache-2.0 | through reqwest, tauri, tauri-plugin-dialog and 3 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-378f5840b2.txt) |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 | through krilla, krilla-svg, reqwest and 4 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-3c125f249f.txt) |
| strict-num | 0.1.1 | MIT | through krilla, krilla-svg, resvg and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/mit-3085885678.txt) |
| string_cache | 0.9.0 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-62065228e4.txt) |
| subsetter | 0.2.6 | MIT OR Apache-2.0 | through krilla, krilla-svg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-508a77d2e7.txt), [NOTICE](ThirdPartyLicenses/rust/texts/mit-756e3179c6.txt) |
| subtle | 2.6.1 | BSD-3-Clause | through reqwest, tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/bsd-cc0332a88c.txt) |
| svgtypes | 0.16.2 | Apache-2.0 OR MIT | through krilla-svg, resvg, usvg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-bb7d16c928.txt) |
| swift-rs | 1.0.9 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-ccaab19135.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-f3c3e9f4fe.txt) |
| sync_wrapper | 1.0.2 | Apache-2.0 | through reqwest, tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/apache-2.0-0d542e0c88.txt) |
| system-configuration | 0.7.0 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-000cbb5bea.txt) |
| system-configuration-sys | 0.6.0 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-000cbb5bea.txt) |
| tao | 0.37.2 | Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/apache-2.0-a8ad31b1c3.txt), [LICENSE.spdx](ThirdPartyLicenses/rust/texts/other-02b6448337.txt) |
| tar | 0.4.46 | MIT OR Apache-2.0 | through tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-8ca6b96cea.txt) |
| tauri | 2.12.5 | Apache-2.0 OR MIT | used directly | [LICENSE-APACHE-2.0](ThirdPartyLicenses/rust/texts/apache-2.0-0d542e0c88.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-9dd42ea92c.txt) |
| tauri-plugin-dialog | 2.8.4 | Apache-2.0 OR MIT | used directly | [LICENSE.spdx](ThirdPartyLicenses/rust/texts/other-9c1db6b7e7.txt), [LICENSE_APACHE-2.0](ThirdPartyLicenses/rust/texts/apache-2.0-0d542e0c88.txt), [LICENSE_MIT](ThirdPartyLicenses/rust/texts/mit-9dd42ea92c.txt) |
| tauri-plugin-fs | 2.7.1 | Apache-2.0 OR MIT | through tauri-plugin-dialog | [LICENSE.spdx](ThirdPartyLicenses/rust/texts/other-9c1db6b7e7.txt), [LICENSE_APACHE-2.0](ThirdPartyLicenses/rust/texts/apache-2.0-0d542e0c88.txt), [LICENSE_MIT](ThirdPartyLicenses/rust/texts/mit-9dd42ea92c.txt) |
| tauri-plugin-opener | 2.7.3 | Apache-2.0 OR MIT | used directly | [LICENSE.spdx](ThirdPartyLicenses/rust/texts/other-9c1db6b7e7.txt), [LICENSE_APACHE-2.0](ThirdPartyLicenses/rust/texts/apache-2.0-0d542e0c88.txt), [LICENSE_MIT](ThirdPartyLicenses/rust/texts/mit-9dd42ea92c.txt) |
| tauri-plugin-updater | 2.14.1 | Apache-2.0 OR MIT | used directly | [LICENSE.spdx](ThirdPartyLicenses/rust/texts/other-9c1db6b7e7.txt), [LICENSE_APACHE-2.0](ThirdPartyLicenses/rust/texts/apache-2.0-0d542e0c88.txt), [LICENSE_MIT](ThirdPartyLicenses/rust/texts/mit-9dd42ea92c.txt) |
| tauri-runtime | 2.12.2 | Apache-2.0 OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE-2.0](ThirdPartyLicenses/rust/texts/apache-2.0-0d542e0c88.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-9dd42ea92c.txt) |
| tauri-runtime-wry | 2.12.3 | Apache-2.0 OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE-2.0](ThirdPartyLicenses/rust/texts/apache-2.0-0d542e0c88.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-9dd42ea92c.txt) |
| tauri-utils | 2.10.2 | Apache-2.0 OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE-2.0](ThirdPartyLicenses/rust/texts/apache-2.0-0d542e0c88.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-9dd42ea92c.txt) |
| tempfile | 3.27.0 | MIT OR Apache-2.0 | through tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-8b427f5bc5.txt) |
| tendril | 0.5.1 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-60a7062291.txt) |
| thiserror | 2.0.21 | MIT OR Apache-2.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| time | 0.3.55 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-Apache](ThirdPartyLicenses/rust/texts/apache-2.0-0d542e0c88.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-2537228d9a.txt) |
| time-core | 0.1.9 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-Apache](ThirdPartyLicenses/rust/texts/apache-2.0-0d542e0c88.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-2537228d9a.txt) |
| tiny-skia | 0.12.0 | BSD-3-Clause | through krilla-svg, resvg | [LICENSE](ThirdPartyLicenses/rust/texts/bsd-6d41e05f1d.txt) |
| tiny-skia-path | 0.12.0 | BSD-3-Clause | through krilla, krilla-svg, resvg and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/bsd-6d41e05f1d.txt) |
| tinystr | 0.8.5 | Unicode-3.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE](ThirdPartyLicenses/rust/texts/unicode-3.0-f367c1b8e1.txt) |
| tinyvec | 1.13.3 | Zlib OR Apache-2.0 OR MIT | through krilla-svg, reqwest, resvg and 5 more | [LICENSE-APACHE.md](ThirdPartyLicenses/rust/texts/apache-2.0-cfc7749b96.txt), [LICENSE-MIT.md](ThirdPartyLicenses/rust/texts/mit-fd80a26fbb.txt), [LICENSE-ZLIB.md](ThirdPartyLicenses/rust/texts/zlib-84b34dd760.txt) |
| tokio | 1.54.1 | MIT | used directly | [LICENSE](ThirdPartyLicenses/rust/texts/mit-253cd04c67.txt) |
| tokio-rustls | 0.26.6 | MIT OR Apache-2.0 | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-cc117d90b4.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-e20fa2b8e0.txt) |
| tokio-util | 0.7.20 | MIT | through reqwest, tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/mit-253cd04c67.txt) |
| toml | 1.2.1+spec-1.1.0 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-05c58f1374.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-6efb0476a1.txt) |
| toml_datetime | 1.1.3+spec-1.1.0 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-05c58f1374.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-6efb0476a1.txt) |
| toml_parser | 1.1.5+spec-1.1.0 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-05c58f1374.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-6efb0476a1.txt) |
| toml_writer | 1.2.0+spec-1.1.0 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-05c58f1374.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-6efb0476a1.txt) |
| tower | 0.5.3 | MIT | through reqwest, tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/mit-4249c8e6c5.txt) |
| tower-http | 0.6.11 | MIT | through reqwest, tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/mit-5049cf4649.txt) |
| tower-layer | 0.3.3 | MIT | through reqwest, tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/mit-4249c8e6c5.txt) |
| tower-service | 0.3.3 | MIT | through reqwest, tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/mit-4249c8e6c5.txt) |
| tracing | 0.1.44 | MIT | through reqwest, tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/mit-898b1ae982.txt) |
| tracing-core | 0.1.36 | MIT | through reqwest, tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/mit-898b1ae982.txt) |
| tray-icon | 0.25.1 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-2ab5537b8c.txt), [LICENSE.spdx](ThirdPartyLicenses/rust/texts/other-44181d1db7.txt) |
| try-lock | 0.2.5 | MIT | through reqwest, tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/mit-8b62775bac.txt) |
| ttf-parser | 0.25.1 | MIT OR Apache-2.0 | through krilla, krilla-svg, resvg and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-bb7d16c928.txt) |
| typeid | 1.0.3 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| unicode-bidi | 0.3.18 | MIT OR Apache-2.0 | through krilla-svg, resvg, usvg | [COPYRIGHT](ThirdPartyLicenses/rust/texts/other-edb20b474f.txt), [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-7b63ecd5f1.txt) |
| unicode-bidi-mirroring | 0.4.0 | MIT OR Apache-2.0 | through krilla, krilla-svg, resvg and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-59a1fdac3b.txt) |
| unicode-ccc | 0.4.0 | MIT OR Apache-2.0 | through krilla, krilla-svg, resvg and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-59a1fdac3b.txt) |
| unicode-ident | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt), [LICENSE-UNICODE](ThirdPartyLicenses/rust/texts/unicode-3.0-f7db810517.txt) |
| unicode-properties | 0.1.5 | (MIT OR Apache-2.0) AND Unicode-3.0 | through krilla, krilla-svg, resvg and 1 more | [COPYRIGHT](ThirdPartyLicenses/rust/texts/other-23860c2a7b.txt), [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-7b63ecd5f1.txt), [LICENSE-UNICODE](ThirdPartyLicenses/rust/texts/unicode-3.0-e7a93b0095.txt) |
| unicode-script | 0.5.9 | MIT OR Apache-2.0 | through krilla, krilla-svg, resvg and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-512a9e571c.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-15656cc11a.txt) |
| unicode-vo | 0.1.0 | MIT OR Apache-2.0 | through krilla-svg, resvg, usvg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-0b5f245243.txt) |
| untrusted | 0.9.0 | ISC | through reqwest, tauri-plugin-updater | [LICENSE.txt](ThirdPartyLicenses/rust/texts/isc-7abd9b6960.txt) |
| url | 2.5.8 | MIT OR Apache-2.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-b38f11f609.txt) |
| urlpattern | 0.6.0 | MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE](ThirdPartyLicenses/rust/texts/mit-5cf1c9dc61.txt) |
| usvg | 0.47.0 | Apache-2.0 OR MIT | used directly | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a6cba85bc9.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-f5d934dc28.txt) |
| utf8_iter | 1.1.0 | Apache-2.0 OR MIT | through reqwest, tauri, tauri-plugin-dialog and 2 more | [COPYRIGHT](ThirdPartyLicenses/rust/texts/other-c30152c94a.txt), [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-cfc7749b96.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-3fa4ca83dc.txt) |
| utf_types | 1.0.0 | Apache-2.0 OR MIT | through reqwest, tauri, tauri-plugin-dialog and 2 more | [COPYRIGHT](ThirdPartyLicenses/rust/texts/other-3210be7332.txt), [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-cfc7749b96.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-3fa4ca83dc.txt) |
| uuid | 1.29.2 | Apache-2.0 OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-436bc5a105.txt) |
| walkdir | 2.5.0 | Unlicense OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [COPYING](ThirdPartyLicenses/rust/texts/other-01c266bced.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-0f96a83840.txt), [UNLICENSE](ThirdPartyLicenses/rust/texts/unlicense-7e12e5df4b.txt) |
| want | 0.3.2 | MIT | through reqwest, tauri-plugin-updater | [LICENSE](ThirdPartyLicenses/rust/texts/mit-96d741569b.txt) |
| web-time | 1.1.0 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-54a744942e.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-f428305bbf.txt) |
| web_atoms | 0.2.6 | MIT OR Apache-2.0 | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-86dd7f026f.txt) |
| weezl | 0.1.12 | MIT OR Apache-2.0 | through krilla, krilla-svg, resvg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-776aa6f890.txt) |
| window-vibrancy | 0.8.1 | Apache-2.0 OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-617b85f62a.txt), [LICENSE.spdx](ThirdPartyLicenses/rust/texts/other-7ccef0d35e.txt) |
| winnow | 1.0.5 | MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-cb5aedb296.txt) |
| write-fonts | 0.48.1 | MIT OR Apache-2.0 | through krilla, krilla-svg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-021661359a.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-8a62fa27ff.txt) |
| writeable | 0.6.4 | Unicode-3.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE](ThirdPartyLicenses/rust/texts/unicode-3.0-f367c1b8e1.txt) |
| wry | 0.57.2 | Apache-2.0 OR MIT | through tauri, tauri-plugin-dialog, tauri-plugin-opener and 1 more | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-ef88893533.txt), [LICENSE.spdx](ThirdPartyLicenses/rust/texts/other-f730414685.txt) |
| xattr | 1.7.0 | MIT OR Apache-2.0 | through tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-a60eea8175.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-8b427f5bc5.txt) |
| xmlwriter | 0.1.0 | MIT | through krilla-svg, resvg, usvg | [LICENSE](ThirdPartyLicenses/rust/texts/mit-2cdce1ff4c.txt) |
| xmp-writer | 0.3.3 | MIT OR Apache-2.0 | through krilla, krilla-svg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-62c7a1e35f.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-508a77d2e7.txt) |
| yoke | 0.8.4 | Unicode-3.0 | through krilla, krilla-svg, reqwest and 4 more | [LICENSE](ThirdPartyLicenses/rust/texts/unicode-3.0-f367c1b8e1.txt) |
| zerofrom | 0.1.8 | Unicode-3.0 | through krilla, krilla-svg, reqwest and 4 more | [LICENSE](ThirdPartyLicenses/rust/texts/unicode-3.0-f367c1b8e1.txt) |
| zeroize | 1.9.1 | Apache-2.0 OR MIT | through reqwest, tauri-plugin-updater | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-cfc7749b96.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-8c7516d4b2.txt) |
| zerotrie | 0.2.5 | Unicode-3.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE](ThirdPartyLicenses/rust/texts/unicode-3.0-f367c1b8e1.txt) |
| zerovec | 0.11.9 | Unicode-3.0 | through reqwest, tauri, tauri-plugin-dialog and 2 more | [LICENSE](ThirdPartyLicenses/rust/texts/unicode-3.0-f367c1b8e1.txt) |
| zlib-rs | 0.6.8 | Zlib | through krilla, krilla-svg, resvg and 5 more | [LICENSE](ThirdPartyLicenses/rust/texts/zlib-ae078f5c30.txt) |
| zmij | 1.0.23 | MIT | through reqwest, serde_json, tauri and 3 more | [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-23f18e03dc.txt) |
| zune-core | 0.5.3 | MIT OR Apache-2.0 OR Zlib | through krilla, krilla-svg, resvg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-c71d239df9.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-d30047bca3.txt), [LICENSE-ZLIB](ThirdPartyLicenses/rust/texts/zlib-d201d14804.txt) |
| zune-jpeg | 0.5.15 | MIT OR Apache-2.0 OR Zlib | through krilla, krilla-svg, resvg | [LICENSE-APACHE](ThirdPartyLicenses/rust/texts/apache-2.0-c71d239df9.txt), [LICENSE-MIT](ThirdPartyLicenses/rust/texts/mit-d30047bca3.txt), [LICENSE-ZLIB](ThirdPartyLicenses/rust/texts/zlib-d201d14804.txt) |
