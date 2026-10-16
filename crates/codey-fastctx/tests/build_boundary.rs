use std::collections::BTreeSet;
use std::process::Command;

fn build_dependencies(package: &str) -> BTreeSet<String> {
    let output = Command::new(env!("CARGO"))
        .args([
            "tree",
            "--color",
            "never",
            "--offline",
            "--locked",
            "-p",
            package,
            "--edges",
            "normal,build",
            "--prefix",
            "none",
            "--format",
            "{p}",
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("cannot inspect the Cargo build dependency graph");
    assert!(
        output.status.success(),
        "cargo tree failed for {package}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .filter_map(|line| line.split_whitespace().next().map(str::to_owned))
        .collect()
}

#[test]
fn desktop_build_does_not_wait_for_fastctx() {
    let dependencies = build_dependencies("codey");
    assert!(dependencies.contains("codey"));
    assert!(dependencies.contains("codey-error-log"));
    assert!(!dependencies.contains("fastctx"));
    assert!(!dependencies.contains("codey-fastctx"));
}

#[test]
fn fastctx_build_does_not_wait_for_the_desktop() {
    let dependencies = build_dependencies("codey-fastctx");
    assert!(dependencies.contains("fastctx"));
    assert!(dependencies.contains("codey-error-log"));
    assert!(!dependencies.contains("codey"));
}
