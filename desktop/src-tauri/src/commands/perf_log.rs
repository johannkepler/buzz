//! Append-only JSONL sink for channel-switch perf traces.
//!
//! The desktop's `[switch-perf]` console traces vanish with the session; this
//! sink persists one JSON line per settled switch to
//! `{app_log_dir}/switch-perf.jsonl` so before/after builds can be compared
//! offline. Every line is stamped with the build's git revision (baked by
//! build.rs) and, when set at launch, the `BUZZ_PERF_LOG_LABEL` run label —
//! e.g. `BUZZ_PERF_LOG_LABEL=before just production`.

use std::io::Write;

use tauri::Manager;

const PERF_LOG_FILENAME: &str = "switch-perf.jsonl";

/// Defensive cap: one record is a small trace object; anything larger is a
/// caller bug and must not grow the log unbounded. Enforced on the input
/// record and again on the final serialized line, so folded-in metadata can
/// never defeat it.
const MAX_RECORD_BYTES: usize = 4 * 1024;

/// Upper bound on the operator-supplied `BUZZ_PERF_LOG_LABEL` run label.
/// Truncating (rather than erroring) keeps a fat-fingered label from
/// silently dropping every trace for the whole run — the frontend swallows
/// sink errors by design.
const MAX_LABEL_BYTES: usize = 128;

