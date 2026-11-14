# FCS Site QA – cloud copy

Inspection and test records app for FCS (Farrelly Construction Services), Belmont Desalination Plant – MFRO Building.

- `server.js` – Node server: shared site password, records in Postgres, files in a private bucket.
- `public/index.html` – the app (built from the claude.ai version by `build_cloud.py` with `shim.js`).
- `public/import.html` – one-off import of records and files exported from the claude.ai app.

No records, passwords or keys are stored in this repository. Settings come from environment variables on the host:
`SITE_PASSWORD`, `SESSION_SECRET`, `ADMIN_TOKEN`, `DATABASE_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_KEY`, `S3_SECRET`, `STORAGE_QUOTA_BYTES`.
