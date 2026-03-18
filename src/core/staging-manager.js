"use strict";

class StagingManager {
  constructor(deps) {
    this.cfg = deps.cfg;
    this.ensureInitialized = deps.ensureInitialized;
    this.resolveAgentId = deps.resolveAgentId;
    this.normalizeText = deps.normalizeText;
    this.sanitizeIncomingMemoryText = deps.sanitizeIncomingMemoryText;
    this.shouldStageText = deps.shouldStageText;
    this.randomUUID = deps.randomUUID;
    this.detectCandidateType = deps.detectCandidateType;
    this.clipText = deps.clipText;
    this.resolveRuntimeScopes = deps.resolveRuntimeScopes;
    this.insertRecord = deps.insertRecord;
    this.makeTitle = deps.makeTitle;
    this.extractTextBlocksFromMessages = deps.extractTextBlocksFromMessages;
    this.selectRecentTextBlocks = deps.selectRecentTextBlocks;
    this.writeSessionArchiveSnapshot = deps.writeSessionArchiveSnapshot;
  }

  stageCandidates(params) {
    const conn = this.ensureInitialized();
    const agentId = this.resolveAgentId(params.agentId);
    const items = Array.isArray(params.items) ? params.items : [];
    let inserted = 0;
    let skipped = 0;
    const now = Date.now();
    const stmt = conn.prepare(
      `INSERT INTO staging_candidates (
         id, agent_id, session_id, role, raw_text, normalized_text, candidate_type,
         importance, confidence, source_message_ids_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const existsStmt = conn.prepare(
        `SELECT id
         FROM staging_candidates
        WHERE agent_id = ?
          AND session_id = ?
          AND normalized_text = ?
        LIMIT 1`,
    );

    for (const item of items) {
      const sourceText = this.normalizeText(item.text);
      const rawText = this.sanitizeIncomingMemoryText(sourceText);
      if (!this.shouldStageText(rawText)) {
        skipped += 1;
        continue;
      }

      const normalizedText = rawText.toLowerCase();
      const sessionId = this.normalizeText(params.sessionId) || "unknown";
      if (existsStmt.get(agentId, sessionId, normalizedText)) {
        skipped += 1;
        continue;
      }

      stmt.run(
        this.randomUUID(),
        agentId,
        sessionId,
        item.role || "user",
        rawText,
        normalizedText,
        this.detectCandidateType(rawText),
        0.6,
        0.7,
        "[]",
        now,
      );
      inserted += 1;
    }

    return { inserted, skipped };
  }

  listStagedCandidates(params) {
    const conn = this.ensureInitialized();
    const agentId = this.resolveAgentId(params.agentId);
    const limit = Math.max(1, Math.min(50, Math.floor(Number(params.limit) || 10)));
    const sessionId = this.normalizeText(params.sessionId);
    const filters = [];
    const values = [];
    if (sessionId) {
      filters.push("session_id = ?");
      values.push(sessionId);
    }
    filters.unshift("agent_id = ?");
    values.unshift(agentId);
    const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = conn
      .prepare(
        `SELECT id, session_id, role, raw_text, candidate_type, importance, confidence, created_at
                , agent_id
           FROM staging_candidates
           ${whereClause}
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(...values, limit);
    return rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id || agentId,
      sessionId: row.session_id,
      role: row.role,
      text: row.raw_text,
      type: row.candidate_type,
      importance: row.importance,
      confidence: row.confidence,
      createdAt: row.created_at,
    }));
  }

  dropStagedCandidates(params) {
    const conn = this.ensureInitialized();
    const agentId = this.resolveAgentId(params.agentId);
    const ids = Array.isArray(params.ids)
      ? params.ids.map((value) => this.normalizeText(value)).filter(Boolean)
      : [];
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(", ");
      const before =
        conn
          .prepare(`SELECT COUNT(*) AS c FROM staging_candidates WHERE agent_id = ? AND id IN (${placeholders})`)
          .get(agentId, ...ids).c || 0;
      conn.prepare(`DELETE FROM staging_candidates WHERE agent_id = ? AND id IN (${placeholders})`).run(agentId, ...ids);
      return before;
    }

    const sessionId = this.normalizeText(params.sessionId);
    if (sessionId) {
      const before =
        conn
          .prepare(`SELECT COUNT(*) AS c FROM staging_candidates WHERE agent_id = ? AND session_id = ?`)
          .get(agentId, sessionId).c || 0;
      conn.prepare(`DELETE FROM staging_candidates WHERE agent_id = ? AND session_id = ?`).run(agentId, sessionId);
      return before;
    }

    return 0;
  }

  commitStagedCandidates(params) {
    const conn = this.ensureInitialized();
    const agentId = this.resolveAgentId(params.agentId);
    const sessionId = this.normalizeText(params.sessionId) || "unknown";
    const limit = Math.max(1, Math.min(20, Math.floor(Number(params.limit) || 5)));
    const rows = conn
      .prepare(
        `SELECT id, raw_text, candidate_type, importance, confidence
           FROM staging_candidates
          WHERE agent_id = ?
            AND session_id = ?
          ORDER BY confidence DESC, importance DESC, created_at ASC
          LIMIT ?`,
      )
      .all(agentId, sessionId, limit);

    if (rows.length === 0) {
      return {
        action: "empty",
        sessionId,
        committed: 0,
        dropped: 0,
        records: [],
      };
    }

    const committed = [];
    const conservative = params.policy !== "aggressive";
    for (const row of rows) {
      if (conservative && row.confidence < 0.65 && row.importance < 0.65) {
        continue;
      }
      const summary = this.clipText(this.normalizeText(row.raw_text), 500);
      if (!summary) {
        continue;
      }
      const resolvedScopes = Array.isArray(params.scopes) && params.scopes.length > 0
        ? params.scopes
        : this.resolveRuntimeScopes("", row.candidate_type);
      const record = this.insertRecord({
        agentId,
        title: this.makeTitle(summary, ""),
        summary,
        details: summary,
        type: this.normalizeText(row.candidate_type) || "other",
        scope: resolvedScopes[0],
        scopes:
          Array.isArray(params.scopes) && params.scopes.length > 0
            ? resolvedScopes
            : (this.cfg.scopes.autoMirror ? resolvedScopes : [resolvedScopes[0]]),
        sessionId,
        importance: row.importance,
        confidence: row.confidence,
        keywords: [],
        archive: params.archive !== false,
        candidateIds: [row.id],
      });
      committed.push({
        candidateId: row.id,
        result: record,
      });
    }

    const committedIds = committed.map((entry) => entry.candidateId);
    const dropped = committedIds.length > 0 ? this.dropStagedCandidates({ agentId, ids: committedIds }) : 0;
    return {
      action: committed.length > 0 ? "committed" : "filtered",
      agentId,
      sessionId,
      committed: committed.length,
      dropped,
      records: committed,
    };
  }

  listIdleStageSessions(params = {}) {
    const conn = this.ensureInitialized();
    const agentId = this.resolveAgentId(params.agentId);
    const configuredIdleMinutes = Math.max(0, Math.floor(Number(this.cfg.commit.idleMinutes) || 0));
    const overrideIdleMinutes = Number.isFinite(Number(params.idleMinutes))
      ? Math.max(0, Math.floor(Number(params.idleMinutes)))
      : configuredIdleMinutes;
    const limit = Math.max(1, Math.min(1000, Math.floor(Number(params.limit) || 20)));
    if (overrideIdleMinutes <= 0) {
      return [];
    }

    const cutoff = Date.now() - (overrideIdleMinutes * 60 * 1000);
    const rows = conn
      .prepare(
        `SELECT session_id, COUNT(*) AS candidate_count, MAX(created_at) AS last_staged_at
           FROM staging_candidates
          WHERE agent_id = ?
          GROUP BY session_id
         HAVING MAX(created_at) <= ?
          ORDER BY last_staged_at ASC
          LIMIT ?`,
      )
      .all(agentId, cutoff, limit);

    return rows.map((row) => ({
      sessionId: row.session_id,
      agentId,
      candidateCount: Number(row.candidate_count) || 0,
      lastStagedAt: row.last_staged_at,
      idleMinutes: overrideIdleMinutes,
    }));
  }

  commitIdleSessions(params = {}) {
    const idleSessions = this.listIdleStageSessions(params);
    const agentId = this.resolveAgentId(params.agentId);
    if (idleSessions.length === 0) {
      return {
        agentId,
        idleMinutes: Number.isFinite(Number(params.idleMinutes))
          ? Math.max(0, Math.floor(Number(params.idleMinutes)))
          : Math.max(0, Math.floor(Number(this.cfg.commit.idleMinutes) || 0)),
        matchedSessions: 0,
        committedSessions: 0,
        committedRecords: 0,
        results: [],
      };
    }

    const results = [];
    let committedSessions = 0;
    let committedRecords = 0;
    for (const session of idleSessions) {
      const result = this.commitStagedCandidates({
        agentId,
        sessionId: session.sessionId,
        policy: this.normalizeText(params.policy) || "conservative",
        archive: params.archive !== false,
        limit: Math.max(5, this.cfg.capture.maxCandidatesPerTurn),
      });
      if (result.committed > 0) {
        committedSessions += 1;
        committedRecords += result.committed;
      }
      results.push({
        sessionId: session.sessionId,
        candidateCount: session.candidateCount,
        lastStagedAt: session.lastStagedAt,
        result,
      });
    }

    return {
      idleMinutes: idleSessions[0]?.idleMinutes || Math.max(0, Math.floor(Number(this.cfg.commit.idleMinutes) || 0)),
      matchedSessions: idleSessions.length,
      committedSessions,
      committedRecords,
      results,
    };
  }

  handleBeforeReset(params) {
    const agentId = this.resolveAgentId(params.agentId);
    const reason = this.normalizeText(params.reason) || "reset";
    if ((reason === "new" && this.cfg.commit.onNew === false) || (reason === "reset" && this.cfg.commit.onReset === false)) {
      return {
        action: "skipped",
        reason,
        agentId,
        sessionId: this.normalizeText(params.sessionId) || "unknown",
        staged: { inserted: 0, skipped: 0 },
        committed: { action: "skipped", committed: 0, dropped: 0, records: [] },
        archivePath: null,
      };
    }

    const sessionId = this.normalizeText(params.sessionId) || "unknown";
    const sourceBlocks = this.extractTextBlocksFromMessages(params.messages, this.cfg.capture.captureAssistant);
    const staged = sourceBlocks.length > 0
      ? this.stageCandidates({
          agentId,
          sessionId,
          items: this.selectRecentTextBlocks(sourceBlocks, Math.max(5, this.cfg.capture.maxCandidatesPerTurn * 5)),
        })
      : { inserted: 0, skipped: 0 };

    const archivePath = this.writeSessionArchiveSnapshot({
      sessionId,
      agentId,
      reason,
      sessionFile: this.normalizeText(params.sessionFile),
      messages: Array.isArray(params.messages) ? params.messages : [],
    });

    const committed = this.commitStagedCandidates({
      agentId,
      sessionId,
      policy: "conservative",
      archive: true,
      limit: Math.max(5, this.cfg.capture.maxCandidatesPerTurn),
    });

    return {
      action: committed.action,
      reason,
      sessionId,
      staged,
      committed,
      archivePath,
    };
  }
}

module.exports = {
  StagingManager,
};
