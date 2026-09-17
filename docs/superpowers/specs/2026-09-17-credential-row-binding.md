# Row-bound credential ciphertext and strict encryption

Follows `2026-09-16-native-credential-encryption.md`, which closed the write
path but left two limits it named explicitly. This change removes both.

## What was provable before

`enc1:` is AES-256-GCM with a fresh IV and the tag stored beside the
ciphertext, and it passes no associated data. Nothing tied a blob to the row
it came from, so pasting row A's `value` column into row B made row B read
back as row A's credential and authenticate cleanly:

```
row-b after pasting row-a ciphertext: {"token":"FAKE-ADMIN-TOKEN-AAAA"}
=> ciphertext NOT bound to row: true
```

A database writer with no key at all could point a low-privilege piece at a
high-privilege credential by copying one column. Separately, `decryptJson`
treated any value without the prefix as legacy plaintext before any crypto
ran, so a writer could replace a ciphertext with plaintext JSON of their
choosing and be believed. Neither is a decrypt-failure fallback: a wrong-key
`enc1:` value already fails closed on base64, length, tag and post-decrypt
JSON. The gap was that the absence of a prefix routed around crypto entirely.

## The `enc1a:` envelope

Same algorithm, IV length and layout as `enc1:`; the difference is that GCM
runs with associated data. The AAD is a versioned, length-prefixed encoding of
four columns:

```
jarvis.app_connection.v1
<len>:<id>
<len>:<project_id>
<len>:<piece_name>
<len>:<external_id>
```

Length prefixes keep the encoding injective, so no two distinct identity
tuples produce the same bytes regardless of what separators an `external_id`
contains.

Why those four. `id` is the primary key, and binding it alone already defeats
the column-paste above. It does not defeat the other half of the same attack:
relabel row A's `piece_name` or `external_id` and the lookup a low-privilege
piece performs resolves to row A, whose ciphertext still opens because its
`id` never moved. `project_id`/`piece_name`/`external_id` are
`uq_app_connection_external`, the exact tuple `getConnectionByExternalId`
resolves, so binding them closes that path too.

The cost is that renaming any of the four out of band requires a re-encrypt
rather than an UPDATE. That is the accepted trade, and it is currently free:
no code path writes those columns after insert. `upsertConnection` looks the
row up by that tuple and updates only `display_name`, `type`, `status`,
`value`, `metadata`, `piece_version`, `owner_id`, `scope`,
`pre_select_for_new_projects` and `updated`. Deliberately excluded from the
AAD: `piece_version` and `display_name` change on every legitimate re-connect,
and `updated` changes on every write. Binding any of them would turn a normal
upsert into a re-encrypt requirement and a normal rename into a lockout.

The row id is now minted before the ciphertext, since it is part of what the
ciphertext is sealed against. A key or serialization failure still cannot save
plaintext: nothing is written on either arm.

## Mixed-format tables

During and after conversion `app_connection` can hold plaintext, `enc1:` and
`enc1a:` rows at once. Every read funnels through `rowToConnection`, which
reads the identity columns off the row it is decrypting and hands them to
`decryptBoundJson`. That accepts all three shapes: `enc1a:` checked against
the binding, `enc1:` with no associated data (so it keeps reading wherever it
sits), and plaintext unless strict mode refuses it.

An `enc1a:` value read without a binding is refused outright rather than
attempted without AAD, so the error names the real cause instead of blaming
the key.

`isEncrypted` covers both prefixes and `ENCRYPTED_VALUE_SQL` is the shared SQL
form of the same question. "Does this table hold ciphertext?" checks must use
one of them: `enc1a:` is not an `enc1:` value, so a check written against a
single prefix literal goes blind to converted rows.

## Conversion

`migrate-native-credentials.ts bind` re-wraps every row that is not already
row-bound, covering legacy plaintext and `enc1:` in one pass, so a deployment
reaches the end state without staging through `apply`. `apply` remains for a
deployment mid-#473 rollout and for rolling back an existing v1 journal.

The shape is the one `apply` established: one `BEGIN IMMEDIATE` transaction
under `PRAGMA synchronous = FULL`, both the daemon-root and data-directory
locks held throughout, every row authenticated before any write, an encrypted
recovery journal created with `openSync(path, "wx", 0o600)` and fsynced along
with its parent directory before the first UPDATE, and optimistic
`UPDATE ... WHERE id = ? AND value = ?` so a concurrent change aborts
everything. Only `value` changes; ids, timestamps and metadata are preserved.

