# Deferred work context

These notes preserve context for later planning. GitHub owns status, priorities,
scheduling, and release ordering; this is not a second issue tracker. Update or
remove a note when its context is resolved. Notes do not authorize extra work.

## Cross-runtime integration CI

[GitHub issue](https://github.com/grazzolini/tuneforge/issues/601)

The Rust integration test exercises real Python result producers, native apply
and replay, then native edits verified by Python. Inference is mocked; persistence
and reconciliation remain real. Static shared fixtures do not provide equivalent proof.

The test is compiled but ignored by default because `desktop_tauri` has no prepared
Python backend environment. Adding backend setup there would increase runtime and
cache costs. Keep the test and Python fixture available for explicit manual execution.

Revisit when a dedicated cross-runtime lane can preserve this proof while maintaining
the current pipeline runtime and avoiding substantial cache growth. Validate image
dependency size, provenance, job scope, runtime, and cache impact before enabling it.

Source pointers:

- [Rust test and fixture launcher](apps/desktop/src-tauri/src/mobile_backend/reconciliation.rs)
- [Python fixture](apps/backend/tests/result_sync_fixture.py)
- [CI jobs and scope](.github/workflows/ci.yml)
- [CI image producer and consumer policy](.github/ci/README.md)

For manual execution, use the prepared Python backend, repository-owned SoXR, and
fresh synthetic data, transport, cache, and temporary roots:

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib \
  mobile_backend::reconciliation::tests::python_producers_native_apply_result_matrix_and_bidirectional_replay \
  -- --exact --ignored
```
