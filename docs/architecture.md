# Architecture and trust boundaries

[简体中文](architecture.zh-CN.md)

Personal session names, pins, tags, notes, bookmarks and saved prompts live in a
separate `personal-library.json`. Native validation bounds schema, collections and
the 2 MiB file; serialized writes merge touched fields and commit atomically.
Damaged or unknown formats are never overwritten. Commands are private to the
Studio shell, outside the public Harness bridge and read-only Host contract.
Editing and saving participate in exit, update and renderer-recovery guards.
Workspace summaries read the existing session index without new file-content authority.

DSH Studio hosts Harness; it does not fork it. The React WebView reaches Rust only through commands listed in the Tauri invoke handler. Harness runs as a guarded child bound to loopback. The Rust supervisor parses readiness, probes health, applies restart backoff, and lets a Windows Job Object or Unix process group reclaim the complete child tree.

Supply-chain boundaries are separate: Node is selected from the official index and verified with the published SHA-256; Harness is an exact qualified npm release promoted through staging/backup; catalogs cannot provide executable commands and can suggest only an exact npm name/version that is independently resolved and peer-checked before install.

The remote gateway never changes Harness binding. A pairing code is single-use and expires after two minutes; each redeemed device receives a separate revocable random credential. Persistent logs and exported diagnostics share one redaction path, while file, age and directory caps bound log retention. Diagnostic ZIP input must be a real regular file and is bounded by entry count, per-entry size and total bytes; native dumps are called out separately because binary memory evidence cannot be redacted safely.

CI is the release boundary: tag/config versions must agree, detailed bilingual notes must exist, the platform artifact matrix and updater signatures must be complete, Windows/macOS platform signatures must verify, and only then is the release-wide checksum manifest generated.
