"use strict";

class ConsistencyManager {
  constructor(deps) {
    this.deps = deps;
  }

  getRecordRows(params = {}) {
    const conn = this.deps.ensureInitialized();
    const agentId = this.deps.resolveAgentId(params.agentId);
    const limit = Math.max(1, Math.min(500, Math.floor(Number(params.limit) || 50)));
    const searchStatus = this.deps.normalizeSearchStatus(params.status) || "all";
    const scope = this.deps.normalizeText(params.scope);
    const sessionId = this.deps.normalizeText(params.sessionId);
    const memoryType = this.deps.normalizeText(params.type).toLowerCase();

    const clauses = ["agent_id = ?"];
    const values = [agentId];
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

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return conn
      .prepare(
        `SELECT id, scope, type, status, title, summary, session_id, source_path,
                vector_backend, index_status, created_at, updated_at, expires_at, expired_at, agent_id
           FROM memory_records
           ${whereClause}
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(...values, limit);
  }

  buildJobStateMap(conn, recordIds, rawAgentId) {
    const ids = Array.isArray(recordIds) ? recordIds.filter(Boolean) : [];
    const out = new Map();
    if (ids.length === 0) {
      return out;
    }
    const agentId = this.deps.resolveAgentId(rawAgentId);
    const placeholders = ids.map(() => "?").join(", ");
    const rows = conn
      .prepare(
        `SELECT record_id,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_jobs,
                SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_jobs,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_jobs
           FROM index_jobs
          WHERE agent_id = ?
            AND record_id IN (${placeholders})
          GROUP BY record_id`,
      )
      .all(agentId, ...ids);
    for (const row of rows) {
      out.set(row.record_id, {
        pending: Number(row.pending_jobs) || 0,
        running: Number(row.running_jobs) || 0,
        failed: Number(row.failed_jobs) || 0,
      });
    }
    return out;
  }

  auditRecordConsistency(params = {}) {
    const conn = this.deps.ensureInitialized();
    const agentId = this.deps.resolveAgentId(params.agentId);
    const rows = this.getRecordRows(params);
    const recordIds = rows.map((row) => row.id);
    const jobStates = this.buildJobStateMap(conn, recordIds, agentId);
    const vectorInfo = this.deps.getVectorInfo();

    const ftsStmt = conn.prepare("SELECT 1 FROM memory_fts_docs WHERE id = ? LIMIT 1");
    const vectorStmt = conn.prepare("SELECT 1 FROM memory_vector_blobs WHERE record_id = ? LIMIT 1");
    const annStmt = conn.prepare("SELECT COUNT(*) AS total FROM memory_ann_buckets WHERE record_id = ?");

    const results = rows.map((row) => {
      const status = this.deps.normalizeText(row.status).toLowerCase();
      const indexStatus = this.deps.normalizeText(row.index_status).toLowerCase();
      const expectedBackend = this.deps.normalizeText(row.vector_backend).toLowerCase() || vectorInfo.backend;
      const ftsExists = Boolean(ftsStmt.get(row.id));
      const vectorExists = Boolean(vectorStmt.get(row.id));
      const annBuckets = Number((annStmt.get(row.id) || {}).total) || 0;
      const jobs = jobStates.get(row.id) || { pending: 0, running: 0, failed: 0 };
      const issues = [];

      if (indexStatus === "indexed") {
        if (!ftsExists) {
          issues.push("indexed-missing-fts");
        }
        if (expectedBackend === "sqlite-vec" && !vectorExists) {
          issues.push("indexed-missing-native-vector");
        }
        if (expectedBackend === "ann-local" && annBuckets <= 0) {
          issues.push("indexed-missing-ann-buckets");
        }
      }

      if (indexStatus === "pending" && jobs.pending <= 0 && jobs.running <= 0) {
        issues.push("pending-without-job");
      }

      if (indexStatus === "running" && jobs.running <= 0) {
        issues.push("running-without-job");
      }

      if ((status === "expired" || status === "forgotten") && (ftsExists || vectorExists || annBuckets > 0)) {
        issues.push("inactive-has-index-artifacts");
      }

      if ((status === "active" || status === "superseded") && indexStatus === "indexed" && !row.source_path) {
        issues.push("indexed-missing-archive-link");
      }

      return {
        id: row.id,
        agentId: row.agent_id || agentId,
        scope: row.scope,
        type: row.type,
        status,
        title: row.title,
        sessionId: row.session_id || "",
        sourcePath: row.source_path || "",
        vectorBackend: row.vector_backend || "",
        indexStatus,
        indexArtifacts: {
          fts: ftsExists,
          nativeVector: vectorExists,
          annBuckets,
        },
        jobs,
        issues,
      };
    });

    return {
      agentId,
      limit: Math.max(1, Math.min(500, Math.floor(Number(params.limit) || 50))),
      summary: {
        total: results.length,
        ok: results.filter((entry) => entry.issues.length === 0).length,
        issueCount: results.reduce((sum, entry) => sum + entry.issues.length, 0),
        affectedRecords: results.filter((entry) => entry.issues.length > 0).length,
      },
      results,
    };
  }

  auditOrphanIndexes(params = {}) {
    const conn = this.deps.ensureInitialized();
    const limit = Math.max(1, Math.min(5000, Math.floor(Number(params.limit) || 100)));
    const fts = conn
      .prepare(
        `SELECT f.id
           FROM memory_fts_docs f
           LEFT JOIN memory_records r ON r.id = f.id
          WHERE r.id IS NULL
          LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({ id: row.id }));

    const nativeVectors = conn
      .prepare(
        `SELECT v.record_id AS id
           FROM memory_vector_blobs v
           LEFT JOIN memory_records r ON r.id = v.record_id
          WHERE r.id IS NULL
          LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({ id: row.id }));

    const ann = conn
      .prepare(
        `SELECT a.record_id AS id, COUNT(*) AS bucketCount
           FROM memory_ann_buckets a
           LEFT JOIN memory_records r ON r.id = a.record_id
          WHERE r.id IS NULL
          GROUP BY a.record_id
          LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({
        id: row.id,
        bucketCount: Number(row.bucketCount) || 0,
      }));

    return {
      limit,
      summary: {
        fts: fts.length,
        nativeVectors: nativeVectors.length,
        ann: ann.length,
        total: fts.length + nativeVectors.length + ann.length,
      },
      fts,
      nativeVectors,
      ann,
    };
  }