A crash before commit leaves every row byte-for-byte original. A crash after
commit leaves the journal durable on disk. A credential is never lost, only
left un-converted, and a journal that survives a failed transaction still
rolls back cleanly.

The binding journal is `jarvis-credential-binding-v1` and carries each row's
identity tuple, because a row-bound blob cannot be authenticated without it
and the journal has to be checkable on its own before any write. Validation
proves both recorded blobs decrypt to the same credential, refuses a record
belonging to another database, and accepts only the original or the exact
converted value per row, so a credential written since conversion is never
overwritten. Reverse it with `rollback-binding`, which restores the exact
original bytes -- `enc1:` or plaintext, whichever the row held. The two
journal formats refuse each other.

What conversion cannot do: an `enc1:` blob carries no identity, so binding it
can only bind it to the row it currently sits in. If a writer had already
rearranged unbound rows before conversion, the pass seals that arrangement in
rather than detecting it. Rows that are already bound are different: a
relabelled `enc1a:` row fails to authenticate, so the conversion refuses
instead of laundering the rearrangement. Authenticate the inventory against
the deployment's own records before converting, as #473's operator procedure
already requires.

Key rotation preserves envelopes rather than normalizing them: an `enc1a:` row
is re-sealed row-bound under the new key. Re-wrapping it as `enc1:` would
silently undo the binding, which is the one thing a rotation must not do.

## Strict mode

`setRequireEncryptedCredentials(true)` makes a value with no envelope prefix a
refusal instead of an input. It defaults off and stays off unless an operator
sets `JARVIS_REQUIRE_ENCRYPTED_CREDENTIALS=1`, because releases v0.6.0 through
v0.13.7 wrote plaintext rows and refusing them before a deployment has
converted would lock it out of credentials it still needs.

It refuses plaintext only. An un-converted `enc1:` row still reads, so strict
mode and the binding conversion are independent steps and neither blocks the
other.

The gate is `enableStrictCredentialEncryption`, which runs the inventory first
and refuses -- leaving the flag off -- while any readable-plaintext row
remains. Refusing rather than warning-and-enabling is the choice: enabling
early breaks credential reads lazily, one piece at a time, which is the
hardest failure to attribute, while a refusal is recoverable by running the
conversion. `invalidLegacy` rows are not a blocker, because a value that is
neither an envelope nor valid JSON already fails every read and strict mode
changes nothing for it but the error text.

At boot the env var is treated as an operator assertion that conversion
finished. If it is false the daemon refuses to start, rather than resolving it
silently in either direction: enabling anyway would break reads scattered
across pieces, and ignoring the variable would leave the operator believing
plaintext is refused when it is not. Unsetting the variable undoes the refusal
and touches no data.

Refusal messages name the cause and never quote the value, before or after
decryption, on either path.

## Verification scope

Synthetic tests only; temporary databases and obviously-fake sentinels. They
establish no deployed credential count and no live disclosure.

Covered: the column paste through `getConnection`,
`getConnectionByExternalId`, `getUniqueConnectionByExternalId` and
`listConnections`; each of the four bound fields changed alone; the mutable
columns changed together, proving a legitimate re-connect still reads;
plaintext, `enc1:` and `enc1a:` rows in one table; strict mode refusing
plaintext while the `enc1:` row still reads; the bind pass over plaintext and
`enc1:` rows with timestamps unchanged; repeated bind and repeated rollback;
a `RAISE(ABORT)` trigger firing mid-transaction with every row original and
the journal still replayable; unreadable rows blocking every write; wrong
keys, tampered journals, another database path, changed and deleted rows, a
held daemon lock, a relabelled bound row refused rather than re-sealed, and
each journal format refusing the other; the strict gate refusing, refusing
without downgrading an already-strict daemon, and then accepting; the boot
setting reading the variable and propagating the refusal; and a rotation
leaving an `enc1a:` row row-bound.

Unchanged and still asserted from #473: ciphertext never contains the
plaintext, the IV is fresh per call, and no error message echoes credential
text.

## Out of scope

Key path resolution. `JARVIS_HOME` handling and the relocation of the key file
belong to #480 and are not touched here.
