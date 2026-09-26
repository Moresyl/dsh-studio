# Support and verification matrix

This matrix separates automated evidence from platform acceptance. A green local
test does not imply that every desktop environment has been physically verified.

The managed baseline is `@deepseek-ai/dsh@0.1.7-rc.2`. CI cold-installs its
integrity-locked graph and boots a real authenticated Web Profile before release.

| Area | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Rust and frontend unit tests | CI + local | CI build target | CI build target |
| Hidden child-process launch | `CREATE_NO_WINDOW` contract | native process path | native process path |
| Harness supervision and readiness | automated | automated | automated |
| Installer upgrade smoke | opt-in stateful Windows runner | requires signed macOS runner | requires distro runner |
| Real display, sleep/wake, firewall | requires device run | requires device run | requires device run |

## Reporting a failure

Include the Studio version, OS build, selected Profile, exact action, timestamp,
and a redacted diagnostics export. Never attach API keys, pairing credentials,
home-directory secrets, or full environment dumps.