  auditJobConsistency(params = {}) {
    const conn = this.deps.ensureInitialized();
    const agentId = this.deps.resolveAgentId(params.agentId);
    const limit = Math.max(1, Math.min(500, Math.floor(Number(params.limit) || 50)));
    const staleThreshold = Date.now() - Math.max(30000, this.deps.getIndexingPollMs() * 4);

    const missingRecord = conn
      .prepare(
        `SELECT id, record_id, status, job_type, backend, attempts, updated_at
           FROM index_jobs
          WHERE agent_id = ?
            AND record_id NOT IN (
              SELECT id
                FROM memory_records
               WHERE agent_id = ?
            )
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(agentId, agentId, limit)
      .map((row) => ({
        id: row.id,
        recordId: row.record_id,
        status: row.status,
        jobType: row.job_type,
        backend: row.backend,
        attempts: Number(row.attempts) || 0,
        updatedAt: row.updated_at,
      }));

    const staleRunning = conn
      .prepare(
        `SELECT id, record_id, status, job_type, backend, attempts, started_at, updated_at
           FROM index_jobs
          WHERE agent_id = ?
            AND status = 'running'
            AND started_at IS NOT NULL
            AND started_at <= ?
          ORDER BY started_at ASC
          LIMIT ?`,
      )
      .all(agentId, staleThreshold, limit)
      .map((row) => ({
        id: row.id,
        recordId: row.record_id,
        status: row.status,
        jobType: row.job_type,
        backend: row.backend,
        attempts: Number(row.attempts) || 0,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
      }));

    const failed = conn
      .prepare(
        `SELECT id, record_id, status, job_type, backend, attempts, last_error, updated_at
           FROM index_jobs
          WHERE agent_id = ?
            AND status = 'failed'
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(agentId, limit)
      .map((row) => ({
        id: row.id,
        recordId: row.record_id,
        status: row.status,
        jobType: row.job_type,
        backend: row.backend,
        attempts: Number(row.attempts) || 0,
        lastError: row.last_error || "",
        updatedAt: row.updated_at,
      }));

    const pendingWithoutRecord = conn
      .prepare(
        `SELECT COUNT(*) AS total
           FROM index_jobs
          WHERE agent_id = ?
            AND status IN ('pending', 'running')
            AND record_id NOT IN (
              SELECT id
                FROM memory_records
               WHERE agent_id = ?
            )`,
      )
      .get(agentId, agentId);

    return {
      agentId,
      limit,
      summary: {
        missingRecord: missingRecord.length,
        staleRunning: staleRunning.length,
        failed: failed.length,
        pendingWithoutRecord: Number((pendingWithoutRecord || {}).total) || 0,
      },
      missingRecord,
      staleRunning,
      failed,
    };
  }

  getConsistencyReport(params = {}) {
    const agentId = this.deps.resolveAgentId(params.agentId);
    const recordLimit = Math.max(1, Math.min(500, Math.floor(Number(params.recordLimit || params.limit) || 50)));
    const orphanLimit = Math.max(1, Math.min(5000, Math.floor(Number(params.orphanLimit || params.limit) || 100)));
    const jobLimit = Math.max(1, Math.min(500, Math.floor(Number(params.jobLimit || params.limit) || 50)));

    const records = this.auditRecordConsistency({
      agentId,
      scope: params.scope,
      sessionId: params.sessionId,
      type: params.type,
      status: this.deps.normalizeSearchStatus(params.status) || "all",
      limit: recordLimit,
    });
    const orphans = this.auditOrphanIndexes({
      limit: orphanLimit,
    });
    const jobs = this.auditJobConsistency({
      agentId,
      limit: jobLimit,
    });
    const archive = this.deps.getArchiveAuditReport({
      agentId,
      scope: params.scope,
      sessionId: params.sessionId,
      type: params.type,
      status: this.deps.normalizeSearchStatus(params.status) || "all",
      limit: Math.min(recordLimit, 50),
      recordLimit: Math.min(recordLimit, 50),
      orphanLimit: Math.min(orphanLimit, 100),
      quarantineLimit: Math.min(orphanLimit, 100),
      includeSessions: params.includeSessions === true,
    });

    return {
      generatedAt: Date.now(),
      filters: {
        agentId,
        scope: this.deps.normalizeText(params.scope),
        sessionId: this.deps.normalizeText(params.sessionId),
        type: this.deps.normalizeText(params.type),
        status: this.deps.normalizeSearchStatus(params.status) || "all",
        includeSessions: params.includeSessions === true,
      },
      summary: {
        auditedRecords: records.summary.total,
        recordIssues: records.summary.issueCount,
        affectedRecords: records.summary.affectedRecords,
        orphanIndexes: orphans.summary.total,
        missingRecordJobs: jobs.summary.missingRecord,
        staleRunningJobs: jobs.summary.staleRunning,
        failedJobs: jobs.summary.failed,
        archiveIssues: Number((archive.summary && archive.summary.linkedIssues) || 0),
        quarantinedFiles: Number((archive.summary && archive.summary.quarantinedFiles) || 0),
        annHealthLevel: this.deps.getVectorHealth(agentId).level || "unknown",
      },
      records,
      orphans,
      jobs,
      archive: {
        summary: archive.summary,
      },
      vectorHealth: this.deps.getVectorHealth(agentId),
    };
  }

  renderConsistencyReport(report, format = "json") {
    const normalizedFormat = this.deps.normalizeText(format).toLowerCase() === "markdown" ? "markdown" : "json";
    if (normalizedFormat === "json") {
      return JSON.stringify(report, null, 2);
    }

    const summary = report.summary || {};
    const filters = report.filters || {};
    const generatedAt = this.deps.formatTimestamp(report.generatedAt) || "(unknown)";
    const records = report.records || { summary: {}, results: [] };
    const orphans = report.orphans || { summary: {}, fts: [], nativeVectors: [], ann: [] };
    const jobs = report.jobs || { summary: {}, failed: [], staleRunning: [], missingRecord: [] };
    const vectorHealth = report.vectorHealth || null;

    const lines = [
      "# Consistency Report",
      "",
      `- Generated: ${generatedAt}`,
      `- Audited Records: ${summary.auditedRecords || 0}`,
      `- Record Issues: ${summary.recordIssues || 0}`,
      `- Affected Records: ${summary.affectedRecords || 0}`,
      `- Orphan Indexes: ${summary.orphanIndexes || 0}`,
      `- Missing Record Jobs: ${summary.missingRecordJobs || 0}`,
      `- Stale Running Jobs: ${summary.staleRunningJobs || 0}`,
      `- Failed Jobs: ${summary.failedJobs || 0}`,
      `- Archive Issues: ${summary.archiveIssues || 0}`,
      `- Quarantined Files: ${summary.quarantinedFiles || 0}`,
      `- ANN Health: ${summary.annHealthLevel || "unknown"}`,
      "",
      "## Filters",
      "",
      `- Agent: ${filters.agentId || "(default)"}`,
      `- Scope: ${filters.scope || "(all)"}`,
      `- Session: ${filters.sessionId || "(all)"}`,
      `- Type: ${filters.type || "(all)"}`,
      `- Status: ${filters.status || "all"}`,
      `- Include Sessions: ${filters.includeSessions === true ? "yes" : "no"}`,
      "",
      "## Record Consistency",
      "",
      `- Total: ${records.summary.total || 0}`,
      `- OK: ${records.summary.ok || 0}`,
      `- Affected Records: ${records.summary.affectedRecords || 0}`,
      `- Issue Count: ${records.summary.issueCount || 0}`,
      "",
      "## Orphan Indexes",
      "",
      `- FTS: ${orphans.summary.fts || 0}`,
      `- Native Vector: ${orphans.summary.nativeVectors || 0}`,
      `- ANN Buckets: ${orphans.summary.ann || 0}`,
      "",
      "## Index Jobs",
      "",
      `- Missing Record Jobs: ${jobs.summary.missingRecord || 0}`,
      `- Stale Running Jobs: ${jobs.summary.staleRunning || 0}`,
      `- Failed Jobs: ${jobs.summary.failed || 0}`,
    ];

    if (vectorHealth) {
      lines.push("");
      lines.push("## ANN Health");
      lines.push("");
      lines.push(`- Level: ${vectorHealth.level || "unknown"}`);
      lines.push(`- Score: ${vectorHealth.score == null ? "(n/a)" : vectorHealth.score}`);
      if (vectorHealth.tuning) {
        lines.push(`- Probe Action: ${vectorHealth.tuning.action || "keep"}`);
        lines.push(
          `- Probe: ${vectorHealth.tuning.currentProbePerBand} -> ${vectorHealth.tuning.recommendedProbePerBand}`,
        );
        lines.push(`- Reason: ${vectorHealth.tuning.reason || "(none)"}`);
      }
    }

    const recordIssues = Array.isArray(records.results)
      ? records.results.filter((entry) => Array.isArray(entry.issues) && entry.issues.length > 0).slice(0, 10)
      : [];
    if (recordIssues.length > 0) {
      lines.push("");
      lines.push("## Sample Record Issues");
      lines.push("");
      for (const entry of recordIssues) {
        lines.push(`- ${entry.id} [${entry.type}/${entry.status}] -> ${entry.issues.join(", ")}`);
      }
    }

    if (Array.isArray(jobs.failed) && jobs.failed.length > 0) {
      lines.push("");
      lines.push("## Failed Job Samples");
      lines.push("");
      for (const entry of jobs.failed.slice(0, 10)) {
        lines.push(`- ${entry.id} (${entry.recordId || "missing"}) -> ${entry.lastError || "(no error)"}`);
      }
    }

    return `${lines.join("\n")}\n`;
  }

  repairConsistency(params = {}) {
    const conn = this.deps.ensureInitialized();
    const agentId = this.deps.resolveAgentId(params.agentId);
    const dryRun = params.dryRun === true;
    const retryFailed = params.retryFailed === true;
    const audit = this.getConsistencyReport({
      ...params,
      agentId,
    });
    const now = Date.now();

    const recordsToRequeue = [];
    const recordsToClean = [];
    for (const entry of audit.records.results || []) {
      const issues = Array.isArray(entry.issues) ? entry.issues : [];
      if (
        issues.some((issue) =>
          [
            "indexed-missing-fts",
            "indexed-missing-native-vector",
            "indexed-missing-ann-buckets",
            "pending-without-job",
            "running-without-job",
          ].includes(issue),
        )
      ) {
        recordsToRequeue.push(entry);
      }
      if (issues.includes("inactive-has-index-artifacts")) {
        recordsToClean.push(entry);
      }
    }

    const orphanFtsIds = (audit.orphans.fts || []).map((entry) => this.deps.normalizeText(entry.id)).filter(Boolean);
    const orphanVectorIds = (audit.orphans.nativeVectors || [])
      .map((entry) => this.deps.normalizeText(entry.id))
      .filter(Boolean);
    const orphanAnnIds = (audit.orphans.ann || []).map((entry) => this.deps.normalizeText(entry.id)).filter(Boolean);

    const orphanJobIds = (audit.jobs.missingRecord || []).map((entry) => this.deps.normalizeText(entry.id)).filter(Boolean);
    const staleJobIds = (audit.jobs.staleRunning || []).map((entry) => this.deps.normalizeText(entry.id)).filter(Boolean);
    const failedJobIds =
      retryFailed
        ? (audit.jobs.failed || []).map((entry) => this.deps.normalizeText(entry.id)).filter(Boolean)
        : [];

    if (dryRun) {
      return {
        dryRun: true,
        agentId,
        retryFailed,
        summary: {
          requeueRecords: recordsToRequeue.length,
          cleanupInactiveRecords: recordsToClean.length,
          purgeOrphanFts: orphanFtsIds.length,
          purgeOrphanVectors: orphanVectorIds.length,
          purgeOrphanAnn: orphanAnnIds.length,
          dropMissingRecordJobs: orphanJobIds.length,
          resetStaleJobs: staleJobIds.length,
          retryFailedJobs: failedJobIds.length,
        },
        recordsToRequeue: recordsToRequeue.map((entry) => ({ id: entry.id, issues: entry.issues })),
        recordsToClean: recordsToClean.map((entry) => ({ id: entry.id, issues: entry.issues })),
      };
    }

    let requeued = 0;
    for (const entry of recordsToRequeue) {
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
          .get(agentId, entry.id) || null;

      conn
        .prepare(
          `UPDATE memory_records
              SET index_status = 'pending',
                  indexed_at = NULL,
                  updated_at = updated_at
            WHERE id = ?
              AND agent_id = ?`,
        )
        .run(entry.id, agentId);

      if (!pending) {
        this.deps.recordIndexJob({
          agentId,
          recordId: entry.id,
          jobType: "reindex",
          backend: this.deps.getVectorInfo().backend,
          status: "pending",
          payload: {
            reason: "consistency_repair",
            source: "consistency_report",
          },
        });
      }
      requeued += 1;
    }

    let cleanedInactive = 0;
    for (const entry of recordsToClean) {
      conn.prepare("DELETE FROM memory_fts_docs WHERE id = ?").run(entry.id);
      conn.prepare("DELETE FROM memory_vector_blobs WHERE record_id = ?").run(entry.id);
      conn.prepare("DELETE FROM memory_ann_buckets WHERE record_id = ?").run(entry.id);
      conn
        .prepare(
          `UPDATE memory_records
              SET index_status = CASE
                    WHEN status = 'expired' THEN 'expired'
                    WHEN status = 'forgotten' THEN 'forgotten'
                    ELSE index_status
                  END,
                  indexed_at = NULL,
                  updated_at = updated_at
            WHERE id = ?
              AND agent_id = ?`,
        )
        .run(entry.id, agentId);
      cleanedInactive += 1;
    }

    const deleteByIds = (table, column, ids) => {
      if (!Array.isArray(ids) || ids.length === 0) {
        return 0;
      }
      const placeholders = ids.map(() => "?").join(", ");
      const result = conn.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`).run(...ids);
      return Number(result && result.changes) || 0;
    };

    const deleteJobByIds = (ids) => {
      if (!Array.isArray(ids) || ids.length === 0) {
        return 0;
      }
      const placeholders = ids.map(() => "?").join(", ");
      const result = conn
        .prepare(`DELETE FROM index_jobs WHERE agent_id = ? AND id IN (${placeholders})`)
        .run(agentId, ...ids);
      return Number(result && result.changes) || 0;
    };

    const purgedOrphanFts = deleteByIds("memory_fts_docs", "id", orphanFtsIds);
    const purgedOrphanVectors = deleteByIds("memory_vector_blobs", "record_id", orphanVectorIds);
    const purgedOrphanAnn = deleteByIds("memory_ann_buckets", "record_id", orphanAnnIds);
    const droppedMissingRecordJobs = deleteJobByIds(orphanJobIds);

    let resetStaleJobs = 0;
    if (staleJobIds.length > 0) {
      const placeholders = staleJobIds.map(() => "?").join(", ");
      const result = conn
        .prepare(
          `UPDATE index_jobs
              SET status = 'pending',
                  available_at = ?,
                  started_at = NULL,
                  updated_at = ?
            WHERE agent_id = ?
              AND id IN (${placeholders})`,
        )
        .run(now, now, agentId, ...staleJobIds);
      resetStaleJobs = Number(result && result.changes) || 0;
    }

    let retriedFailedJobs = 0;
    if (failedJobIds.length > 0) {
      const placeholders = failedJobIds.map(() => "?").join(", ");
      const result = conn
        .prepare(
          `UPDATE index_jobs
              SET status = 'pending',
                  available_at = ?,
                  started_at = NULL,
                  completed_at = NULL,
                  last_error = NULL,
                  updated_at = ?
            WHERE agent_id = ?
              AND id IN (${placeholders})`,
        )
        .run(now, now, agentId, ...failedJobIds);
      retriedFailedJobs = Number(result && result.changes) || 0;
    }

    return {
      dryRun: false,
      agentId,
      retryFailed,
      summary: {
        requeued,
        cleanedInactive,
        purgedOrphanFts,
        purgedOrphanVectors,
        purgedOrphanAnn,
        droppedMissingRecordJobs,
        resetStaleJobs,
        retriedFailedJobs,
      },
    };
  }
}

module.exports = {
  ConsistencyManager,
};
