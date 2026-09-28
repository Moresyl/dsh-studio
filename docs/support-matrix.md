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
| Packaged frontend bytes | MSI/NSIS resource checks | Mounted DMG resource checks | AppImage/DEB/RPM extraction checks |
| Full packaged runtime | Own Node and authenticated Profile boot in release CI | Own Node and authenticated Profile boot in release CI | Own Node and authenticated Profile boot in release CI |
| Installer upgrade/uninstall | Automatic on ephemeral release CI; prior Lite and Full | Physical installer acceptance still required | System package-manager acceptance still required |
| Real display, sleep/wake, firewall | requires device run | requires device run | requires device run |

Local Windows packaging rehearsal extracts MSI resources without registering an
installation. Stateful NSIS install/upgrade/uninstall runs automatically only on
ephemeral GitHub Actions runners (or an explicit local opt-in). A headless
`--smoke-test` alone proves executable loading, not GUI startup. Resource hashes,
packaged offline boot, actual Windows WebView interaction and real-device checks
are separate evidence.

Release artifacts stay in a draft until the build matrix, packaged-app checks,
complete artifact/updater inventory and checksums pass. OS publisher signatures
and macOS notarization are verified only when their credentials are configured;
the required updater signatures are a different mechanism.

## Reporting a failure

Include the Studio version, OS build, selected Profile, exact action, timestamp,
and a redacted diagnostics export. Never attach API keys, pairing credentials,
home-directory secrets, or full environment dumps.
