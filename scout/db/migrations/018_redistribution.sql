-- May this source's values be stored and served onward?
--
-- `commercial_use_allowed` was answering a different question. The Google
-- Places terms permit commercial use and forbid retaining most fields or
-- redistributing them; on the old model that source looked identical to a
-- public-domain one. Anything in the shared travel graph IS redistributed --
-- the API serves it -- so a restricted source must never reach these tables.
ALTER TABLE source_registry ADD COLUMN redistribution TEXT NOT NULL DEFAULT 'attributed'
  CHECK (redistribution IN ('open','attributed','restricted'));

-- How long a value may be kept, where the terms impose a limit. Required of
-- any restricted source: a retention rule nobody wrote down cannot be honoured.
ALTER TABLE source_registry ADD COLUMN cache_days INTEGER;
