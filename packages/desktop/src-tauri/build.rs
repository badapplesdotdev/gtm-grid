fn main() {
    // Bake the PostHog public token (present in the env during `tauri build`, as
    // VITE_POSTHOG_KEY) into the binary so the Rust shell can forward it to the
    // spawned sidecar's env as GTMGRID_POSTHOG_KEY. A packaged app launched from
    // Finder has no shell env, so a build-time bake is the only reliable path.
    if let Ok(key) = std::env::var("VITE_POSTHOG_KEY") {
        println!("cargo:rustc-env=GTMGRID_POSTHOG_KEY={key}");
    }
    if let Ok(host) = std::env::var("VITE_POSTHOG_HOST") {
        println!("cargo:rustc-env=GTMGRID_POSTHOG_HOST={host}");
    }
    println!("cargo:rerun-if-env-changed=VITE_POSTHOG_KEY");
    println!("cargo:rerun-if-env-changed=VITE_POSTHOG_HOST");
    tauri_build::build()
}
