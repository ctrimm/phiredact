# phiredact

The marketing site for **phiredact** — on-device PII and PHI redaction: a small
token-classification model plus a deterministic rules engine, in Python,
TypeScript, Rust and Swift SDKs, a Chrome extension, and a Mac application for
documents and images.

- Design: "Ledger" — editorial, document-first. Five static pages, no build
  step: `/` (home), `/demo/`, `/benchmarks/`, `/mac/`, `/extension/`.
- Source SDKs: https://github.com/ctrimm/phi-redact-sdk
- Working demo: https://corytrimm.com/phi-redact (the in-browser demo on
  `/demo/` is a preview while it is being wired up)

## Deployment

Deployed via **GitHub Pages** from the `main` branch, repository root.
The `CNAME` file declares the custom domain **phiredact.com**;
`.nojekyll` keeps Pages from running the files through Jekyll.

### DNS for the custom domain (Cloudflare, proxy OFF / DNS only)

- Apex `A`: 185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153
- Apex `AAAA`: 2606:50c0:8000::153, 2606:50c0:8001::153, 2606:50c0:8002::153,
  2606:50c0:8003::153
- `www` `CNAME`: ctrimm.github.io

Records must be DNS-only (Cloudflare proxy off) so GitHub can issue the
HTTPS certificate for the domain.
