---
"@gtmgrid/server": patch
---

Agent turns are no longer killed mid-task during long (especially cloud) runs. The single fixed 5-minute wall-clock watchdog is replaced by two independent timeouts: an IDLE timeout (5 min, re-armed on every chunk the CLI streams on stdout **or** stderr) that fires only when a process is genuinely hung, and a CEILING backstop (60 min) for a child that streams forever. An actively-working turn never goes idle, so it runs to completion.
