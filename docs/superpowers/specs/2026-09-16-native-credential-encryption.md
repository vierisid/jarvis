# Native credential encryption and legacy conversion

## Write boundary

`upsertConnection` now computes one `encryptJson(input.value)` before either
INSERT or UPDATE. A key/serialization failure cannot fall back to plaintext.
The existing AES-256-GCM `enc1:` format, random IVs, key resolution and legacy
read compatibility are unchanged. POST, repeated POST and PATCH use this
repository boundary. API responses continue to omit credential values.

Legacy reads remain read-only. Malformed JSON errors omit parser snippets,
which may contain secrets, both before and after decryption. Migration errors
and output contain fixed messages/counts, never row values or key material.

## What this protects, and what it does not

The `enc1:` envelope is AES-256-GCM with a fresh 12-byte random IV per write
and the auth tag stored beside the ciphertext. Reading an `enc1:` value fails
closed: a wrong key, a truncated blob or a flipped byte raises instead of
yielding a value. None of that is new here; only the write path is.

Three limits are deliberate and must not be overstated:

- The key is a local 0600 file (`~/.jarvis/cache/workflow-encryption.key`) or
  an environment variable, which is how this project stores every other secret.
  `src/vault/keychain.ts` records why no OS keychain is used. On a default
  install the key therefore sits on the same filesystem as the database it
  protects. This defends a database file or an archive that travels without the
  key; it does not defend against anyone who can read the data directory.
- The envelope carries no associated data, so a ciphertext is not bound to its
  row. Anyone who can write the database can move a value between rows and the
  result still authenticates. Binding would change the wire format and needs
  its own conversion, so it is not part of this fix.
- Reads still accept legacy plaintext JSON, because rows written by the
  affected versions are plaintext. There is no strict mode that rejects
  plaintext once a deployment has converted, so a database writer can replace
  a ciphertext with plaintext of their choosing and the daemon accepts it.

Losing the key is unrecoverable. `~/.jarvis/cache` is treated as disposable
elsewhere in the project and `jarvis export --full` does not carry this key, so
escrow it separately before converting anything.

## Source-version inventory and deployment prerequisite

