"use strict";

class IndexingManager {
  constructor(deps) {
    this.cfg = deps.cfg;
    this.ensureInitialized = deps.ensureInitialized;
    this.resolveAgentId = deps.resolveAgentId;
    this.normalizeText = deps.normalizeText;
    this.asJson = deps.asJson;
    this.parseJson = deps.parseJson;
    this.clipText = deps.clipText;
    this.computeContentHash = deps.computeContentHash;
    this.vectorBackend = deps.vectorBackend;
    this.randomUUID = deps.randomUUID;
    this.workerActive = false;
  }

  getIndexStats(params = {}) {
    const conn = this.ensureInitialized();
    const agentId = this.resolveAgentId(params.agentId);
    const rows = conn
      .prepare(
        `SELECT status, COUNT(*) AS c
           FROM index_jobs
          WHERE agent_id = ?
          GROUP BY status`,
      )
      .all(agentId);
    const stats = {
      total: 0,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    };
    for (const row of rows) {
      const status = this.normalizeText(row.status).toLowerCase();
      const count = Number(row.c) || 0;
      stats.total += count;
      if (status === "queued" || status === "pending") {
        stats.pending += count;
        continue;
      }
      if (status === "running") {
        stats.running += count;
        continue;
      }
      if (status === "failed") {
        stats.failed += count;
        continue;
      }
      if (status === "skipped") {
        stats.skipped += count;
        continue;
      }
      if (status === "completed") {
        stats.completed += count;
      }
    }
    return stats;
  }

  recordIndexJob(params) {
    const conn = this.ensureInitialized();
    const now = Date.now();
    const status = this.normalizeText(params.status).toLowerCase() || "completed";
    const jobId = this.randomUUID();
    const agentId = this.resolveAgentId(params.agentId);
    conn
      .prepare(
        `INSERT INTO index_jobs (
           id, agent_id, record_id, job_type, backend, status, attempts,
           available_at, started_at, completed_at, last_error, payload_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        jobId,
        agentId,
        params.recordId,
        this.normalizeText(params.jobType) || "upsert",
        this.normalizeText(params.backend) || this.vectorBackend.info().backend,
        status,
        Math.max(0, Math.floor(Number(params.attempts) || (status === "pending" ? 0 : 1))),
        params.availableAt || now,
        params.startedAt || (status === "pending" ? null : now),
        params.completedAt || (status === "completed" || status === "skipped" ? now : null),
        this.normalizeText(params.error) || null,
        this.asJson(params.payload || {}, {}),
        now,
        now,
      );

    if (status === "failed" && params.error) {
      conn
        .prepare(
        `INSERT INTO index_failures (
             id, agent_id, job_id, record_id, backend, error_message, payload_json, failed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.randomUUID(),
          agentId,
          jobId,
          params.recordId,
          this.normalizeText(params.backend) || this.vectorBackend.info().backend,
          this.normalizeText(params.error),
          this.asJson(params.payload || {}, {}),
          now,
        );
    }

    return jobId;
  }

  claimIndexJobs(limit, rawAgentId) {
    const conn = this.ensureInitialized();
    const now = Date.now();
    const agentId = this.resolveAgentId(rawAgentId);
    const staleThreshold = now - Math.max(30000, this.cfg.indexing.pollMs * 4);

    conn
      .prepare(
        `UPDATE index_jobs
            SET status = 'pending',
                available_at = ?,
                updated_at = ?
          WHERE status = 'running'
            AND agent_id = ?
            AND started_at IS NOT NULL
            AND started_at <= ?`,
      )
      .run(now, now, agentId, staleThreshold);

    const rows = conn
      .prepare(
        `SELECT id, record_id, job_type, backend, status, attempts, payload_json
           FROM index_jobs
          WHERE agent_id = ?
            AND status = 'pending'
            AND (available_at IS NULL OR available_at <= ?)
          ORDER BY updated_at ASC
          LIMIT ?`,
      )
      .all(agentId, now, Math.max(1, Math.floor(Number(limit) || 1)));

    const claimed = [];
    for (const row of rows) {
      const updated = conn
        .prepare(
          `UPDATE index_jobs
              SET status = 'running',
                  attempts = attempts + 1,
                  started_at = ?,
                  updated_at = ?
            WHERE id = ?
              AND agent_id = ?
              AND status = 'pending'`,
        )
        .run(now, now, row.id, agentId);
      if (!updated || !updated.changes) {
        continue;
      }
      conn
        .prepare(
          `UPDATE memory_records
              SET index_status = 'running',
                  updated_at = updated_at
            WHERE id = ?
              AND agent_id = ?`,
        ).run(row.record_id, agentId);
      claimed.push({
        id: row.id,
        agentId,
        recordId: row.record_id,
        jobType: row.job_type,
        backend: row.backend,
        attempts: Number(row.attempts) + 1,
        payload: this.parseJson(row.payload_json, {}),
      });
    }
    return claimed;
  }

