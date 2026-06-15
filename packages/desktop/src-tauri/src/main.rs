// gtmgrid Tauri shell. On startup it spawns the bundled Node engine sidecar (the
// HTTP server) and renders the React UI, which talks to it over localhost — the
// same shape as Revcode's Tauri + Node-sidecar architecture. The sidecar is
// fully self-contained (its own node binary + native deps), so the packaged app
// runs without any dev toolchain installed.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

struct Sidecar(Mutex<Option<Child>>);

/// Tauri event the webview listens for to complete the desktop OAuth flow: the
/// payload is the incoming `gtmgrid://auth/callback?code=…` URL string. Emitted
/// both for cold-start (the URL that launched the app) and warm deep links.
const OAUTH_CALLBACK_EVENT: &str = "oauth-callback";

/// Forward an incoming deep-link URL to the webview so the JS listener can pull
/// the `code` out and call `signIn({ code })` to finish the session.
fn emit_oauth_callback(app: &tauri::AppHandle, url: &str) {
    if let Err(e) = app.emit(OAUTH_CALLBACK_EVENT, url.to_string()) {
        eprintln!("gtmgrid: failed to emit {OAUTH_CALLBACK_EVENT}: {e}");
    }
}

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

/// The bundled node binary's filename (`node.exe` on Windows, `node` elsewhere).
fn node_binary_name() -> &'static str {
    #[cfg(windows)]
    {
        "node.exe"
    }
    #[cfg(not(windows))]
    {
        "node"
    }
}

/// Resolve the user's real PATH from their login+interactive shell, so the
/// sidecar (and the agent CLIs it spawns) can find nvm/homebrew-installed
/// `claude` / `codex`. GUI apps otherwise launch with a minimal PATH. Unix only.
#[cfg(unix)]
fn login_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = Command::new(&shell).args(["-lic", "echo \"$PATH\""]).output().ok()?;
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if p.is_empty() { None } else { Some(p) }
}

/// Build the PATH the sidecar is spawned with. On unix we augment the GUI's
/// minimal PATH with the login shell's PATH + common CLI locations so the agent
/// panel can find `claude` / `codex`. On Windows the process PATH already
/// carries the user's installed CLIs, so we pass it through unchanged.
#[cfg(unix)]
fn sidecar_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let base_path = std::env::var("PATH").unwrap_or_default();
    let login = login_path().unwrap_or_default();
    format!(
        "{login}:/opt/homebrew/bin:/usr/local/bin:{home}/.local/bin:{home}/.npm-global/bin:{base_path}"
    )
}
#[cfg(not(unix))]
fn sidecar_path() -> String {
    std::env::var("PATH").unwrap_or_default()
}

fn spawn_sidecar(app: &tauri::App) -> Option<Child> {
    let dir = sidecar_dir(app)?;
    let node = dir.join(node_binary_name());
    let server = dir.join("server.mjs");
    let launcher = dir.join("gtmgrid-mcp");
    if !node.exists() || !server.exists() {
        eprintln!("gtmgrid: bundled sidecar not found at {:?}", dir);
        return None;
    }
    make_executable(&node);
    make_executable(&launcher);

    // PostHog config for the sidecar's error tracking. Prefer a runtime override
    // (dev / CI), else the value baked at build time (build.rs maps VITE_POSTHOG_*
    // → GTMGRID_POSTHOG_* via cargo:rustc-env). Empty when unconfigured — the
    // sidecar's observability module no-ops on a falsy key.
    let posthog_key = std::env::var("GTMGRID_POSTHOG_KEY")
        .ok()
        .or_else(|| option_env!("GTMGRID_POSTHOG_KEY").map(str::to_string))
        .unwrap_or_default();
    let posthog_host = std::env::var("GTMGRID_POSTHOG_HOST")
        .ok()
        .or_else(|| option_env!("GTMGRID_POSTHOG_HOST").map(str::to_string))
        .unwrap_or_else(|| "https://eu.i.posthog.com".into());

    Command::new(&node)
        .arg(&server)
        .env("GTMGRID_PROJECT", std::env::var("GTMGRID_PROJECT").unwrap_or_else(|_| "default".into()))
        .env("GTMGRID_MCP_LAUNCHER", &launcher)
        .env("GTMGRID_EXT_DIR", dir.join("extensions"))
        .env("GTMGRID_POSTHOG_KEY", posthog_key)
        .env("GTMGRID_POSTHOG_HOST", posthog_host)
        .env("PATH", sidecar_path())
        .spawn()
        .map_err(|e| eprintln!("gtmgrid: failed to spawn sidecar: {e}"))
        .ok()
}

fn main() {
    tauri::Builder::default()
        // single-instance MUST be registered BEFORE the deep-link plugin on
        // desktop: a second launch (the OS handing us a `gtmgrid://` URL) is
        // routed into the already-running instance, whose handler forwards the
        // deep-link argv to the webview instead of opening a new window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            for arg in argv.iter().skip(1) {
                if arg.starts_with("gtmgrid://") {
                    emit_oauth_callback(app, arg);
                }
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        // System-browser opener: the desktop OAuth flow opens the provider
        // authorise URL here (not inside the webview).
        .plugin(tauri_plugin_opener::init())
        // In-app auto-update (download + install a signed newer release) and the
        // process plugin so the frontend can relaunch after installing.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let child = spawn_sidecar(app);
            app.manage(Sidecar(Mutex::new(child)));

            // Warm deep links (app already running): emit each incoming URL to
            // the webview so the OAuth listener can complete the session.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    emit_oauth_callback(&handle, url.as_str());
                }
            });

            // Cold start: if the app was launched BY a `gtmgrid://` deep link,
            // replay it once the webview is ready to receive the event.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                let handle = app.handle().clone();
                for url in urls {
                    emit_oauth_callback(&handle, url.as_str());
                }
            }
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