History introduces this insert/update mismatch in `d42b23ab` (visual workflow
builder, #212, 2026-05-28). Every checked release tag containing this repository
path has the mismatch: `v0.6.0`, `v0.6.1`, `v0.7.0`, `v0.8.0`, `v0.8.1`,
`v0.8.2`, `v0.9.0`, `v0.10.0`, `v0.11.0`, `v0.12.0`, and `v0.13.0` through
`v0.13.7`. The path is absent from earlier checked release tags, including
`v0.5.5`. Source/package version strings alone do not prove deployment history;
the introducing commit itself still reports package version `0.5.0`.

No deployed database, credential inventory or live leak was inspected. Before
any live conversion, operators must inventory each deployment's actual commit
or image digest and version, its configured DB/data directory and encryption
key source, backup locations/retention, and read-only row counts. Include
custom builds and databases restored from older backups. Record an operator,
date and instance identifier in the deployment inventory without credential
values. The migration tool requires that deployed version/commit identifier
when applying and retains it inside its encrypted recovery record.

## Migration choice

Three approaches were considered:

- Read-time conversion would mutate storage during unrelated reads and leave
  untouched rows indefinitely. It also lacks a clear rollback boundary.
- Reusing key rotation would change both the key and storage at once, expanding
  the recovery problem beyond the insert defect.
- An explicit offline conversion keeps the existing key, authenticates all
  rows first, preserves existing ciphertext, and gives operators a recoverable
  transaction. This is the implemented approach.

There is no startup migration and no endpoint that triggers conversion.
The script runs from a source checkout, as the existing key-rotation script
does. It is not advertised as an installed-package CLI command.

## Operator procedure

1. Deploy the write fix first and finish the deployment inventory above.
2. Run the read-only inventory. `encrypted` counts the envelope prefix, not
   successful authentication; apply authenticates every encrypted row.
3. Verify the exact existing key source against the deployment configuration.
   Securely escrow that key separately from database/recovery artifacts and
   test restore access. Missing keys require investigation, not silent key
   generation. A database with only plaintext has no ciphertext with which to
   verify the supplied key, so configuration matching is essential.
4. Stop the daemon, supervisors and any other writers. Apply/rollback acquire
   and hold both the daemon-root and explicitly supplied data-directory locks.
   They also use SQLite IMMEDIATE transactions. Supply the actual configured
   data directory even when the database lives elsewhere. There is no
   running-daemon override.
5. Apply with a new recovery-file path in an existing private directory. Keep
   the recovery file and the original key for the agreed recovery window.
6. Check counts and credential resolution, then restart the fixed daemon.

```sh
bun scripts/migrate-native-credentials.ts inventory \
  --db /data/instance/jarvis.db --deployment-version DEPLOYED_COMMIT

bun scripts/migrate-native-credentials.ts apply \
  --db /data/instance/jarvis.db --data-dir /data/instance \
  --deployment-version DEPLOYED_COMMIT \
  --key-file /secure/existing-workflow-encryption.key \
  --recovery /secure/recovery/native-credentials.enc

bun scripts/migrate-native-credentials.ts rollback \
  --db /data/instance/jarvis.db --data-dir /data/instance \
  --key-file /secure/existing-workflow-encryption.key \
  --recovery /secure/recovery/native-credentials.enc
```

For environment-managed keys, inherit `JARVIS_WORKFLOW_ENCRYPTION_KEY` from
the deployment's secret manager and omit `--key-file`. Never paste keys into
command-line arguments or shell history. Supplying both sources is rejected.
The script never generates or rotates a key. Inventory does not need a key.

## Recovery semantics

The recovery file is itself encrypted with the existing key and created with
exclusive creation and mode 0600. It contains the canonical DB path, format,
deployed version identifier, row IDs, exact original serialized values and
their replacement ciphertexts. File and directory fsync complete before any
row update. Only `value` changes; IDs, timestamps and metadata are preserved.
Already-encrypted rows are authenticated but left byte-for-byte unchanged.

A failure during conversion rolls back all row changes. A recovery file may
remain after a failed transaction or crash and must be retained for inspection.
If a crash occurs before commit, SQLite restores the original values; if after
commit, the encrypted journal is already durable. Rollback checks every listed
row before any write, accepting only the original or exact migrated value.
Changed/deleted rows, another DB path, tampering and wrong keys cause refusal.
It never overwrites a newer credential to force recovery.

Repeated apply after success is a no-op and does not replace the journal.
Repeated rollback is also a no-op. A failed pre-commit migration's journal
can be rolled back safely. A new apply after rollback needs a new journal path.
Rollback deliberately restores legacy plaintext; use it only during a stopped
maintenance window, then resolve the failure and migrate again. Keep the write
fix installed. Do not rotate keys during the recovery window: doing so requires
retaining the old key and reconciling changed ciphertext first.

## Backups and physical storage

Conversion encrypts live logical values. It does not sanitize old SQLite pages,
WAL/journals, filesystem snapshots, copied databases or existing archives.
Never claim that updating a legacy row erased every historical plaintext copy.
Do not copy only a live `jarvis.db`: committed data may still be in its WAL.
Use a consistent SQLite snapshot and protect the entire export with an
independent backup-encryption mechanism. Validate restores in isolation with
the exact key and the fixed reader before changing retention or deleting data.

The current `jarvis export` produces a plain tar. Its curated secret list does
not include `workflow-encryption.key`; `--full` does not solve that omission,
nor does it capture an environment-managed workflow key. Explicit separate
key escrow is required. Archives of this shared DB can contain plaintext
native credentials from affected writes even without `--full`. Restrict and
encrypt retained backups; inventory who/what can read them and plan expiry or
replacement according to the deployment's retention requirements. After
restoring an older snapshot, repeat inventory and conversion before service.

No backup deletion, key rotation, database compaction or deployed migration is
performed by this patch. These require the actual deployment and backup
inventory. The encrypted recovery record avoids creating an additional
plaintext rollback copy; it still requires the same protected-key handling.

## Verification scope

Synthetic regression tests cover new and updated raw rows, database/WAL bytes,
API writes and secret-free responses, restart reads, legacy compatibility and
failed keys. Offline subprocess tests cover count-only inventory, mixed legacy
and encrypted rows, unchanged keys/metadata, durable encrypted recovery,
repeated apply/rollback, wrong/missing keys, corruption, transaction failures,
changed/deleted rows, wrong database paths and held daemon locks. Lock coverage
includes aliased directories with no PID file, genuine held locks through an
alias, distinct daemon/data roots and creation of a missing daemon root.

Tests use temporary databases and synthetic values only. They establish neither
a deployed credential count nor a live disclosure.

The two error-message leak tests use identifier-shaped sentinels and first
assert that `JSON.parse` quotes the sentinel back. Without that assertion the
leak check passes whether or not `decryptJson` appends the parser message,
because the parser truncates most malformed input to its first token.
