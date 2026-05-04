CREATE TABLE IF NOT EXISTS familiar_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS familiar_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_ms        INTEGER NOT NULL,
    kind         TEXT    NOT NULL,
    session_id   TEXT    NOT NULL,
    payload_json TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON familiar_events(ts_ms);

CREATE TABLE IF NOT EXISTS familiar_summaries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_ms         INTEGER NOT NULL,
    summary       TEXT    NOT NULL,
    last_event_id INTEGER NOT NULL,
    tokens_in     INTEGER NOT NULL DEFAULT 0,
    tokens_out    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS familiar_missions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id  TEXT    NOT NULL,
    started_ms  INTEGER NOT NULL,
    finished_ms INTEGER,
    digest      TEXT    NOT NULL DEFAULT '',
    objective   TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS familiar_directives (
    id          TEXT    PRIMARY KEY,
    proposed_ms INTEGER NOT NULL,
    decided_ms  INTEGER,
    state       TEXT    NOT NULL,
    kind        TEXT    NOT NULL,
    payload     TEXT    NOT NULL,
    rationale   TEXT    NOT NULL,
    block_reason TEXT
);

CREATE TABLE IF NOT EXISTS familiar_chat (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_ms   INTEGER NOT NULL,
    role    TEXT    NOT NULL,
    content TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS familiar_costs (
    day       TEXT PRIMARY KEY,
    spend_usd REAL NOT NULL DEFAULT 0
);
