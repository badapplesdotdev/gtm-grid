// gtmgrid Tauri shell. On startup it spawns the bundled Node engine sidecar (the
// HTTP server) and renders the React UI, which talks to it over localhost — the
// same shape as Revcode's Tauri + Node-sidecar architecture. The sidecar is
// fully self-contained (its own node binary + native deps), so the packaged app
// runs without any dev toolchain installed.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

/// The bundled engine child + the flag the window-destroy handler sets before it
/// kills the child, so the liveness monitor can tell a deliberate shutdown apart
/// from an unexpected crash and not report the former as an error.
struct Sidecar {
    child: Mutex<Option<Child>>,
    shutting_down: AtomicBool,
}

/// Self-reporting boot diagnostics the webview reads back via the
/// `sidecar_diagnostics` command. `facts` is a JSON blob assembled during the
/// spawn attempt (real app version, OS/arch, resolved node/server paths + whether
/// they exist, the spawn outcome, and any early-exit code); `stderr_tail` is the
/// engine's own captured stderr — i.e. the ACTUAL crash. Telemetry is silent on
/// some Windows machines, so this lets a stuck user paste the real failure from
/// "Copy diagnostics" instead of leaving us to guess.
struct Diagnostics {
    facts: Mutex<serde_json::Value>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

/// The result of a spawn attempt: the child (None on any failure), the live
/// stderr tail, and the JSON facts blob — returned in EVERY branch (including
/// failures) so the diagnostics command can explain a dead engine.
struct Boot {
    child: Option<Child>,
    tail: Arc<Mutex<VecDeque<String>>>,
    facts: serde_json::Value,
}

/// How many trailing stderr lines of the sidecar to keep for a crash report.
const MAX_STDERR_LINES: usize = 40;
/// A sidecar exit within this window of launch is "unexpected" (e.g. a native
/// module failing to load); a later exit is normal app-shutdown teardown.
const EARLY_EXIT_WINDOW: Duration = Duration::from_secs(30);

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

/// Spawn the bundled engine. Returns the child plus a rolling tail of its stderr
/// (so an early crash can be reported with the actual error). Every failure path
/// reports `sidecar_spawn_failed` to PostHog — previously they only `eprintln!`d
/// to a stderr the packaged app (`windows_subsystem = "windows"`) discards, which
/// is exactly why a Windows user's dead engine was invisible until they spoke up.
fn spawn_sidecar(app: &tauri::App) -> Boot {
    // An empty tail exists from the start so every (incl. failure) branch can
    // return one; the reader thread fills it once the child is spawned.
    let tail = Arc::new(Mutex::new(VecDeque::<String>::with_capacity(MAX_STDERR_LINES)));
    // Base facts every branch carries: the REAL installed version (authoritative,
    // unlike the renderer's build-time define) + the OS/arch the engine must run on.
    let mut facts = serde_json::json!({
        "appVersion": app.package_info().version.to_string(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "spawnStatus": "pending",
    });

    let dir = match sidecar_dir(app) {
        Some(d) => d,
        None => {
            facts["spawnStatus"] = "dir_missing".into();
            report_sidecar_failure("dir_missing", "resource dir unavailable");
            return Boot { child: None, tail, facts };
        }
    };
    // On Windows, Tauri's resource_dir() is a `\\?\C:\…` verbatim path. Node's
    // main-module resolver can't parse that prefix and crashes with
    // `EISDIR: lstat 'C:'` before loading server.mjs — so the engine never starts
    // and reads as "unreachable". Simplify to a plain `C:\…` path; every path we
    // derive from `dir` (script arg, cwd, launcher, ext dir) inherits the fix.
    // No-op on non-Windows / when the prefix can't be safely removed.
    let dir = dunce::simplified(&dir).to_path_buf();
    let node = dir.join(node_binary_name());
    let server = dir.join("server.mjs");
    let launcher = dir.join("gtmgrid-mcp");
    facts["sidecarDir"] = dir.to_string_lossy().into_owned().into();
    facts["nodePath"] = node.to_string_lossy().into_owned().into();
    facts["nodeExists"] = node.exists().into();
    facts["serverPath"] = server.to_string_lossy().into_owned().into();
    facts["serverExists"] = server.exists().into();
    if !node.exists() || !server.exists() {
        eprintln!("gtmgrid: bundled sidecar not found at {:?}", dir);
        facts["spawnStatus"] = "binary_missing".into();
        report_sidecar_failure("binary_missing", &format!("missing node/server in {dir:?}"));
        return Boot { child: None, tail, facts };
    }
    make_executable(&node);
    make_executable(&launcher);

    // PostHog config for the sidecar's error tracking (shared with the shell's
    // panic hook). Empty key when unconfigured — the sidecar no-ops on a falsy key.
    let (posthog_key, posthog_host) = posthog_config();

    let mut command = Command::new(&node);
    command
        .arg(&server)
        // Run with the sidecar dir as cwd (matches the smoke harness) so any
        // relative resolution behaves identically to a direct boot.
        .current_dir(&dir)
        .env("GTMGRID_PROJECT", std::env::var("GTMGRID_PROJECT").unwrap_or_else(|_| "default".into()))
        .env("GTMGRID_MCP_LAUNCHER", &launcher)
        .env("GTMGRID_EXT_DIR", dir.join("extensions"))
        .env("GTMGRID_POSTHOG_KEY", posthog_key)
        .env("GTMGRID_POSTHOG_HOST", posthog_host)
        .env("PATH", sidecar_path())
        // stdin MUST be an explicit valid handle, not the default inherit: this
        // shell is `windows_subsystem = "windows"`, so it has NO console and its
        // STD_INPUT_HANDLE is null. The moment stdout/stderr are piped, Windows
        // uses STARTF_USESTDHANDLES and CreateProcessW requires a valid handle for
        // ALL THREE streams; inheriting the null stdin makes the spawn fail
        // outright (ERROR_INVALID_HANDLE) — node never launches and the engine
        // is "unreachable". Pointing stdin at the null device gives it a real
        // handle. The server never reads stdin, so /dev/null (NUL) is correct.
        .stdin(Stdio::null())
        // Pipe both streams: stderr feeds the crash-report tail, and draining
        // stdout stops a full pipe buffer from blocking the child.
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // CREATE_NO_WINDOW: spawning a console app (node.exe) from this console-less
    // GUI shell would otherwise pop a transient console window. No effect on unix.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("gtmgrid: failed to spawn sidecar: {e}");
            facts["spawnStatus"] = "spawn_error".into();
            facts["spawnError"] = e.to_string().into();
            report_sidecar_failure("spawn_error", &e.to_string());
            return Boot { child: None, tail, facts };
        }
    };
    facts["spawnStatus"] = "spawned".into();

