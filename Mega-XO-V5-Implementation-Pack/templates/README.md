# Template use

These files are deliberately unfilled. They contain no deployment credentials, provider IDs or successful execution claims. Copy them into the repository's `docs/v5/` and restricted evidence store as appropriate, then replace nulls with verified nonsecret facts.

`evidence.template.json` records a single task/test/deployment observation. `environment-inventory.template.json` records actual provider objects and secret references. `route-and-data-inventory.template.json` is a coverage scaffold, not a complete route/schema inventory. `release-manifest.template.json` and `cutover-event.template.json` are not runnable deployment configurations.

Keep raw data, credentials and sensitive traces out of Git. Evidence files may refer to protected storage locations, hashes and redacted summaries. Device/provider status must come from actual observation. Never mark all null template fields complete to satisfy a checklist.
