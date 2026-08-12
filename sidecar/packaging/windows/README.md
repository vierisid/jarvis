# Windows code-signing chain

`codesign-chain.pem` is the **public** certificate chain for our Authenticode
signature: the Sectigo OV code-signing leaf first, then every intermediate up
to (but not including) the root.

It lives in the repository on purpose. The private key is a Google Cloud HSM
key, and Cloud KMS stores *only* the key — it has no notion of a certificate —
so `jsign --storetype GOOGLECLOUD` requires the chain to be supplied with
`--certfile`. Certificates are public by construction: shipping this file
leaks nothing, and versioning it means a renewal is a reviewable diff.

`scripts/sign-windows.sh` reads it from
`sidecar/packaging/windows/codesign-chain.pem` by default; set
`CODESIGN_CERT_FILE` to point somewhere else.

## What is installed

| | |
|---|---|
| Leaf | `CN=Usejarvis Inc., O=Usejarvis Inc., ST=Delaware, C=US` |
| Issuer | Sectigo Public Code Signing CA R36 |
| Serial | `99D22DF966EC85DDB3B46CFD4DF01400` |
| Valid | 2026-08-11 → **2027-08-11** |
| Key | Cloud KMS `jarvis-codesign` version 1 (keyring `jarvis`, project `usejarvis-prod`) — non-exportable, HSM |

The chain is leaf → *Sectigo Public Code Signing CA R36* → *Sectigo Public
Code Signing Root R46*. That last one reads like a root but is cross-signed by
*USERTrust RSA Certification Authority*, so it is an intermediate here and
belongs in the file; USERTrust is the actual root and is omitted.

`SIGNING_PUBLISHER_CN` must be exactly `Usejarvis Inc.` (trailing period
included) — `sign-windows.sh` compares it to the signature's CN character for
character and fails the build on any difference.

**Renewal is due before 2027-08-11.** See code-signing/renewal.md in
usejarvis-docs; the key stays put, so renewal replaces only this file.

## How it was assembled (and how to redo it at renewal)

Sectigo does not deliver separate `.crt` files. What arrives is a single
extensionless **`CollectCCC`** download, which is a DER-encoded PKCS#7 holding
all four certificates — leaf, both intermediates and the root — in chain
order. `-inform DER` is required. Omitting it fails loudly on its own, but
pipe the output into `head`/`grep` and the pipeline's exit status becomes that
of the last command — the parse error vanishes and an empty result reads as
success. Check the certificates are really there, not just that it exited 0:

```bash
openssl pkcs7 -inform DER -in ~/Downloads/CollectCCC -print_certs -noout   # inspect
openssl pkcs7 -inform DER -in ~/Downloads/CollectCCC -print_certs \
  | awk '/-----BEGIN CERT/,/-----END CERT/' > /tmp/all.pem
csplit -sz -f /tmp/cert- -b '%02d.pem' /tmp/all.pem '/-----BEGIN CERTIFICATE-----/' '{*}'
cat /tmp/cert-00.pem /tmp/cert-01.pem /tmp/cert-02.pem \
  > sidecar/packaging/windows/codesign-chain.pem   # drop cert-03, the root
```

The indices above are for the bundle we received; confirm the real order and
count from the inspect step rather than assuming them.

Then run all three checks before committing. The first is the one that
matters: jsign signs with whatever key Cloud KMS holds and presents whatever
certificate this file names. If they are not the same key, signing still
"succeeds" and every resulting signature fails verification on the user's
machine.

```bash
# 1. the leaf really is the Cloud KMS key
gcloud kms keys versions get-public-key 1 \
  --key jarvis-codesign --keyring jarvis --location global \
  --project usejarvis-prod --output-file /tmp/kms.pub
openssl x509 -in sidecar/packaging/windows/codesign-chain.pem -pubkey -noout \
  | diff - /tmp/kms.pub && echo "leaf matches the HSM key"

# 2. leaf first, then intermediates, no root
openssl crl2pkcs7 -nocrl -certfile sidecar/packaging/windows/codesign-chain.pem \
  | openssl pkcs7 -print_certs -noout

# 3. the chain actually builds to a trusted root (verifies the file's first
#    cert — the leaf — using the rest of the file as intermediates)
openssl verify -untrusted sidecar/packaging/windows/codesign-chain.pem \
  sidecar/packaging/windows/codesign-chain.pem
```

Full onboarding, including the CSR and the GCP setup, is in
code-signing/windows-setup.md in the usejarvis-docs repo.
