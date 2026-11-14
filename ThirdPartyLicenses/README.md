# Third-party licences in this build

<!-- Written by scripts/notices.mjs. Do not edit: change the script and run `node scripts/notices.mjs`. -->

Qnet 2.1.2 carries 11 native libraries, the 16 components of the bundled Python runtime, 11 npm packages and 305 Rust crates. This folder holds their licence texts;
`THIRD-PARTY-NOTICES.md` in Qnet's source lists every component with its version and licence.

- `cjson/`, `highs/`, `libomp/`, `suite-sparse/`: the solvers' native libraries
  (`Contents/Frameworks`), with the licence files from the release sources they were built from.
  `native-libraries.json` records each component's version, source archive and sha256, and each
  library's version, licence and the solvers that load it.
  `suite-sparse/LICENSE.txt` covers all of SuiteSparse, more than the libraries Qnet uses;
  `GPL-2.0.txt` and `LGPL-2.1.txt` beside it are the licences it names, as SuiteSparse ships them.
- `python/`: the bundled Python runtime (`Contents/Resources/python`). `python-components.json` is the
  record `scripts/stage-python.sh` writes: each component's version, archive, sha256, licence and the
  licence texts inside the runtime. Each distinct text is kept once in `python/texts/`, and
  `python/texts.json` says which runtime file each one is; the runtime keeps its own copies too.
- `npm/`: the interface's packages, one folder each. [npm/INDEX.md](npm/INDEX.md).
- `rust/`: the application's crates. [rust/INDEX.md](rust/INDEX.md) names the texts for each crate;
  identical texts are kept once in `rust/texts/`.

| Component | Version | Licence | Libraries |
| --- | --- | --- | --- |
| cJSON | 1.7.19 | MIT | libcjson.1.dylib |
| HiGHS | 1.16.0 | MIT | libhighs.1.dylib |
| LLVM OpenMP runtime (libomp) | 23.1.5 | Apache-2.0 WITH LLVM-exception | libomp.dylib |
| SuiteSparse | 7.14.1 | BSD-3-Clause; LGPL-2.1-or-later AND GPL-2.0-or-later AND Apache-2.0; LGPL-2.1-or-later; GPL-2.0-or-later | libamd.3.dylib, libcamd.3.dylib, libccolamd.3.dylib, libcholmod.5.dylib, libcolamd.3.dylib, libcxsparse.4.dylib, libsuitesparseconfig.7.dylib, libumfpack.6.dylib |

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
- The GPL's text is `suite-sparse/GPL-2.0.txt`.

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
files, kept there and copied to `python/texts/` (32 distinct texts for 32 licence files).

