//! The display-precision filter against 0.90.34's own perl program.
//!
//! `fixtures/output/outfmt.pl` is `outputPrecisionProgram` exactly as QnetGUIApp.swift wrote it to
//! `BNET_outfmt_<pid>.pl` (the Swift string literal with its indentation stripped and `\\` read as
//! `\`; the file itself was deleted by every wrapper's EXIT trap, so it is reconstructed from the
//! source). Each test runs `perl outfmt.pl <decimals>` with its input on a file, so `select` always
//! finds stdin ready and no idle release can split a record, and asserts that
//! `output::precision` gives the same bytes. Without perl the differential tests print a note and
//! pass.

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use qnet_core::output::precision::{filter_all, PrecisionFilter};

fn program() -> PathBuf {
    common::root().join("core/tests/fixtures/output/outfmt.pl")
}

fn have_perl() -> bool {
    let ok = Command::new("perl").arg("-e").arg("1").status().is_ok_and(|s| s.success());
    if !ok {
        eprintln!("NOTE: perl is not available; the differential precision tests are skipped");
    }
    ok
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qnet-output-precision-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

/// What 0.90.34's program prints for `input` at `decimals` (the argument is passed as given, so
/// out-of-range values exercise the program's own clamp).
fn perl(input: &[u8], decimals: &str) -> Vec<u8> {
    // One file per call: the tests run in parallel.
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path = scratch(&format!("in-{n}.txt"));
    std::fs::write(&path, input).unwrap();
    let out = Command::new("perl")
        .arg(program())
        .arg(decimals)
        .stdin(std::fs::File::open(&path).unwrap())
        .output()
        .unwrap();
    let _ = std::fs::remove_file(&path);
    assert!(out.status.success(), "perl failed: {}", String::from_utf8_lossy(&out.stderr));
    out.stdout
}

/// Every golden run directory holding an archive.
fn run_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    let runs = common::root().join("golden/runs");
    let Ok(examples) = std::fs::read_dir(&runs) else { return v };
    for e in examples.flatten() {
        let Ok(methods) = std::fs::read_dir(e.path()) else { continue };
        for m in methods.flatten() {
            if m.path().join("archive.txt").exists() {
                v.push(m.path());
            }
        }
    }
    v.sort();
    v
}

/// The decimals a golden wrapper passed to its filter (`… outfmt_<pid>.pl" <D>; else exec cat`).
fn script_decimals(dir: &Path) -> Option<i64> {
    let script = std::fs::read_to_string(dir.join("script.sh")).ok()?;
    let i = script.find("exec perl \"")? + 11;
    let rest = &script[i + script[i..].find("\" ")? + 2..];
    rest[..rest.find(';')?].trim().parse().ok()
}

fn first_difference(a: &[u8], b: &[u8]) -> String {
    let i = a.iter().zip(b).position(|(x, y)| x != y).unwrap_or(a.len().min(b.len()));
    let lo = i.saturating_sub(80);
    format!(
        "at byte {i}:\n  ours:   {:?}\n  oracle: {:?}",
        String::from_utf8_lossy(&a[lo..(i + 80).min(a.len())]),
        String::from_utf8_lossy(&b[lo..(i + 80).min(b.len())])
    )
}

fn assert_same(what: &str, ours: &[u8], oracle: &[u8]) {
    assert!(ours == oracle, "{what} differs {}", first_difference(ours, oracle));
}

