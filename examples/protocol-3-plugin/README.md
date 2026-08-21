# Protocol 3 cross-environment example

This fixture demonstrates the supported pattern for a plugin that runs both in
ordinary Harness and DSH Studio: feature-detect the SDK, check the advertised
capability, retain the disposer, and leave the ordinary browser path unchanged
when the host is absent.

The example intentionally does not run shell commands, mutate a profile or read
the dropped path. Those capabilities are not part of the desktop contract.
