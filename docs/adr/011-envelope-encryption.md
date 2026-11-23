# ADR-011: Envelope encryption for provider credentials

**Status:** Accepted (implemented in Phase 4: `libs/security/envelope-crypto.ts`, `provider_connections.encrypted_token`) · 2026-11-23

## Decision

Provider tokens, GitHub App keys and AI keys are encrypted with **AES-256-GCM** using a per-record data key.
The data key is wrapped by a master key (`CREDENTIALS_MASTER_KEY` in development, a KMS in production).
Ciphertext, IV, auth tag and key version are stored. Plaintext never leaves the backend, is never logged,
and API responses expose only write-only/"configured" flags.

## Consequences

Key rotation re-wraps data keys without re-encrypting payloads.
