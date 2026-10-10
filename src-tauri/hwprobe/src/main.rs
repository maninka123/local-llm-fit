//! `hwprobe` CLI: prints the hardware report as JSON (useful for diagnostics and fixtures).
fn main() {
    let arg = std::env::args().nth(1);
    let json = if arg.as_deref() == Some("--sample") {
        serde_json::to_string_pretty(&hwprobe::sample_memory())
    } else {
        serde_json::to_string_pretty(&hwprobe::probe())
    };
    println!("{}", json.expect("serialize"));
}
