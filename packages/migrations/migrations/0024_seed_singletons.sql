-- V5 P02 (V5-02-03) - singleton seeding (design section 4/7: singleton seeding belongs to the
-- migration_owner path). ON CONFLICT DO NOTHING keeps re-runs safe; nothing else mints rows and
-- no constructor is invoked (spec 01 section 2).
INSERT INTO runtime.controls (id, maintenance) VALUES (1, false)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO economy.system_burns (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO season.league_week (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;
