"use strict";

const fs = require("node:fs");
const path = require("node:path");

class LifecycleManager {
  constructor(deps) {
    this.deps = deps;
  }

  deleteArchiveFile(sourcePath, agentId) {
    const normalized = this.deps.normalizeText(sourcePath);
    const archiveDir = this.deps.getArchiveDir(this.deps.resolveAgentId(agentId));
    if (!normalized || !archiveDir) {
      return false;
    }
    const archiveRoot = this.deps.stablePathKey(archiveDir);
    const safeArchiveRoot = `${archiveRoot}${path.sep}`;
    const resolved = this.deps.stablePathKey(normalized);
    if (!resolved) {
      return false;
    }
    if (resolved !== archiveRoot && !resolved.startsWith(safeArchiveRoot)) {
      return false;
    }
    if (!fs.existsSync(resolved)) {
      return false;
    }
    try {
      fs.unlinkSync(resolved);
      return true;
    } catch (_err) {
      return false;
    }
  }

  countExpiredRecords() {
    const conn = this.deps.ensureInitialized();
    const agentId = this.deps.resolveAgentId();
    return conn
      .prepare("SELECT COUNT(*) AS c FROM memory_records WHERE agent_id = ? AND status = 'expired'")
      .get(agentId).c || 0;
  }

  countForgottenRecords() {
    const conn = this.deps.ensureInitialized();
    const agentId = this.deps.resolveAgentId();
    return conn
      .prepare("SELECT COUNT(*) AS c FROM memory_records WHERE agent_id = ? AND status = 'forgotten'")
      .get(agentId).c || 0;
  }

  countPendingExpiry() {
    const conn = this.deps.ensureInitialized();
    const agentId = this.deps.resolveAgentId();
    return (
      conn
        .prepare(
          `SELECT COUNT(*) AS c
             FROM memory_records
            WHERE agent_id = ?
              AND status = 'active'
              AND expires_at IS NOT NULL
              AND expires_at <= ?`,
        )
        .get(agentId, Date.now()).c || 0
    );
  }

  countPurgeEligible() {
    const conn = this.deps.ensureInitialized();
    const retentionDays = Math.max(0, Math.floor(Number(this.deps.cfg.ttl.purgeAfterDays) || 0));
    if (retentionDays <= 0) {
      return 0;
    }
    const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    const agentId = this.deps.resolveAgentId();
    return (
      conn
        .prepare(
          `SELECT COUNT(*) AS c
             FROM memory_records
            WHERE agent_id = ?
              AND status = 'expired'
              AND COALESCE(expired_at, updated_at) <= ?`,
        )
        .get(agentId, cutoff).c || 0
    );
  }