/// Hand-written records aimed at each rule of the program.
fn edge_cases() -> String {
    let mut s = String::new();
    let lines = [
        // columns, growth and debt
        "rho_1      0.70012345   1.5   22.123456789\n",
        "  E[Z_1^k]      E[Z_2^k]\n  0.1234567890  12.345678901\n",
        "1.5 2.5 3.5\n",
        "1.23456789012345678\t9.87654321\n",
        "     123.4567     234.5678   0.0001\n",
        // prose
        "generator residual = 4.11409192216e-13\n",
        "mean_number_in_system: 0.98283912 (sequential interval [7.30, 10.88]; effective cycles 5442.3)\n",
        "  drift         = -1.0000 0.0000\n",
        "[Parse] 0.000 s\n",
        "[Total] 0.155 s\n",
        "the utilisation is 0.5.\n",
        "#   W                 0.123456\n",
        "#   W                 = 0.123456\n",
        // scope
        "S1.2 0.90.34 /tmp/x_3.4.sh python@3.11/lib x/1.5 1.5/x (+1.2%) 12% 3 abc1.5 1.5abc\n",
        "a-1.5 x--2.5 -.5 +.25 +3.0 -0.0 -0.0000001 1e-9 6.02e23 7E+5 5e 5e+ 1.5e+x 2.e3\n",
        ".5. .5.x 1.5.\n",
        "Python 3.11 rocks\n",
        // thresholds and notation
        "1e-06 1.00000e-06 1.0000000000000001e-06 9.999996e-07 0.000001 0.0000005\n",
        "1000000000.000 999999999.9999 1e9 1.00e+09 3.456789e+20 -3.456789e+20 1e999 -1e999\n",
        "0.000 -0.000 0.0 -0 0e0 -0e0 0.0e-5 4.567e-09 4.56700e-09 4e-09 4.e-09\n",
        "Optimal u* = 0.0000000000e+00\n",
        "+0.5 +0.00001 +1e-7 -1.5 -0.4 -0.5 -0.6 0.5 1.5 2.5\n",
        // ANSI
        "\x1b[7m \x1b[27m 1.234567 \x1b[1;31m2.5\x1b[0m\n",
        "\x1b[K\x1b[A\x1b[2K 0.33333333\n",
        "\x1b[ 1.5\n",
        // sentinels
        "QNET_NODE_METRIC_V1 metric=L estimate=1.9999999999722793\n",
        "QNET_QBD_METRIC_V1 a=1.5\n",
        "QNET_QBD_EVIDENCE_V1 value=M%2FM%2F1\n",
        "QNET_QBD_ERROR_V1 x\n",
        "QNET_QBD_ERROR_V1x 1.5\n",
        "QNET_METHOD_FAILURE_V1 method=sm exit=1\n",
        "QNET_MLMC_STATUS_V1 adaptive=yes precision_met=no cap_hits=3\n",
        "QNET_X_V1 estimate=1 standard_error=0.000000 ci_low=1.000000 ci_high=2.5e-9 ci_half_width=.5 effective_cycles=4345.2 level=1.5\n",
        "QNET_X_V1 estimate=1.5;ci_low=2.5,ci_high=3.5 xestimate=1.5 estimate=1.5x estimate=1. estimate=-.5e3\n",
        "QNET_X_V1 estimate=1.5",
        "\n",
        "QNET_X_V1a estimate=1.5 0.5\n",
        "QNET_V1 estimate=1.5\n",
        "QNET__V1 estimate=1.5\n",
        "QNET_A_V1_V1 estimate=1.5\n",
        "xQNET_A_V1 estimate=1.5\n",
        // CR progress frames and CRLF
        "Running ...  [   ]  starting ...\r\x1b[KRunning ...  [###]  3/3  (100%)     0.0s\n",
        "a 1.5\r\n2.5 3.5\r\n",
        // non-ASCII neighbours
        "rho_max = 0.7000 at S1  (moderate load — SRBM) ± 0.123456 µ1.5 é 2.5\n",
        "0.1234567 —  0.5 ±1.5\n",
        "",
    ];
    for l in lines {
        s.push_str(l);
    }
    s
}