/// Truncates to the last char boundary at or below `max_bytes`.
fn truncate_at_char_boundary(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Rotation threshold. The sink is always on, so without a cap the JSONL
/// grows for the life of the install; one rotated generation preserves
/// enough history for before/after comparisons.
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;

/// Validates and shapes one JSONL line: the record must be a JSON object
/// (which also guarantees the stored line is newline-free), then the build
/// revision and optional run label are folded in. Pure for unit testing.
fn shape_perf_log_line(
    record_json: &str,
    git_sha: Option<&str>,
    label: Option<&str>,
) -> Result<String, String> {
    if record_json.len() > MAX_RECORD_BYTES {
        return Err("perf log record too large".to_string());
    }
    let mut value: serde_json::Value =
        serde_json::from_str(record_json).map_err(|e| format!("invalid perf log record: {e}"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "perf log record must be a JSON object".to_string())?;
    object.insert(
        "gitSha".to_string(),
        match git_sha {
            Some(sha) => serde_json::Value::String(sha.to_string()),
            None => serde_json::Value::Null,
        },
    );
    if let Some(label) = label {
        object.insert(
            "label".to_string(),
            serde_json::Value::String(
                truncate_at_char_boundary(label, MAX_LABEL_BYTES).to_string(),
            ),
        );
    }
    let line = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    // The cap must hold for what actually reaches the disk: gitSha and label
    // are folded in after the record-size check above, and writeln! appends
    // a newline terminator — reserve one byte for it.
    if line.len() + 1 > MAX_RECORD_BYTES {
        return Err("perf log line too large".to_string());
    }
    Ok(line)
}

/// Serializes the whole metadata→rename→append transaction. Appends run on
/// independent `spawn_blocking` threads; without this, two writers at the
/// rotation boundary can both decide to rotate — the loser's rename fails and
/// its record is dropped. One global lock suffices: the app writes a single
/// log path.
static PERF_LOG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Appends one line, rotating the file to `<name>.1` (replacing the previous
/// generation) once it exceeds `max_bytes`. Factored for unit testing.
fn append_line_rotating(path: &std::path::Path, line: &str, max_bytes: u64) -> Result<(), String> {
    let _guard = PERF_LOG_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Ok(metadata) = std::fs::metadata(path) {
        if metadata.len() >= max_bytes {
            let mut rotated = path.as_os_str().to_owned();
            rotated.push(".1");
            let rotated = std::path::PathBuf::from(rotated);
            // Remove the retained generation before renaming over it: on
            // Windows, rename does not replace an existing destination. Same
            // platform rule as managed_agents::storage::start_install_log_session.
            //
            // Rotation itself is best-effort: an AV/EDR or editor holding a
            // transient lock (again, chiefly Windows) would otherwise fail
            // EVERY append until the lock clears — the frontend deliberately
            // swallows sink errors, so records would vanish silently.
            // Degrade to an unrotated append; the size cap re-applies once
            // rotation succeeds on a later write.
            let rotation = (|| -> std::io::Result<()> {
                if rotated.exists() {
                    std::fs::remove_file(&rotated)?;
                }
                std::fs::rename(path, &rotated)
            })();
            if let Err(e) = rotation {
                eprintln!("buzz-desktop: perf-log rotation failed, appending unrotated: {e}");
            }
        }
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    // One write_all, not writeln!: writeln! issues two write syscalls (line,
    // then newline), and PERF_LOG_LOCK is process-local while the path is
    // not — a second Buzz process sharing the log dir could interleave
    // between them. A single O_APPEND write keeps lines atomic.
    file.write_all(format!("{line}\n").as_bytes())
        .map_err(|e| e.to_string())
}

/// Appends one switch-perf record to the app-log-dir JSONL file and returns
/// the file's path so the frontend can announce where the log lives.
///
/// Async so Tauri runs it on the async runtime rather than the main thread:
/// a perf sink must not add main-thread filesystem stalls to the switches it
/// measures.
#[tauri::command]
pub async fn append_switch_perf_log(
    app: tauri::AppHandle,
    record_json: String,
) -> Result<String, String> {
    let label = std::env::var("BUZZ_PERF_LOG_LABEL").ok();
    let line = shape_perf_log_line(
        &record_json,
        option_env!("BUZZ_DESKTOP_BUILD_GIT_SHA"),
        label.as_deref(),
    )?;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let path = dir.join(PERF_LOG_FILENAME);
    let result = tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(path.parent().unwrap_or(&path)).map_err(|e| e.to_string())?;
        append_line_rotating(&path, &line, MAX_LOG_BYTES)?;
        Ok::<String, String>(path.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shape_folds_in_git_sha_and_label() {
        let line = shape_perf_log_line(r#"{"totalMs":412}"#, Some("abc123-dirty"), Some("before"))
            .expect("shape");
        let value: serde_json::Value = serde_json::from_str(&line).expect("parse");
        assert_eq!(value["totalMs"], 412);
        assert_eq!(value["gitSha"], "abc123-dirty");
        assert_eq!(value["label"], "before");
        assert!(!line.contains('\n'));
    }

    #[test]
    fn shape_without_label_or_sha_keeps_record_and_null_sha() {
        let line = shape_perf_log_line(r#"{"totalMs":1}"#, None, None).expect("shape");
        let value: serde_json::Value = serde_json::from_str(&line).expect("parse");
        assert_eq!(value["gitSha"], serde_json::Value::Null);
        assert!(value.get("label").is_none());
    }

    #[test]
    fn shape_rejects_non_objects_and_oversized_records() {
        assert!(shape_perf_log_line("[1,2]", None, None).is_err());
        assert!(shape_perf_log_line("not json", None, None).is_err());
        let oversized = format!(r#"{{"pad":"{}"}}"#, "x".repeat(MAX_RECORD_BYTES));
        assert!(shape_perf_log_line(&oversized, None, None).is_err());
    }

    #[test]
    fn shape_truncates_an_unbounded_label_and_keeps_the_line_capped() {
        // BUZZ_PERF_LOG_LABEL is operator-supplied; a runaway value must not
        // defeat the record cap by being folded in after the size check.
        let label = "l".repeat(1024 * 1024);
        let line =
            shape_perf_log_line(r#"{"totalMs":13}"#, Some("abc123"), Some(&label)).expect("shape");
        assert!(line.len() <= MAX_RECORD_BYTES, "line stays under the cap");
        let value: serde_json::Value = serde_json::from_str(&line).expect("parse");
        assert_eq!(
            value["label"].as_str().expect("label").len(),
            MAX_LABEL_BYTES
        );
        assert_eq!(value["totalMs"], 13);
    }

    #[test]
    fn label_truncation_cuts_at_a_char_boundary() {
        // '€' is 3 bytes; MAX_LABEL_BYTES (128) is not a multiple of 3, so a
        // byte-index cut would split a char and panic (or emit invalid UTF-8).
        let label = "€".repeat(MAX_LABEL_BYTES);
        let line = shape_perf_log_line(r#"{"totalMs":1}"#, None, Some(&label)).expect("shape");
        let value: serde_json::Value = serde_json::from_str(&line).expect("parse");
        let stored = value["label"].as_str().expect("label");
        assert_eq!(stored.len(), MAX_LABEL_BYTES - (MAX_LABEL_BYTES % 3));
        assert!(stored.chars().all(|c| c == '€'));
    }

    #[test]
    fn shape_rejects_a_line_that_outgrows_the_cap_after_metadata() {
        // The record alone passes the input check; the folded-in git sha
        // pushes the serialized line over the cap.
        let pad = "x".repeat(MAX_RECORD_BYTES - 20);
        let record = format!(r#"{{"pad":"{pad}"}}"#);
        assert!(record.len() <= MAX_RECORD_BYTES);
        assert!(shape_perf_log_line(&record, Some(&"s".repeat(64)), None).is_err());
    }

    #[test]
    fn the_cap_bounds_bytes_on_disk_including_the_newline() {
        // Shaped line = {"pad":"…","gitSha":null} → pad length + 24 bytes.
        // The largest accepted line is MAX_RECORD_BYTES - 1: writeln! appends
        // a newline, and the cap bounds what reaches the disk.
        let fits = format!(r#"{{"pad":"{}"}}"#, "x".repeat(MAX_RECORD_BYTES - 25));
        let line = shape_perf_log_line(&fits, None, None).expect("one byte reserved for newline");
        assert_eq!(line.len(), MAX_RECORD_BYTES - 1);

        let dir = std::env::temp_dir().join(format!(
            "perf-log-newline-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).expect("tempdir");
        let path = dir.join("switch-perf.jsonl");
        let _ = std::fs::remove_file(&path);
        append_line_rotating(&path, &line, MAX_LOG_BYTES).expect("append");
        assert_eq!(
            std::fs::metadata(&path).expect("metadata").len(),
            MAX_RECORD_BYTES as u64,
            "on-disk record must not exceed the cap"
        );
        std::fs::remove_dir_all(&dir).ok();

        // One pad byte more serializes to exactly MAX_RECORD_BYTES, which
        // would write MAX_RECORD_BYTES + 1 bytes — rejected.
        let over = format!(r#"{{"pad":"{}"}}"#, "x".repeat(MAX_RECORD_BYTES - 24));
        assert!(shape_perf_log_line(&over, None, None).is_err());
    }

    #[test]
    fn append_rotates_once_over_the_cap_and_keeps_one_generation() {
        let dir = std::env::temp_dir().join(format!("perf-log-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("tempdir");
        let path = dir.join("switch-perf.jsonl");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(dir.join("switch-perf.jsonl.1"));

        append_line_rotating(&path, "first", 16).expect("append");
        append_line_rotating(&path, "second", 16).expect("append");
        // 12 bytes so far — under the cap, same file.
        assert_eq!(
            std::fs::read_to_string(&path).expect("read"),
            "first\nsecond\n"
        );

        // Push past the cap; the next append must rotate.
        append_line_rotating(&path, "third-is-long", 16).expect("append");
        append_line_rotating(&path, "fresh", 16).expect("append");
        assert_eq!(std::fs::read_to_string(&path).expect("read"), "fresh\n");
        assert_eq!(
            std::fs::read_to_string(dir.join("switch-perf.jsonl.1")).expect("read rotated"),
            "first\nsecond\nthird-is-long\n"
        );

        // A second rotation replaces the previous generation, never a third file.
        append_line_rotating(&path, "overflow-the-cap!", 16).expect("append");
        append_line_rotating(&path, "newest", 16).expect("append");
        assert_eq!(std::fs::read_to_string(&path).expect("read"), "newest\n");
        assert_eq!(
            std::fs::read_to_string(dir.join("switch-perf.jsonl.1")).expect("read rotated"),
            "fresh\noverflow-the-cap!\n"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rotation_replaces_an_existing_retained_generation() {
        let dir = std::env::temp_dir().join(format!(
            "perf-log-regen-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).expect("tempdir");
        let path = dir.join("switch-perf.jsonl");
        let rotated = dir.join("switch-perf.jsonl.1");
        // Seed BOTH generations, as after any prior rollover. On Windows a
        // bare rename onto the existing `.1` fails, which used to kill every
        // subsequent append.
        std::fs::write(&path, "current-full\n").expect("seed current");
        std::fs::write(&rotated, "old-generation\n").expect("seed rotated");

        append_line_rotating(&path, "fresh", 8).expect("rotation over existing .1 must succeed");

        assert_eq!(std::fs::read_to_string(&path).expect("read"), "fresh\n");
        assert_eq!(
            std::fs::read_to_string(&rotated).expect("read rotated"),
            "current-full\n"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_failed_rotation_degrades_to_an_unrotated_append() {
        let dir = std::env::temp_dir().join(format!(
            "perf-log-degrade-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).expect("tempdir");
        let path = dir.join("switch-perf.jsonl");
        let rotated = dir.join("switch-perf.jsonl.1");
        std::fs::write(&path, "oversized-live\n").expect("seed live");
        // A non-empty DIRECTORY at the rotated path defeats remove_file and
        // rename on every platform — including for root, where permission
        // tricks no-op (containers often run tests as uid 0). It stands in
        // for a transient AV/EDR hold: the append must degrade to the
        // unrotated file, not drop records until the lock clears.
        std::fs::create_dir_all(rotated.join("hold")).expect("seed blocker");

        append_line_rotating(&path, "must-survive", 8)
            .expect("append must survive a failed rotation");

        assert_eq!(
            std::fs::read_to_string(&path).expect("read live"),
            "oversized-live\nmust-survive\n"
        );
        assert!(rotated.join("hold").exists(), "blocker untouched");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn concurrent_boundary_appends_lose_no_line_and_rotate_once() {
        let dir = std::env::temp_dir().join(format!(
            "perf-log-concurrent-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).expect("tempdir");
        let path = dir.join("switch-perf.jsonl");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(dir.join("switch-perf.jsonl.1"));

        // 8 writers × 4 lines of 18 bytes on disk (17 chars + newline) = 576
        // bytes against a 384-byte cap: rotation triggers before the 23rd
        // append (22 lines = 396 bytes ≥ 384) and the ≤10 lines that follow
        // (≤180 bytes) cannot re-trigger it, so the boundary is crossed
        // exactly once and every line must land in either the live file or
        // the single rotated generation. Unserialized metadata→rename→append
        // interleavings drop lines or fail renames.
        let threads: Vec<_> = (0..8)
            .map(|writer| {
                let path = path.clone();
                std::thread::spawn(move || {
                    for line_index in 0..4 {
                        append_line_rotating(
                            &path,
                            &format!("writer-{writer:02}-line-{line_index:02}"),
                            384,
                        )
                        .expect("append");
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().expect("join");
        }

        let mut lines: Vec<String> = std::fs::read_to_string(&path)
            .expect("read live")
            .lines()
            .map(str::to_string)
            .collect();
        // Unconditional: if rotation never fired under contention, the size
        // cap is inoperative and this test must fail, not silently pass with
        // all 32 lines in the live file.
        let rotated = std::fs::read_to_string(dir.join("switch-perf.jsonl.1"))
            .expect("rotation must have occurred under contention");
        lines.extend(rotated.lines().map(str::to_string));
        lines.sort();
        let expected: Vec<String> = (0..8)
            .flat_map(|writer| {
                (0..4).map(move |line_index| format!("writer-{writer:02}-line-{line_index:02}"))
            })
            .collect();
        assert_eq!(lines, expected, "every append must survive the boundary");
        std::fs::remove_dir_all(&dir).ok();
    }
}
