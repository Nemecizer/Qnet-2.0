//! The methods framework's test helpers, checked on themselves.
mod common;

#[test]
fn normalising_keeps_the_last_frame_and_masks_times_paths_and_pids() {
    let text = "Running QNA ...  [ ]      0.0s\r\x1b[KRunning QNA ...  [done]      0.4s\nrho_1 0.7\nElapsed time: 0.028s\n/T/BNET_qna_out_123.txt";
    let n = common::normalize(text, Some("/T"), Some("123"));
    assert_eq!(n, "Running QNA ...  [done]<T>s\nrho_1 0.7\nElapsed time: <T>s\n<TMP>/BNET_qna_out_<PID>.txt");
}

#[test]
fn every_example_has_a_folder_name_like_the_golden_corpus() {
    let names: Vec<String> = common::examples().into_iter().map(|(n, _)| n).collect();
    assert_eq!(names.len(), 50);
    assert!(names.contains(&"15stationtandem.inf.bnet".to_string()));
}

#[test]
fn comparable_records_drop_ids_dates_and_raw_output_but_keep_measurements() {
    let rec = qnet_core::json::parse(r#"{"id":"A","startedAt":"x","status":"completed","rawOutput":"r","provenance":{"tabID":"T","parameters":{"a":"1"}},"measurements":[{"id":"M","estimate":1}]}"#).unwrap();
    let got = qnet_core::json::to_pretty(&common::comparable_record(&rec));
    let want = qnet_core::json::to_pretty(&qnet_core::json::parse(r#"{"status":"completed","provenance":{"parameters":{"a":"1"}},"measurements":[{"estimate":1}]}"#).unwrap());
    assert_eq!(got, want);
}

#[test]
fn a_solvers_own_timing_line_is_masked_and_nothing_else_is() {
    assert_eq!(common::mask_printed_time("[Grid]  400 points, 0.002 s").as_deref(), Some("[Grid]  400 points, <T> s"));
    assert_eq!(common::mask_printed_time("[Solve] Optimal u* = 0.0000000000e+00, 0.047 s").as_deref(), Some("[Solve] Optimal u* = 0.0000000000e+00, <T> s"));
    assert_eq!(common::mask_printed_time("[Total] 0.051 s").as_deref(), Some("[Total] <T> s"));
    assert_eq!(common::mask_printed_time("rho_1 = 0.5 s"), None);
    assert_eq!(common::mask_printed_time("[Grid]  400 points"), None);
}

#[test]
fn the_golden_cpu_count_is_read_from_the_wrappers_thread_banner() {
    let sim = common::golden("2dtandem", "sim").expect("golden/runs/2dtandem/sim");
    assert_eq!(common::golden_cpu_count(&sim), Some(18));
    let cmp = common::golden("2dtandem", "cmp").expect("golden/runs/2dtandem/cmp");
    assert_eq!(common::golden_cpu_count(&cmp), Some(18));
    let qna = common::golden("10stationtandem.inf", "qna").expect("golden/runs/10stationtandem.inf/qna");
    assert_eq!(common::golden_cpu_count(&qna), None);
}

#[test]
fn the_lp_summary_total_and_the_mlmc_header_times_are_masked() {
    assert_eq!(common::mask_printed_time("[Total] 2.843s").as_deref(), Some("[Total] <T>s"));
    assert_eq!(
        common::mask_printed_time("# backend=openmp  threads=18  elapsed=0.624s").as_deref(),
        Some("# backend=openmp  threads=18  elapsed=<T>s")
    );
    assert_eq!(common::mask_printed_time("Running QNA ...  [done]      0.4s"), None);
    assert_eq!(common::mask_printed_time("# backend=openmp  elapsed=0.624s"), None);
}

#[test]
fn golden_seeds_are_read_exactly_past_two_to_the_fifty_three() {
    let mlmc = common::golden("BanksDai96.d3.c9.spt.reentrant.inf", "mlmc").expect("golden/runs/BanksDai96.d3.c9.spt.reentrant.inf/mlmc");
    let text = std::fs::read_to_string(mlmc.dir.join("record.json")).unwrap();
    let seeds = mlmc.replication_seeds();
    assert!(!seeds.is_empty());
    for s in &seeds {
        assert!(text.contains(&s.to_string()), "{s} is not written in record.json");
    }
}
