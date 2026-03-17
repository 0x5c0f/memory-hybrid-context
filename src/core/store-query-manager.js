"use strict";

class StoreQueryManager {
  constructor(deps) {
    this.ensureInitialized = deps.ensureInitialized;
    this.normalizeText = deps.normalizeText;
    this.normalizeSearchStatus = deps.normalizeSearchStatus;
    this.asJson = deps.asJson;
    this.randomUUID = deps.randomUUID;
  }

  countRecords() {
    const conn = this.ensureInitialized();
    return conn.prepare("SELECT COUNT(*) AS c FROM memory_records").get().c || 0;
  }

  countCommits() {
    const conn = this.ensureInitialized();
    return conn.prepare("SELECT COUNT(*) AS c FROM commit_log").get().c || 0;
  }

  countRecallEvents() {
    const conn = this.ensureInitialized();
    return conn.prepare("SELECT COUNT(*) AS c FROM recall_events").get().c || 0;
  }

  countStaging() {
    const conn = this.ensureInitialized();
    return conn.prepare("SELECT COUNT(*) AS c FROM staging_candidates").get().c || 0;
  }

  listRecords(params = {}) {
    const conn = this.ensureInitialized();
    const limit = Math.max(1, Math.min(200, Math.floor(Number(params.limit) || 20)));
    const searchStatus = this.normalizeSearchStatus(params.status) || "active";
    const scope = this.normalizeText(params.scope);
    const sessionId = this.normalizeText(params.sessionId);
    const memoryType = this.normalizeText(params.type).toLowerCase();

    const clauses = [];
    const values = [];
    if (scope) {
      clauses.push("scope = ?");
      values.push(scope);
    }
    if (sessionId) {
      clauses.push("session_id = ?");
      values.push(sessionId);
    }
    if (memoryType) {
      clauses.push("type = ?");
      values.push(memoryType);
    }
    if (searchStatus !== "all") {
      clauses.push("status = ?");
      values.push(searchStatus);
    }
    if (searchStatus === "active") {
      clauses.push("(expires_at IS NULL OR expires_at > ?)");
      values.push(Date.now());
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = conn
      .prepare(
        `SELECT id, scope, type, status, title, summary, session_id, source_path,
                index_status, created_at, updated_at, last_used_at, expires_at, expired_at
           FROM memory_records
           ${whereClause}
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(...values, limit);

    return rows.map((row) => ({
      id: row.id,
      scope: row.scope,
      type: row.type,
      status: row.status,
      title: row.title,
      summary: row.summary,
      sessionId: row.session_id || "",
      sourcePath: row.source_path || "",
      indexStatus: row.index_status || "",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      expiredAt: row.expired_at,
    }));
  }

  recordRecallEvent(params) {
    const conn = this.ensureInitialized();
    const ids = Array.isArray(params.selectedIds)
      ? params.selectedIds.map((value) => this.normalizeText(value)).filter(Boolean)
      : [];
    conn
      .prepare(
        `INSERT INTO recall_events (
           id, session_id, query_text, query_scope, injected_level, injected_chars, selected_ids_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.randomUUID(),
        this.normalizeText(params.sessionId) || null,
        this.normalizeText(params.queryText),
        this.normalizeText(params.queryScope) || null,
        this.normalizeText(params.level) || "L1",
        Math.max(0, Math.floor(Number(params.injectedChars) || 0)),
        this.asJson(ids, []),
        Date.now(),
      );
  }
}

module.exports = {
  StoreQueryManager,
};