    if let Some(stderr) = child.stderr.take() {
        let tail = tail.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[sidecar] {line}");
                if let Ok(mut buf) = tail.lock() {
                    if buf.len() == MAX_STDERR_LINES {
                        buf.pop_front();
                    }
                    buf.push_back(line);
                }
            }
        });
    }
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                eprintln!("[sidecar] {line}");
            }
        });
    }

    Boot { child: Some(child), tail, facts }
}

/// Watch the sidecar for an unexpected early exit (e.g. a native module that
/// won't load on the user's OS/arch). Without this the child dies silently and
/// the UI just spins on "Server not reachable". Reports `sidecar_exited` with the
/// exit code + stderr tail, but only for exits inside `EARLY_EXIT_WINDOW` and not
/// during shutdown, so normal teardown is never reported as a crash.
fn monitor_sidecar(handle: tauri::AppHandle) {
    let started = Instant::now();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(750));
        let state = match handle.try_state::<Sidecar>() {
            Some(s) => s,
            None => return,
        };
        if state.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let status = {
            let mut guard = match state.child.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            match guard.as_mut() {
                Some(child) => child.try_wait().ok().flatten(),
                None => return,
            }
        };
        if let Some(status) = status {
            let uptime = started.elapsed();
            if uptime < EARLY_EXIT_WINDOW && !state.shutting_down.load(Ordering::SeqCst) {
                // Give the stderr reader a beat to drain the final lines.
                std::thread::sleep(Duration::from_millis(250));
                let stderr_tail = handle
                    .try_state::<Diagnostics>()
                    .map(|d| state_stderr_tail(&d.stderr_tail))
                    .unwrap_or_default();
                // Record the crash in the diagnostics facts so "Copy diagnostics"
                // shows the engine exited (and with what code), not just "spawned".
                if let Some(diag) = handle.try_state::<Diagnostics>() {
                    if let Ok(mut facts) = diag.facts.lock() {
                        facts["spawnStatus"] = "exited".into();
                        facts["exitCode"] = serde_json::json!(status.code());
                        facts["exitedAfterMs"] = serde_json::json!(uptime.as_millis() as u64);
                    }
                }
                report_sidecar_exit(status.code(), uptime, &stderr_tail);
            }
            return;
        }
    });
}

/// Join the captured stderr tail into a single string for a crash report.
fn state_stderr_tail(tail: &Arc<Mutex<VecDeque<String>>>) -> String {
    tail.lock()
        .map(|buf| buf.iter().cloned().collect::<Vec<_>>().join("\n"))
        .unwrap_or_default()
}

/// Resolve the PostHog key + host for the desktop shell + sidecar: a runtime
/// override (dev / CI) wins, else the value baked at build time (build.rs maps
/// VITE_POSTHOG_* → GTMGRID_POSTHOG_* via cargo:rustc-env). Key is empty when
/// unconfigured (every consumer no-ops on a falsy key).
fn posthog_config() -> (String, String) {
    let key = std::env::var("GTMGRID_POSTHOG_KEY")
        .ok()
        .or_else(|| option_env!("GTMGRID_POSTHOG_KEY").map(str::to_string))
        .unwrap_or_default();
    let host = std::env::var("GTMGRID_POSTHOG_HOST")
        .ok()
        .or_else(|| option_env!("GTMGRID_POSTHOG_HOST").map(str::to_string))
        .unwrap_or_else(|| "https://us.i.posthog.com".into());
    (key, host)
}