/// A deterministic pseudo-random generator for the fuzz inputs.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// Random records built from number-like and separator pieces.
fn fuzz(seed: u64, records: usize) -> String {
    let mut r = Rng(seed);
    let pieces = [
        " ", "  ", "    ", "=", ":", ",", ".", "-", "+", "e", "E", "%", "/", "@", "_", "x", "S", "\t", "(", ")", "[", "]", ";",
        "\x1b[7m", "\x1b[0m", "—", "±", "QNET_", "estimate=", "ci_low=", "_V1 ",
    ];
    let mut s = String::new();
    for _ in 0..records {
        if r.below(10) == 0 {
            s.push_str("QNET_RANDOM_V1 ");
        }
        let n = 1 + r.below(12);
        for _ in 0..n {
            match r.below(4) {
                0 => s.push_str(pieces[r.below(pieces.len() as u64) as usize]),
                1 => {
                    let ip = r.below(10_000) / (1 + r.below(1000));
                    s.push_str(&ip.to_string());
                }
                _ => {
                    // a decimal with a random spelling
                    if r.below(5) == 0 {
                        s.push('-');
                    }
                    let digits = r.below(18);
                    let int = r.below(1_000_000) / 10u64.pow(r.below(6) as u32);
                    let frac: String = (0..digits).map(|_| char::from(b'0' + r.below(10) as u8)).collect();
                    if r.below(8) == 0 {
                        s.push_str(&format!(".{frac}1"));
                    } else {
                        s.push_str(&format!("{int}.{frac}0"));
                    }
                    if r.below(4) == 0 {
                        s.push_str(&format!("e{}{}", ["", "+", "-"][r.below(3) as usize], r.below(30)));
                    }
                }
            }
        }
        s.push_str(["\n", "\n", "\n", "\r", "\r\n"][r.below(5) as usize]);
    }
    s
}

#[test]
fn hand_written_edge_cases_match_perl_at_every_setting() {
    if !have_perl() {
        return;
    }
    let input = edge_cases();
    for d in ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "-3", "12"] {
        let ours = filter_all(input.as_bytes(), d.parse().unwrap(), true);
        assert_same(&format!("edge cases at {d}"), &ours, &perl(input.as_bytes(), d));
    }
}

#[test]
fn random_records_match_perl_at_every_setting() {
    if !have_perl() {
        return;
    }
    for (i, d) in (0..=9).enumerate() {
        let input = fuzz(0x9E37_79B9_7F4A_7C15 ^ (i as u64 + 1), 3000);
        let ours = filter_all(input.as_bytes(), d, true);
        assert_same(&format!("fuzz at {d}"), &ours, &perl(input.as_bytes(), &d.to_string()));
    }
}

#[test]
fn every_golden_archive_matches_perl_at_every_setting() {
    if !have_perl() {
        return;
    }
    let mut all = Vec::new();
    for dir in run_dirs() {
        all.extend(std::fs::read(dir.join("archive.txt")).unwrap());
        all.push(b'\n');
    }
    if all.is_empty() {
        eprintln!("NOTE: golden/runs holds no archives yet");
        return;
    }
    // perl takes several seconds over the whole corpus, so the ten settings run side by side.
    std::thread::scope(|s| {
        let all = &all;
        let handles: Vec<_> = (0..=9).map(|d| s.spawn(move || (d, perl(all, &d.to_string())))).collect();
        for h in handles {
            let (d, oracle) = h.join().unwrap();
            assert_same(&format!("archives at {d}"), &filter_all(all, d, true), &oracle);
        }
    });
}

#[test]
fn every_golden_display_is_its_archive_filtered() {
    // display.txt begins with the wrapper's own `\e[A\e[2K` (erasing the typed `bash …` line),
    // which is not the filter's.
    let mut checked = 0;
    for dir in run_dirs() {
        let Some(d) = script_decimals(&dir) else { continue };
        let archive = std::fs::read(dir.join("archive.txt")).unwrap();
        let display = std::fs::read(dir.join("display.txt")).unwrap();
        let shown = display.strip_prefix(b"\x1b[A\x1b[2K".as_slice()).unwrap_or(&display);
        assert_same(&dir.display().to_string(), &filter_all(&archive, d, true), shown);
        checked += 1;
    }
    eprintln!("checked {checked} golden displays");
}