  listIndexJobs(params = {}) {
    const conn = this.ensureInitialized();
    const agentId = this.resolveAgentId(params.agentId);
    const limit = Math.max(1, Math.min(100, Math.floor(Number(params.limit) || 20)));
    const status = this.normalizeText(params.status).toLowerCase();
    const clauses = ["agent_id = ?"];
    const values = [agentId];
    if (status) {
      clauses.push("status = ?");
      values.push(status);
    }
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = conn
      .prepare(
        `SELECT id, record_id, job_type, backend, status, attempts,
                available_at, started_at, completed_at, last_error, updated_at, agent_id
           FROM index_jobs
           ${whereClause}
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(...values, limit);
    return rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id || agentId,
      recordId: row.record_id,
      jobType: row.job_type,
      backend: row.backend,
      status: row.status,
      attempts: row.attempts,
      availableAt: row.available_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      lastError: row.last_error || "",
      updatedAt: row.updated_at,
    }));
  }

  completeIndexJob(jobId, rawAgentId) {
    const conn = this.ensureInitialized();
    const now = Date.now();
    const agentId = this.resolveAgentId(rawAgentId);
    conn
      .prepare(
        `UPDATE index_jobs
            SET status = 'completed',
                completed_at = ?,
                last_error = NULL,
                updated_at = ?
          WHERE id = ?
            AND agent_id = ?`,
      )
      .run(now, now, jobId, agentId);
  }

  failIndexJob(job, error) {
    const conn = this.ensureInitialized();
    const now = Date.now();
    const message = this.clipText(
      this.normalizeText(error && error.message ? error.message : error),
      500,
    ) || "index job failed";
    const shouldRetry = job.attempts < this.cfg.indexing.retryLimit;
    const nextStatus = shouldRetry ? "pending" : "failed";
    const nextAvailableAt = shouldRetry ? now + Math.min(30000, job.attempts * 2000) : null;

    conn
      .prepare(
        `UPDATE index_jobs
            SET status = ?,
                available_at = ?,
                completed_at = CASE WHEN ? = 'failed' THEN ? ELSE completed_at END,
                last_error = ?,
                updated_at = ?
          WHERE id = ?
            AND agent_id = ?`,
      )
      .run(nextStatus, nextAvailableAt, nextStatus, now, message, now, job.id, job.agentId);

    conn
      .prepare(
        `UPDATE memory_records
            SET index_status = ?,
                updated_at = updated_at
          WHERE id = ?
            AND agent_id = ?`,
      )
      .run(shouldRetry ? "pending" : "failed", job.recordId, job.agentId);

    if (!shouldRetry) {
      conn
        .prepare(
          `INSERT INTO index_failures (
             id, agent_id, job_id, record_id, backend, error_message, payload_json, failed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.randomUUID(),
          job.agentId,
          job.id,
          job.recordId,
          this.normalizeText(job.backend) || this.vectorBackend.info().backend,
          message,
          this.asJson(job.payload || {}, {}),
          now,
        );
    }
  }