| Component | Version | Licence | What it is | Texts |
| --- | --- | --- | --- | --- |
| CPython | 3.15.2 | Python-2.0 AND CNRI-Python | interpreter and standard library | [cpython-86e6141582.txt](python/texts/cpython-86e6141582.txt), [cpython-b0e25a78cf.txt](python/texts/cpython-b0e25a78cf.txt) |
| bzip2 |  | bzip2-1.0.6 | linked into the interpreter (modules: _bz2) | [bzip2-1f38bbc7ca.txt](python/texts/bzip2-1f38bbc7ca.txt) |
| Expat | 2.10.0 | MIT | linked into the interpreter (modules: pyexpat) | [expat-122f2c2700.txt](python/texts/expat-122f2c2700.txt) |
| libedit |  | BSD-3-Clause | linked into the interpreter (modules: readline) | [libedit-29cea33c32.txt](python/texts/libedit-29cea33c32.txt) |
| libffi |  | MIT | linked into the interpreter (modules: _ctypes) | [libffi-deaf3a42ef.txt](python/texts/libffi-deaf3a42ef.txt) |
| XZ Utils (liblzma) |  | 0BSD | linked into the interpreter (modules: _lzma) | [liblzma-9a4062de0a.txt](python/texts/liblzma-9a4062de0a.txt) |
| libuuid |  | BSD-3-Clause | linked into the interpreter (modules: _uuid) | [libuuid-122ee1f7e2.txt](python/texts/libuuid-122ee1f7e2.txt) |
| mpdecimal | 4.0.0 | BSD-2-Clause | linked into the interpreter (modules: _decimal) | [mpdecimal-669512af72.txt](python/texts/mpdecimal-669512af72.txt) |
| ncurses |  | X11 | linked into the interpreter (modules: _curses, _curses_panel) | [ncurses-87a4c44423.txt](python/texts/ncurses-87a4c44423.txt) |
| OpenSSL | 3.5.9 | Apache-2.0 | linked into the interpreter (modules: _hashlib, _ssl) | [openssl-3-7d5450cb2d.txt](python/texts/openssl-3-7d5450cb2d.txt) |
| SQLite | 3.53.1 | blessing | linked into the interpreter (modules: _sqlite3) | [sqlite-38bef3d28b.txt](python/texts/sqlite-38bef3d28b.txt) |
| zlib |  | Zlib | linked into the interpreter (modules: _sqlite3, binascii, zlib) | [zlib-e32ff4e00d.txt](python/texts/zlib-e32ff4e00d.txt) |
| zlib-ng |  | Zlib | linked into the interpreter (modules: _sqlite3, binascii, zlib) | [zlib-ng-6c9f0d975b.txt](python/texts/zlib-ng-6c9f0d975b.txt) |
| Zstandard | 1.5.7 | BSD-3-Clause | linked into the interpreter (modules: _remote_debugging, _zstd) | [zstd-7055266497.txt](python/texts/zstd-7055266497.txt) |
| NumPy | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | array library the CTMC and adaptive BAR solvers import | [numpy-649a589ab3.txt](python/texts/numpy-649a589ab3.txt), [numpy-libdivide-fbc539f47d.txt](python/texts/numpy-libdivide-fbc539f47d.txt), [numpy-pythoncapi-compat-3f2c1ffa76.txt](python/texts/numpy-pythoncapi-compat-3f2c1ffa76.txt), [numpy-highway-e340270d4f.txt](python/texts/numpy-highway-e340270d4f.txt), [numpy-multiarray-f7b14309e5.txt](python/texts/numpy-multiarray-f7b14309e5.txt), [numpy-x86-simd-sort-211e7d737d.txt](python/texts/numpy-x86-simd-sort-211e7d737d.txt), [numpy-svml-c17011467b.txt](python/texts/numpy-svml-c17011467b.txt), [numpy-pocketfft-a85ca13fdf.txt](python/texts/numpy-pocketfft-a85ca13fdf.txt), [numpy-lapack-lite-a14cc25e10.txt](python/texts/numpy-lapack-lite-a14cc25e10.txt), [numpy-ma-05f3b88351.txt](python/texts/numpy-ma-05f3b88351.txt), [numpy-random-103166b62b.txt](python/texts/numpy-random-103166b62b.txt), [numpy-distributions-469778be8f.txt](python/texts/numpy-distributions-469778be8f.txt), [numpy-mt19937-0e111337b2.txt](python/texts/numpy-mt19937-0e111337b2.txt), [numpy-pcg64-e7d4f4fb20.txt](python/texts/numpy-pcg64-e7d4f4fb20.txt), [numpy-philox-6f5828a572.txt](python/texts/numpy-philox-6f5828a572.txt), [numpy-sfc64-9d40988460.txt](python/texts/numpy-sfc64-9d40988460.txt), [numpy-splitmix64-268b0ca067.txt](python/texts/numpy-splitmix64-268b0ca067.txt) |
| OpenBLAS and the GNU Fortran runtime (inside the NumPy wheel) |  | BSD-3-Clause (OpenBLAS); BSD-3-Clause-Open-MPI (LAPACK inside OpenBLAS); GPL-3.0-or-later WITH GCC-exception-3.1 (libgfortran, libgcc_s); LGPL-2.1-or-later (libquadmath) | linear algebra for NumPy: libgcc_s.1.1.dylib, libgfortran.5.dylib, libquadmath.0.dylib, libscipy_openblas64_.dylib | [numpy-649a589ab3.txt](python/texts/numpy-649a589ab3.txt) |

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
other licences; its text and the GPL version 3 are in NumPy's licence file, `python/texts/numpy-649a589ab3.txt`,
which also states libquadmath's terms. libquadmath is a separate dynamic library, so it can be
replaced by a rebuilt copy; the LGPL-2.1 text is `suite-sparse/LGPL-2.1.txt`. Their source is
GCC's: https://gcc.gnu.org/ (libgfortran, libgcc, libquadmath).
