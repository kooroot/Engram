CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
    type        TEXT NOT NULL CHECK(type IN ('observation','action','mutation','query','system')),
    source      TEXT NOT NULL CHECK(source IN ('user','agent','system')),
    session_id  TEXT,
    content     TEXT NOT NULL,
    state_ref   TEXT,
    checksum    TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);

-- Immutability enforcement
CREATE TRIGGER IF NOT EXISTS events_immutable_update
BEFORE UPDATE ON events
BEGIN
    SELECT RAISE(ABORT, 'Event log is immutable: updates are forbidden');
END;

CREATE TRIGGER IF NOT EXISTS events_immutable_delete
BEFORE DELETE ON events
BEGIN
    SELECT RAISE(ABORT, 'Event log is immutable: deletes are forbidden');
END;