  retryIndexJobs(params = {}) {
    const conn = this.ensureInitialized();
    const now = Date.now();
    const agentId = this.resolveAgentId(params.agentId);
    const requestedIds = Array.isArray(params.ids)
      ? params.ids.map((value) => this.normalizeText(value)).filter(Boolean)
      : [];
    const limit = Math.max(1, Math.min(100, Math.floor(Number(params.limit) || 20)));

    let rows = [];
    if (requestedIds.length > 0) {
      const placeholders = requestedIds.map(() => "?").join(", ");
      rows = conn
        .prepare(
          `SELECT id, record_id
             FROM index_jobs
            WHERE agent_id = ?
              AND id IN (${placeholders})`,
        )
        .all(agentId, ...requestedIds);
    } else {
      rows = conn
        .prepare(
          `SELECT id, record_id
             FROM index_jobs
            WHERE agent_id = ?
              AND status = 'failed'
            ORDER BY updated_at DESC
            LIMIT ?`,
        )
        .all(agentId, limit);
    }

    let retried = 0;
    for (const row of rows) {
      const updated = conn
        .prepare(
          `UPDATE index_jobs
              SET status = 'pending',
                  available_at = ?,
                  started_at = NULL,
                  completed_at = NULL,
                  last_error = NULL,
                  updated_at = ?
            WHERE id = ?
              AND agent_id = ?`,
        )
        .run(now, now, row.id, agentId);
      if (!updated || !updated.changes) {
        continue;
      }
      conn
        .prepare(
          `UPDATE memory_records
              SET index_status = 'pending',
                  updated_at = updated_at
            WHERE id = ?
              AND agent_id = ?`,
        )
        .run(row.record_id, agentId);
      retried += 1;
    }

    return {
      agentId,
      retried,
    };
  }

  enqueueReindexJobs(params = {}) {
    const conn = this.ensureInitialized();
    const agentId = this.resolveAgentId(params.agentId);
    const limit = Math.max(1, Math.min(500, Math.floor(Number(params.limit) || 100)));
    const onlyMissingNative = params.onlyMissingNative === true;
    const vectorInfo = this.vectorBackend.info();

    const clauses = ["r.agent_id = ?", "r.status IN ('active', 'superseded')"];
    if (params.scope) {
      clauses.push("r.scope = ?");
    }
    if (params.type) {
      clauses.push("r.type = ?");
    }
    if (onlyMissingNative) {
      clauses.push("vb.record_id IS NULL");
    }

    const values = [agentId];
    if (params.scope) {
      values.push(this.normalizeText(params.scope));
    }
    if (params.type) {
      values.push(this.normalizeText(params.type));
    }

    const rows = conn
      .prepare(
        `SELECT r.id, r.scope, r.type
           FROM memory_records r
           LEFT JOIN memory_vector_blobs vb ON vb.record_id = r.id
          WHERE ${clauses.join(" AND ")}
          ORDER BY r.updated_at DESC
          LIMIT ?`,
      )
      .all(...values, limit);

    let queued = 0;
    for (const row of rows) {
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
      if (pending) {
        continue;
      }

      conn
        .prepare(
          `UPDATE memory_records
              SET index_status = 'pending',
                  indexed_at = NULL,
                  updated_at = updated_at
            WHERE id = ?
              AND agent_id = ?`,
        )
        .run(row.id, agentId);

      this.recordIndexJob({
        agentId,
        recordId: row.id,
        jobType: "reindex",
        backend: vectorInfo.backend,
        status: "pending",
        payload: {
          reason: onlyMissingNative ? "missing_native" : "manual_rebuild",
          scope: row.scope,
          type: row.type,
          embeddingVersion: this.cfg.store.vector.embeddingVersion,
        },
      });
      queued += 1;
    }

    return {
      agentId,
      queued,
      scanned: rows.length,
      onlyMissingNative,
    };
  }

