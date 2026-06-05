// gtmgrid Tauri shell. On startup it spawns the bundled Node engine sidecar (the
// HTTP server) and renders the React UI, which talks to it over localhost — the
// same shape as Revcode's Tauri + Node-sidecar architecture. The sidecar is
// fully self-contained (its own node binary + native deps), so the packaged app
// runs without any dev toolchain installed.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

struct Sidecar(Mutex<Option<Child>>);

/// Locate the bundled sidecar dir: the source tree in dev, app resources when packaged.
fn sidecar_dir(app: &tauri::App) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sidecar"))
    }
    #[cfg(not(debug_assertions))]
    {
        app.path().resource_dir().ok().map(|r| r.join("sidecar"))
    }
}

#[cfg(unix)]
fn make_executable(path: &PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(0o755);
        let _ = std::fs::set_permissions(path, perms);
    }
}
#[cfg(not(unix))]
fn make_executable(_path: &PathBuf) {}

fn spawn_sidecar(app: &tauri::App) -> Option<Child> {
    let dir = sidecar_dir(app)?;
    let node = dir.join("node");
    let server = dir.join("server.mjs");
    let launcher = dir.join("gtmgrid-mcp");
    if !node.exists() || !server.exists() {
        eprintln!("gtmgrid: bundled sidecar not found at {:?}", dir);
        return None;
    }
    make_executable(&node);
    make_executable(&launcher);

    // GUI apps launch with a minimal PATH; prepend common locations so the agent
    // panel can find the user's `claude` / `codex` CLIs.
    let home = std::env::var("HOME").unwrap_or_default();
    let base_path = std::env::var("PATH").unwrap_or_default();
    let path = format!(
        "/opt/homebrew/bin:/usr/local/bin:{home}/.local/bin:{home}/.npm-global/bin:{base_path}"
    );

    Command::new(&node)
        .arg(&server)
        .env("GTMGRID_PROJECT", std::env::var("GTMGRID_PROJECT").unwrap_or_else(|_| "default".into()))
        .env("GTMGRID_MCP_LAUNCHER", &launcher)
        .env("GTMGRID_EXT_DIR", dir.join("extensions"))
        .env("PATH", path)
        .spawn()
        .map_err(|e| eprintln!("gtmgrid: failed to spawn sidecar: {e}"))
        .ok()
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let child = spawn_sidecar(app);
            app.manage(Sidecar(Mutex::new(child)));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<Sidecar>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.as_mut() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running gtmgrid");
}
