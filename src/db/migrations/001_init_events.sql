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

-- Immutability enforcement (application-level for DELETE; trigger for UPDATE)
-- DELETE trigger removed: SQLite ROLLBACK operates at page level and does not fire
-- triggers, but removing it avoids any edge-case conflicts with transaction rollbacks.
-- The EventLog class enforces append-only access at the application level.
CREATE TRIGGER IF NOT EXISTS events_immutable_update
BEFORE UPDATE ON events
BEGIN
    SELECT RAISE(ABORT, 'Event log is immutable: updates are forbidden');
END;
