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

## The file is absent until the certificate is issued

There is deliberately no placeholder: an unparseable stand-in would fail deep
inside jsign with a Java stack trace. Missing, it fails immediately with a
named error that says exactly what is missing. Windows builds run unsigned
(with a `::warning::`) until then.

## Installing it once Sectigo issues

Sectigo delivers the leaf plus a chain bundle. Assemble leaf-first and strip
anything that is not a certificate:

```bash
cat jarvis-codesign.crt SectigoPublicCodeSigningCA.crt \
  > sidecar/packaging/windows/codesign-chain.pem

# sanity: leaf first, subject = our legal name, then the intermediate(s)
openssl crl2pkcs7 -nocrl -certfile sidecar/packaging/windows/codesign-chain.pem \
  | openssl pkcs7 -print_certs -noout
```

The leaf's public key must be the one in the Cloud KMS key version named by
`GCP_KMS_KEY_ALIAS` — compare with:

```bash
gcloud kms keys versions get-public-key 1 --key <key> --keyring <ring> \
  --location <loc> --output-file /tmp/kms.pub
openssl x509 -in sidecar/packaging/windows/codesign-chain.pem -pubkey -noout \
  | diff - /tmp/kms.pub && echo "leaf matches the HSM key"
```

Full onboarding, including the CSR and the GCP setup, is in
code-signing/windows-setup.md in the usejarvis-docs repo.
