# Website local acceptance evidence — 14 October 2026

`summary.json` records the category and exact source/artifact. Complete assertion reports are
losslessly compressed as `.json.gz`; `artifact-index.json` pins both compressed and expanded hashes.
For example: `gzip -dc chromium-browser-qa.json.gz`.

The reports use synthetic fixtures and unauthenticated local browser contexts. Three local engines
and automated axe checks do not establish physical-device, real-account or production acceptance.
The current staging receipt is separate; do not substitute its newer bundle for this local evidence.
`unit-regression.log` was rerun against source `599dcf9` with:

```
env -u NODE_OPTIONS /Users/oculus/.hermes/node/bin/node --test tests/v5-p21-*.test.js tests/v51-p21-*.test.js tests/v52-p21-powers.test.js
```

Result: 270 pass, 0 fail, 5 skip. Skips require an owned disposable PostgreSQL/Redis integration lab.
No credentials, authenticated traces or player records were included.