  processIndexJobs(params = {}) {
    const conn = this.ensureInitialized();
    const agentId = this.resolveAgentId(params.agentId);
    if (this.workerActive) {
      return {
        agentId,
        claimed: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
      };
    }

    const limit = Math.max(1, Math.min(512, Math.floor(Number(params.limit) || this.cfg.indexing.batchSize || 1)));
    const batchSize = Math.max(1, Math.min(this.cfg.indexing.batchSize, limit));
    const drain = params.drain === true;
    const stats = {
      agentId,
      claimed: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    };

    this.workerActive = true;
    try {
      while (stats.claimed < limit) {
        const remaining = limit - stats.claimed;
        const claimedJobs = this.claimIndexJobs(Math.min(batchSize, remaining), agentId);
        if (claimedJobs.length === 0) {
          break;
        }
        stats.claimed += claimedJobs.length;

        for (const job of claimedJobs) {
          const row =
            conn
              .prepare(
                `SELECT id, status, expires_at, l0_text, l1_text, l2_text, summary, raw_text, keywords_json
                   FROM memory_records
                  WHERE id = ?
                    AND agent_id = ?
                  LIMIT 1`,
              )
              .get(job.recordId, agentId) || null;

          if (!row) {
            this.vectorBackend.deleteNativeEmbedding(conn, job.recordId);
            this.completeIndexJob(job.id, agentId);
            stats.skipped += 1;
            continue;
          }

          const rowExpired =
            row.expires_at !== null &&
            row.expires_at !== undefined &&
            Number.isFinite(Number(row.expires_at)) &&
            Number(row.expires_at) <= Date.now();
          const indexableStatus = row.status === "active" || row.status === "superseded";
          if (!indexableStatus || rowExpired) {
            conn.prepare("DELETE FROM memory_fts_docs WHERE id = ?").run(job.recordId);
            this.vectorBackend.deleteNativeEmbedding(conn, job.recordId);
            conn
              .prepare(
                `UPDATE memory_records
                    SET status = CASE WHEN ? THEN 'expired' ELSE status END,
                        index_status = ?,
                        updated_at = updated_at
                  WHERE id = ?
                    AND agent_id = ?`,
              )
              .run(rowExpired ? 1 : 0, rowExpired ? "expired" : "skipped", job.recordId, agentId);
            this.completeIndexJob(job.id, agentId);
            stats.skipped += 1;
            continue;
          }

          try {
            const keywords = this.parseJson(row.keywords_json, []);
            const embeddingSource = this.normalizeText(
              [
                row.l0_text,
                row.l1_text,
                row.l2_text,
                row.summary,
                row.raw_text,
                Array.isArray(keywords) ? keywords.join(" ") : "",
              ]
                .filter(Boolean)
                .join(" "),
            );
            const embeddingVector = this.vectorBackend.buildTextEmbedding(embeddingSource);
            const now = Date.now();

            conn.prepare("DELETE FROM memory_fts_docs WHERE id = ?").run(job.recordId);
            conn
              .prepare(
                `INSERT INTO memory_fts_docs (id, title, summary, raw_text, keywords)
                   VALUES (?, ?, ?, ?, ?)`,
              )
              .run(
                job.recordId,
                row.l0_text || row.summary || "",
                row.l1_text || row.summary || "",
                row.l2_text || row.raw_text || "",
                Array.isArray(keywords) ? keywords.join(" ") : "",
              );

            conn
              .prepare(
                `UPDATE memory_records
                    SET embedding_json = ?,
                        content_hash = ?,
                        embedding_version = ?,
                        vector_backend = ?,
                        index_status = ?,
                        indexed_at = ?,
                        updated_at = updated_at
                  WHERE id = ?
                    AND agent_id = ?`,
              )
              .run(
                this.asJson(embeddingVector, []),
                this.computeContentHash(embeddingSource) || row.id,
                this.cfg.store.vector.embeddingVersion,
                this.vectorBackend.info().backend,
                "indexed",
                now,
                job.recordId,
                agentId,
              );

            this.vectorBackend.upsertNativeEmbedding(conn, job.recordId, embeddingVector, now);

            this.completeIndexJob(job.id, agentId);
            stats.completed += 1;
          } catch (err) {
            this.failIndexJob(job, err);
            stats.failed += 1;
          }
        }

        if (!drain) {
          break;
        }
      }
    } finally {
      this.workerActive = false;
    }

    return stats;
  }
}

module.exports = {
  IndexingManager,
};
