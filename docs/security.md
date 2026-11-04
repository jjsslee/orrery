# Security and privacy

[Documentation](README.md) · [English product guide](../README.md) · [한국어 소개](../README.ko.md)

## What stays on your computer

Orrery resolves AWS credentials from your local configuration and sends authenticated requests directly to AWS. It does not require an Orrery account or upload your resource inventory to an Orrery-hosted backend. Desktop updates contact this repository's public GitHub Releases.

Resource metadata and relationship history are cached locally in plaintext. Display preferences and saved monitoring selections are stored locally. A cache TTL is a reuse policy, not a secure deletion policy. Protect the device and its user account accordingly.

## Read-only boundaries

AWS resource clients enforce an explicit service-and-command allowlist before signing and transmission. There are no AWS create, update, or delete controls in the interface. Unused sensitive read operations such as `GetSecretValue`, `GetSessionToken`, and `GetObject` are not allowed by the resource client guard.

Credential providers and AWS CLI authentication are separate from resource discovery. The guard is not a replacement for IAM: use a dedicated profile or role with the permissions you intend to grant. Read-only CloudWatch requests can incur AWS charges.

## Local access

The API binds to loopback. Host, origin, and browser request checks restrict access, and all APIs except health require a per-run bearer token. Source runs obtain it through a private local access file; the desktop app passes it to its own page. Tokens are removed from the visible URL and are not used as API query parameters.

Desktop pages retain sandboxing and context isolation with Node integration disabled. The renderer receives no filesystem or updater IPC access. Local fonts avoid remote font requests. On macOS/Linux, private storage uses restricted file modes; Windows applies a user-specific DACL and stops startup if that protection cannot be applied.

These controls do not defend against malware already running as the same OS user, an administrator, or compromised AWS credentials.

## Updates and their limits

The updater trusts `jjsslee/orrery` release publishing permissions and HTTPS. It verifies download size, GitHub's SHA-256, archive paths and symlinks, and the package version/OS/CPU before replacing the app. GitHub's digest is not an independent publisher signature against a compromised release account.

macOS builds use ad-hoc signing. Apple Developer ID signing/notarization and Windows publisher signing are not configured. OS or organization policies can block installation, updates, or rollback. Update code does not remove quarantine flags or disable platform security controls.

See the [update runbook](self-update.md) (Korean) for backup locations, failure states, and manual recovery. Native Windows update behavior still requires real-device verification; local fixture tests are not a substitute.

## Reporting an issue

For ordinary product bugs, use [GitHub Issues](https://github.com/jjsslee/orrery/issues) with the app version, OS/CPU, expected behavior, and a sanitized example. Do not post credentials, access URLs, account inventories, or private infrastructure details. Check the repository's [Security page](https://github.com/jjsslee/orrery/security) for available private reporting options before disclosing a sensitive issue.

The dated [security implementation record](security-hardening.md) is historical evidence, not a claim that every current platform or environment has been tested.
