-- Filings already indexed, so ingest can resume and skip.
CREATE TABLE IF NOT EXISTS filings (
  accession TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  company TEXT NOT NULL,
  form TEXT NOT NULL,
  filed TEXT NOT NULL,
  url TEXT NOT NULL,
  chunks INTEGER NOT NULL,
  ingested_at TEXT NOT NULL
);

-- Policy events pulled from the Federal Register.
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,            -- Federal Register document number
  title TEXT NOT NULL,
  abstract TEXT,
  url TEXT NOT NULL,
  published TEXT NOT NULL,        -- YYYY-MM-DD
  doc_type TEXT,
  agencies TEXT,                  -- JSON array of names
  category TEXT,                  -- tag from the fixed list, or NULL until tagged
  keywords TEXT,                  -- JSON array
  relevant INTEGER,               -- 1 if the tagger judged it relevant to listed companies
  model TEXT,
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS events_published ON events (published DESC);

-- One exposure note per event and company. citations is a JSON array of
-- {chunk_id, form, filed, url, section, text}.
CREATE TABLE IF NOT EXISTS notes (
  event_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  company TEXT NOT NULL,
  summary TEXT NOT NULL,
  citations TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, ticker)
);