/// Blocking POST of one event envelope to PostHog's ingest endpoint. Best-effort:
/// a network error / missing key is swallowed. Shared by the panic hook (which
/// must post synchronously before the process unwinds) and `posthog_capture`.
fn post_event(key: &str, host: &str, body: &serde_json::Value) {
    if key.is_empty() {
        return;
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(3))
        .build();
    let _ = agent
        .post(&format!("{}/i/v0/e/", host.trim_end_matches('/')))
        .set("Content-Type", "application/json")
        .send_string(&body.to_string());
}

/// Fire-and-forget capture of a shell lifecycle event, enriched with the common
/// triage context (OS / arch / app version) so a failure is filterable by platform
/// — the whole point of this instrumentation. Runs on a detached thread so it
/// never blocks startup. `distinct_id` is the shared "desktop-shell" pseudo-person
/// (the shell has no signed-in user; the renderer emits user-scoped health events).
fn posthog_capture(event: &'static str, mut properties: serde_json::Value) {
    let (key, host) = posthog_config();
    if key.is_empty() {
        return;
    }
    if let Some(obj) = properties.as_object_mut() {
        obj.insert("platform".into(), serde_json::json!(std::env::consts::OS));
        obj.insert("arch".into(), serde_json::json!(std::env::consts::ARCH));
        obj.insert("version".into(), serde_json::json!(env!("CARGO_PKG_VERSION")));
        obj.insert("source".into(), serde_json::json!("tauri-shell"));
    }
    let body = serde_json::json!({
        "api_key": key,
        "event": event,
        "distinct_id": "desktop-shell",
        "properties": properties,
    });
    std::thread::spawn(move || post_event(&key, &host, &body));
}

/// The shell could not spawn the engine at all. `reason` is one of `dir_missing`,
/// `binary_missing`, `spawn_error`.
fn report_sidecar_failure(reason: &'static str, detail: &str) {
    posthog_capture(
        "sidecar_spawn_failed",
        serde_json::json!({ "reason": reason, "detail": detail }),
    );
}

/// The engine exited unexpectedly soon after launch (carries the stderr tail).
fn report_sidecar_exit(code: Option<i32>, uptime: Duration, stderr_tail: &str) {
    posthog_capture(
        "sidecar_exited",
        serde_json::json!({
            "code": code,
            "uptime_ms": uptime.as_millis() as u64,
            "stderr_tail": stderr_tail,
        }),
    );
}

/// Report shell panics to PostHog Error Tracking, then delegate to the default
/// (stderr) hook. Best-effort: a missing key or a network error is silently
/// ignored and the post never re-panics. Without this a Rust-side panic (sidecar
/// spawn, updater, window setup, the `.run(...)` expect below) dies to stderr with
/// no remote trace.
fn install_panic_hook() {
    let (key, host) = posthog_config();
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default_hook(info);
        if key.is_empty() {
            return;
        }
        let message = info.to_string();
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let body = serde_json::json!({
            "api_key": key,
            "event": "$exception",
            "distinct_id": "desktop-shell",
            "properties": {
                "$exception_list": [{ "type": "RustPanic", "value": &message }],
                "$exception_type": "RustPanic",
                "$exception_message": &message,
                "source": "tauri-shell",
                "location": location,
            }
        });
        // Synchronous: the process is unwinding, so a detached thread might not
        // get scheduled before it exits.
        post_event(&key, &host, &body);
    }));
}

/// Hand the webview the engine's boot facts + captured stderr so "Copy
/// diagnostics" self-reports a dead engine (the renderer can't otherwise see any
/// of this). Read live so a crash that lands after launch is still reflected.
#[tauri::command]
fn sidecar_diagnostics(diag: tauri::State<Diagnostics>) -> serde_json::Value {
    let mut out = diag
        .facts
        .lock()
        .map(|f| f.clone())
        .unwrap_or_else(|_| serde_json::json!({ "spawnStatus": "unknown" }));
    out["stderrTail"] = state_stderr_tail(&diag.stderr_tail).into();
    out
}

fn main() {
    // Surface shell panics to PostHog before anything else can crash.
    install_panic_hook();
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
        .invoke_handler(tauri::generate_handler![sidecar_diagnostics])
        .setup(|app| {
            let boot = spawn_sidecar(app);
            let has_child = boot.child.is_some();
            app.manage(Sidecar {
                child: Mutex::new(boot.child),
                shutting_down: AtomicBool::new(false),
            });
            // Keep the boot facts + live stderr tail reachable from the
            // `sidecar_diagnostics` command (managed even on spawn failure, so the
            // failure reason is itself reportable).
            app.manage(Diagnostics {
                facts: Mutex::new(boot.facts),
                stderr_tail: boot.tail,
            });
            // Watch for an unexpected early exit so a crashing engine is reported,
            // not just left spinning behind the "Server not reachable" banner.
            if has_child {
                monitor_sidecar(app.handle().clone());
            }

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
                    // Flag shutdown FIRST so the liveness monitor treats the kill
                    // below as intentional, not a crash to report.
                    state.shutting_down.store(true, Ordering::SeqCst);
                    if let Ok(mut guard) = state.child.lock() {
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
