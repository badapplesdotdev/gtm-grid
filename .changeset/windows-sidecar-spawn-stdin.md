---
"@gtmgrid/desktop": patch
---

Fix the Windows "couldn't start the engine" failure: the bundled Node sidecar
never spawned, leaving the app stuck on the engine-error screen.

The shell is built `windows_subsystem = "windows"` (no console), so its
`STD_INPUT_HANDLE` is null. `spawn_sidecar` piped stdout/stderr but left **stdin
as the default `inherit()`**. On Windows, piping any stream switches the child to
`STARTF_USESTDHANDLES`, and `CreateProcessW` then requires a valid handle for all
three streams — inheriting the null stdin makes the spawn fail with
`ERROR_INVALID_HANDLE`, so `node.exe` never launched and the engine read as
unreachable. (It worked from a console and in the CI smoke test because those have
a real stdin; only the console-less GUI spawn hit the null handle.)

Spawn the sidecar with `stdin(Stdio::null())` so it always gets a valid handle,
plus `CREATE_NO_WINDOW` (no transient console flash) and an explicit
`current_dir` matching the smoke harness.