  forgetRecords(params = {}) {
    const conn = this.deps.ensureInitialized();
    const agentId = this.deps.resolveAgentId(params.agentId);
    const requestedIds = Array.isArray(params.ids)
      ? params.ids.map((value) => this.deps.normalizeText(value)).filter(Boolean)
      : [];
    const sessionId = this.deps.normalizeText(params.sessionId);
    const scope = this.deps.normalizeText(params.scope);
    const memoryType = this.deps.normalizeText(params.type).toLowerCase();
    const limit = Math.max(1, Math.min(1000, Math.floor(Number(params.limit) || 100)));
    const dryRun = params.dryRun === true;

    if (requestedIds.length === 0 && !sessionId && !scope && !memoryType) {
      return {
        dryRun,
        matched: 0,
        forgotten: 0,
        jobsSkipped: 0,
        filters: {
          ids: requestedIds,
          sessionId,
          scope,
          type: memoryType,
          limit,
        },
        records: [],
      };
    }

    const clauses = ["agent_id = ?", "status = 'active'"];
    const values = [agentId];
    if (requestedIds.length > 0) {
      const placeholders = requestedIds.map(() => "?").join(", ");
      clauses.push(`id IN (${placeholders})`);
      values.push(...requestedIds);
    }
    if (sessionId) {
      clauses.push("session_id = ?");
      values.push(sessionId);
    }
    if (scope) {
      clauses.push("scope = ?");
      values.push(scope);
    }
    if (memoryType) {
      clauses.push("type = ?");
      values.push(memoryType);
    }

    const rows = conn
      .prepare(
        `SELECT id, scope, type, title, status, index_status, session_id
           FROM memory_records
          WHERE ${clauses.join(" AND ")}
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(...values, limit);

    const preview = rows.map((row) => ({
      id: row.id,
      scope: row.scope,
      type: row.type,
      title: row.title,
      status: row.status,
      indexStatus: row.index_status || "",
      sessionId: row.session_id || "",
    }));

    if (dryRun || rows.length === 0) {
      return {
        dryRun,
        matched: rows.length,
        forgotten: 0,
        jobsSkipped: 0,
        filters: {
          ids: requestedIds,
          sessionId,
          scope,
          type: memoryType,
          limit,
        },
        records: preview,
      };
    }

    const now = Date.now();
    let forgotten = 0;
    let jobsSkipped = 0;
    for (const row of rows) {
      conn.prepare("DELETE FROM memory_fts_docs WHERE id = ?").run(row.id);
      this.deps.vectorBackend.deleteNativeEmbedding(conn, row.id);

      const skipped = conn
        .prepare(
          `UPDATE index_jobs
              SET status = 'skipped',
                  completed_at = ?,
                  last_error = ?,
                  updated_at = ?
            WHERE record_id = ?
              AND agent_id = ?
              AND status IN ('pending', 'running')`,
        )
        .run(now, "record forgotten", now, row.id, agentId);
      jobsSkipped += Number(skipped && skipped.changes ? skipped.changes : 0);

      conn
        .prepare(
          `UPDATE memory_records
            SET status = 'forgotten',
                  index_status = 'forgotten',
                  updated_at = ?
            WHERE id = ?
              AND agent_id = ?`,
        )
        .run(now, row.id, agentId);
      forgotten += 1;
    }

    return {
      dryRun: false,
      matched: rows.length,
      forgotten,
      jobsSkipped,
      filters: {
        agentId,
        ids: requestedIds,
        sessionId,
        scope,
        type: memoryType,
        limit,
      },
      records: preview,
    };
  }

  cleanupExpiredRecords(params = {}) {
    const conn = this.deps.ensureInitialized();
    const agentId = this.deps.resolveAgentId(params.agentId);
    const now = Date.now();
    const limit = Math.max(1, Math.min(1000, Math.floor(Number(params.limit) || 100)));
    const dryRun = params.dryRun === true;
    const rows = conn
      .prepare(
        `SELECT id, scope, type, title, expires_at, index_status
           FROM memory_records
          WHERE agent_id = ?
            AND status = 'active'
            AND expires_at IS NOT NULL
            AND expires_at <= ?
          ORDER BY expires_at ASC
          LIMIT ?`,
      )
      .all(agentId, now, limit);

    const preview = rows.map((row) => ({
      id: row.id,
      scope: row.scope,
      type: row.type,
      title: row.title,
      expiresAt: row.expires_at,
      indexStatus: row.index_status || "",
    }));

    if (dryRun || rows.length === 0) {
      return {
        dryRun,
        matched: rows.length,
        cleaned: 0,
        jobsSkipped: 0,
        records: preview,
      };
    }

    let cleaned = 0;
    let jobsSkipped = 0;
    for (const row of rows) {
      conn.prepare("DELETE FROM memory_fts_docs WHERE id = ?").run(row.id);
      this.deps.vectorBackend.deleteNativeEmbedding(conn, row.id);

      const skipped = conn
        .prepare(
          `UPDATE index_jobs
              SET status = 'skipped',
                  completed_at = ?,
                  last_error = ?,
                  updated_at = ?
            WHERE record_id = ?
              AND agent_id = ?
              AND status IN ('pending', 'running')`,
        )
        .run(now, "record expired", now, row.id, agentId);

      jobsSkipped += Number(skipped && skipped.changes ? skipped.changes : 0);

      conn
        .prepare(
          `UPDATE memory_records
              SET status = 'expired',
                  index_status = 'expired',
                  expired_at = COALESCE(expired_at, ?),
                  updated_at = ?
            WHERE id = ?
              AND agent_id = ?`,
        )
        .run(now, now, row.id, agentId);
      cleaned += 1;
    }

    return {
      dryRun: false,
      matched: rows.length,
      cleaned,
      jobsSkipped,
      records: preview,
    };
  }

  purgeExpiredRecords(params = {}) {
    const conn = this.deps.ensureInitialized();
    const agentId = this.deps.resolveAgentId(params.agentId);
    const now = Date.now();
    const limit = Math.max(1, Math.min(1000, Math.floor(Number(params.limit) || 100)));
    const dryRun = params.dryRun === true;
    const requestedIds = Array.isArray(params.ids)
      ? params.ids.map((value) => this.deps.normalizeText(value)).filter(Boolean)
      : [];
    const sessionId = this.deps.normalizeText(params.sessionId);
    const scope = this.deps.normalizeText(params.scope);
    const memoryType = this.deps.normalizeText(params.type).toLowerCase();
    const forceAll = params.all === true;
    const overrideDays = Number.isFinite(Number(params.retentionDays))
      ? Math.max(0, Math.floor(Number(params.retentionDays)))
      : null;
    const retentionDays = overrideDays !== null
      ? overrideDays
      : Math.max(0, Math.floor(Number(this.deps.cfg.ttl.purgeAfterDays) || 0));
    const hasDirectFilters = requestedIds.length > 0 || Boolean(sessionId) || Boolean(scope) || Boolean(memoryType);

    if (!hasDirectFilters && !forceAll && retentionDays <= 0) {
      return {
        dryRun,
        matched: 0,
        purged: 0,
        deletedArchives: 0,
        retentionDays,
        filters: {
          ids: requestedIds,
          sessionId,
          scope,
          type: memoryType,
          limit,
        },
        records: [],
      };
    }

    const clauses = ["agent_id = ?"];
    const values = [agentId];
    if (hasDirectFilters) {
      if (requestedIds.length > 0) {
        const placeholders = requestedIds.map(() => "?").join(", ");
        clauses.push(`id IN (${placeholders})`);
        values.push(...requestedIds);
      }
      if (sessionId) {
        clauses.push("session_id = ?");
        values.push(sessionId);
      }
      if (scope) {
        clauses.push("scope = ?");
        values.push(scope);
      }
      if (memoryType) {
        clauses.push("type = ?");
        values.push(memoryType);
      }
    } else {
      clauses.push("status = 'expired'");
      if (!forceAll) {
        const cutoff = now - (retentionDays * 24 * 60 * 60 * 1000);
        clauses.push("COALESCE(expired_at, updated_at) <= ?");
        values.push(cutoff);
      }
    }

    const rows = conn
      .prepare(
        `SELECT id, scope, type, title, status, session_id, source_path, expires_at, expired_at, updated_at
           FROM memory_records
          WHERE ${clauses.join(" AND ")}
          ORDER BY COALESCE(expired_at, updated_at) ASC
          LIMIT ?`,
      )
      .all(...values, limit);

    const preview = rows.map((row) => ({
      id: row.id,
      scope: row.scope,
      type: row.type,
      title: row.title,
      status: row.status,
      sessionId: row.session_id || "",
      sourcePath: row.source_path || "",
      expiresAt: row.expires_at,
      expiredAt: row.expired_at,
      updatedAt: row.updated_at,
    }));

    if (dryRun || rows.length === 0) {
      return {
        dryRun,
        matched: rows.length,
        purged: 0,
        deletedArchives: 0,
        retentionDays,
        filters: {
          ids: requestedIds,
          sessionId,
          scope,
          type: memoryType,
          limit,
        },
        records: preview,
      };
    }

    let purged = 0;
    let deletedArchives = 0;

    for (const row of rows) {
      if (this.deleteArchiveFile(row.source_path, agentId)) {
        deletedArchives += 1;
      }

      conn.prepare("DELETE FROM memory_fts_docs WHERE id = ?").run(row.id);
      this.deps.vectorBackend.deleteNativeEmbedding(conn, row.id);
      conn.prepare("DELETE FROM memory_records WHERE id = ? AND agent_id = ?").run(row.id, agentId);
      purged += 1;
    }

    return {
      dryRun: false,
      matched: rows.length,
      purged,
      deletedArchives,
      retentionDays,
      filters: {
        agentId,
        ids: requestedIds,
        sessionId,
        scope,
        type: memoryType,
        limit,
      },
      records: preview,
    };
  }

  restoreExpiredRecords(params = {}) {
    const conn = this.deps.ensureInitialized();
    const agentId = this.deps.resolveAgentId(params.agentId);
    const requestedIds = Array.isArray(params.ids)
      ? params.ids.map((value) => this.deps.normalizeText(value)).filter(Boolean)
      : [];
    const sessionId = this.deps.normalizeText(params.sessionId);
    const scope = this.deps.normalizeText(params.scope);
    const memoryType = this.deps.normalizeText(params.type).toLowerCase();
    const limit = Math.max(1, Math.min(1000, Math.floor(Number(params.limit) || 20)));
    const clauses = ["agent_id = ?", "status = 'expired'"];
    const values = [agentId];
    if (requestedIds.length > 0) {
      const placeholders = requestedIds.map(() => "?").join(", ");
      clauses.push(`id IN (${placeholders})`);
      values.push(...requestedIds);
    }
    if (sessionId) {
      clauses.push("session_id = ?");
      values.push(sessionId);
    }
    if (scope) {
      clauses.push("scope = ?");
      values.push(scope);
    }
    if (memoryType) {
      clauses.push("type = ?");
      values.push(memoryType);
    }

    const rows = conn
      .prepare(
        `SELECT id, scope, type, title, session_id, source_path, expires_at, expired_at
           FROM memory_records
          WHERE ${clauses.join(" AND ")}
          ORDER BY COALESCE(expired_at, updated_at) DESC
          LIMIT ?`,
      )
      .all(...values, limit);

    if (rows.length === 0) {
      return {
        restored: 0,
        queued: 0,
        filters: {
          ids: requestedIds,
          sessionId,
          scope,
          type: memoryType,
          limit,
        },
        records: [],
      };
    }

    const vectorInfo = this.deps.vectorBackend.info();
    const now = Date.now();
    let restored = 0;
    let queued = 0;
    const records = [];

    for (const row of rows) {
      const renewedExpiresAt = this.deps.computeAutoExpiryForType(this.deps.cfg, row.type, now);
      conn
        .prepare(
          `UPDATE memory_records
              SET status = 'active',
                  index_status = 'pending',
                  indexed_at = NULL,
                  expires_at = ?,
                  expired_at = NULL,
                  updated_at = ?
            WHERE id = ?
              AND agent_id = ?`,
        )
        .run(renewedExpiresAt, now, row.id, agentId);
      restored += 1;

      const pending =
        conn
          .prepare(
            `SELECT 1
               FROM index_jobs
              WHERE agent_id = ?
                AND record_id = ?
                AND status IN ('pending', 'running')
              LIMIT 1`,
          )
          .get(agentId, row.id) || null;

      if (!pending) {
        this.deps.recordIndexJob({
          agentId,
          recordId: row.id,
          jobType: "restore",
          backend: vectorInfo.backend,
          status: this.deps.cfg.indexing.async !== false ? "pending" : "completed",
          payload: {
            reason: "restore",
            embeddingVersion: this.deps.cfg.store.vector.embeddingVersion,
          },
        });
        queued += 1;
      }

      records.push({
        id: row.id,
        scope: row.scope,
        type: row.type,
        title: row.title,
        sessionId: row.session_id || "",
        expiresAt: renewedExpiresAt,
        archiveMissing: row.source_path ? !fs.existsSync(row.source_path) : false,
      });
    }

    if (this.deps.cfg.indexing.async === false && queued > 0) {
      this.deps.processIndexJobs({ agentId, limit: queued, drain: true });
    }

    return {
      restored,
      queued,
      filters: {
        agentId,
        ids: requestedIds,
        sessionId,
        scope,
        type: memoryType,
        limit,
      },
      records,
    };
  }
}

module.exports = {
  LifecycleManager,
};