#[test]
fn chunk_boundaries_do_not_change_the_output() {
    let mut inputs = vec![edge_cases().into_bytes(), fuzz(7, 2000).into_bytes()];
    for dir in run_dirs().into_iter().take(40) {
        inputs.push(std::fs::read(dir.join("archive.txt")).unwrap());
    }
    let mut r = Rng(12345);
    for input in inputs {
        let whole = filter_all(&input, 6, true);
        for _ in 0..5 {
            let mut f = PrecisionFilter::new(6, true);
            let t = Instant::now();
            let mut out = Vec::new();
            let mut i = 0;
            while i < input.len() {
                let n = 1 + r.below(40) as usize;
                let j = (i + n).min(input.len());
                out.extend(f.feed(&input[i..j], t));
                i = j;
            }
            out.extend(f.finish());
            assert_same("chunked feed", &out, &whole);
        }
    }
}

#[test]
fn idle_releases_of_progress_frames_show_the_same_bytes() {
    // A progress bar redraws with CR and writes no newline until it ends; each frame sits in the
    // filter as a tail until the stream has been quiet for 50 ms, then is shown whole.
    let frames = [
        "Running spectral method ...  [                              ]  starting ...",
        "\r\x1b[KRunning spectral method ...  [\x1b[7m \x1b[27m           ]  12/132       (  9%)         ",
        "\r\x1b[KRunning spectral method ...  [\x1b[7m \x1b[27m \x1b[7m \x1b[27m ]  132/132      (100%)     0.0s",
        "\n\nrho_1      0.70012345\n",
    ];
    let all: String = frames.concat();
    let whole = filter_all(all.as_bytes(), 3, true);
    let mut f = PrecisionFilter::new(3, true);
    let mut t = Instant::now();
    let mut out = Vec::new();
    for fr in frames {
        out.extend(f.feed(fr.as_bytes(), t));
        // The quiet interval: a tail that ends in '.' or a digit is held, anything else released.
        t += Duration::from_millis(60);
        out.extend(f.poll(t));
    }
    out.extend(f.finish());
    assert_same("frames with idle releases", &out, &whole);
    // The first frame ends in '.', so it was held until its CR arrived; the third ends in 's' and
    // was shown by the idle release before the newline came.
    let mut g = PrecisionFilter::new(3, true);
    let t0 = Instant::now();
    assert!(g.feed(frames[0].as_bytes(), t0).is_empty());
    assert!(g.poll(t0 + Duration::from_millis(60)).is_empty());
    let shown = g.feed(frames[1].as_bytes(), t0 + Duration::from_millis(70));
    assert_eq!(shown, format!("{}\r", frames[0]).as_bytes());
    assert_eq!(g.poll(t0 + Duration::from_millis(130)), filter_all(frames[1][1..].as_bytes(), 3, true));
}

#[test]
fn a_record_split_mid_number_is_held_and_formatted_whole() {
    let mut f = PrecisionFilter::new(6, true);
    let t0 = Instant::now();
    let mut out = f.feed(b"value  0.66", t0);
    out.extend(f.poll(t0 + Duration::from_secs(1)));
    out.extend(f.release_idle());
    assert!(out.is_empty(), "a tail ending inside a number must be held");
    out.extend(f.feed(b"6666666\n", t0 + Duration::from_secs(2)));
    assert_eq!(out, filter_all(b"value  0.666666666\n", 6, true));
    // A tail that could still become a sentinel is held too.
    let mut g = PrecisionFilter::new(6, true);
    assert!(g.feed(b"QNE", t0).is_empty());
    assert!(g.is_holding());
    assert!(g.release_idle().is_empty());
    assert!(g.feed(b"T_NODE_METRIC_V1 estimate=1.5\n", t0).is_empty());
}
