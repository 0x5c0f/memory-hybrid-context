"use strict";

class RecordManager {
  constructor(deps) {
    this.cfg = deps.cfg;
    this.ensureInitialized = deps.ensureInitialized;
    this.normalizeText = deps.normalizeText;
    this.parseJson = deps.parseJson;
    this.asJson = deps.asJson;
    this.fs = deps.fs;
    this.readTextFile = deps.readTextFile;
    this.writeTextFile = deps.writeTextFile;
    this.randomUUID = deps.randomUUID;
    this.computeAutoExpiryForType = deps.computeAutoExpiryForType;
    this.buildLayerTexts = deps.buildLayerTexts;
    this.buildEmbeddingSource = deps.buildEmbeddingSource;
    this.vectorBackend = deps.vectorBackend;
    this.computeContentHash = deps.computeContentHash;
    this.recordIndexJob = deps.recordIndexJob;
    this.getArchiveDir = deps.getArchiveDir;
    this.isoDateParts = deps.isoDateParts;
    this.slugify = deps.slugify;
    this.clipText = deps.clipText;
    this.stripLeadByType = deps.stripLeadByType;
    this.pickFirstClause = deps.pickFirstClause;
  }

  stripMergeLabels(text) {
    return this.normalizeText(text)
      .toLowerCase()
      .replace(
        /^(当前|最新)?\s*(决策|事件|待办|实体|偏好|档案|案例|decision|event|todo|entity|preference|profile|case)\s*[:：]\s*/u,
        "",
      )
      .replace(/^(待处理事项|用户偏好)\s*[:：]?\s*/u, "")
      .replace(/^(当前|目前|现在|刚刚|今天|刚才)\s*/u, "");
  }

  buildMergeComparable(text, memoryType) {
    const type = this.normalizeText(memoryType).toLowerCase();
    let value = this.stripMergeLabels(text);
    if (!value) {
      return "";
    }
    if (type === "decision" || type === "entity" || type === "event") {
      value = this.stripLeadByType(value, type);
    }
    value = value.replace(/[^\p{L}\p{N}]+/gu, "");
    return value;
  }

  buildMergeAnchor(text, memoryType) {
    const type = this.normalizeText(memoryType).toLowerCase();
    const raw = this.stripMergeLabels(text);
    if (!raw) {
      return "";
    }

    const normalized = this.stripLeadByType(raw, type) || raw;
    let anchor = normalized;

    if (type === "decision") {
      anchor = normalized.replace(/^(后续|继续|保持|保留|改为|改用|采用|使用|决定)\s*/u, "");
    } else if (type === "entity") {
      const match = normalized.match(/^(.{1,24}?)(?:是|为|有|使用|采用|叫做|地址|路径|版本|位于|在)\s*/u);
      anchor = match ? match[1] : normalized;
      anchor = anchor.replace(/^(这个|当前)?\s*(项目|仓库|服务|repo|project)\s*/u, "");
    } else if (type === "event") {
      const firstClause = this.pickFirstClause(normalized) || normalized;
      anchor = firstClause.replace(/^(当前|目前|现在|刚刚|今天|刚才)\s*/u, "");
    }

    return anchor.replace(/[^\p{L}\p{N}]+/gu, "");
  }

  listActiveMergeCandidates(params) {
    const conn = this.ensureInitialized();
    return conn
      .prepare(
        `SELECT id, title, summary, l0_text, l1_text, l2_text, content_hash, updated_at
           FROM memory_records
          WHERE scope = ?
            AND type = ?
            AND status = 'active'
          ORDER BY updated_at DESC
          LIMIT 12`,
      )
      .all(params.scope, params.type);
  }

  resolveMergePlan(params, layers, contentHash) {
    const type = this.normalizeText(params.type).toLowerCase();
    const candidates = this.listActiveMergeCandidates(params);
    const comparable = this.buildMergeComparable(layers.l1 || layers.l0 || params.summary, type);
    const anchor = this.buildMergeAnchor(layers.l2 || layers.l1 || layers.l0 || params.summary, type);

    for (const candidate of candidates) {
      if (contentHash && candidate.content_hash && candidate.content_hash === contentHash) {
        return {
          duplicate: candidate,
          supersedeIds: [],
          strategy: "content-hash-duplicate",
        };
      }
      if (candidate.summary === params.summary) {
        return {
          duplicate: candidate,
          supersedeIds: [],
          strategy: "summary-duplicate",
        };
      }
    }

    if ((type === "preference" || type === "profile") && candidates.length > 0) {
      return {
        duplicate: null,
        supersedeIds: [candidates[0].id],
        strategy: "latest-value-overwrite",
      };
    }

    if (type === "decision" && comparable && comparable.length >= 6) {
      for (const candidate of candidates) {
        const candidateComparable = this.buildMergeComparable(
          candidate.l1_text || candidate.summary || candidate.l0_text || candidate.title,
          type,
        );
        if (!candidateComparable) {
          continue;
        }
        if (
          candidateComparable === comparable ||
          candidateComparable.includes(comparable) ||
          comparable.includes(candidateComparable)
        ) {
          return {
            duplicate: null,
            supersedeIds: [candidate.id],
            strategy: `${type}-same-key-overwrite`,
          };
        }
      }
    }

    if (type === "entity" && anchor && anchor.length >= 3) {
      for (const candidate of candidates) {
        const candidateAnchor = this.buildMergeAnchor(
          candidate.l2_text || candidate.l1_text || candidate.summary || candidate.l0_text || candidate.title,
          type,
        );
        if (!candidateAnchor || candidateAnchor.length < 3) {
          continue;
        }
        if (candidateAnchor === anchor) {
          return {
            duplicate: null,
            supersedeIds: [candidate.id],
            strategy: "entity-anchor-overwrite",
          };
        }
      }
    }

    if (type === "event" && (comparable || anchor)) {
      const recentCutoff = Date.now() - (3 * 24 * 60 * 60 * 1000);
      for (const candidate of candidates) {
        const candidateComparable = this.buildMergeComparable(
          candidate.l1_text || candidate.summary || candidate.l0_text || candidate.title,
          type,
        );
        const candidateAnchor = this.buildMergeAnchor(
          candidate.l2_text || candidate.l1_text || candidate.summary || candidate.l0_text || candidate.title,
          type,
        );
        if (!candidateComparable && !candidateAnchor) {
          continue;
        }
        if (
          (
            (candidateComparable && comparable && candidateComparable === comparable) ||
            (candidateAnchor && anchor && candidateAnchor === anchor)
          ) &&
          Number(candidate.updated_at || 0) >= recentCutoff
        ) {
          return {
            duplicate: candidate,
            supersedeIds: [],
            strategy: "event-recent-duplicate",
          };
        }
      }
    }

    return {
      duplicate: null,
      supersedeIds: [],
      strategy: "append",
    };
  }

  applySupersedePlan(ids, now) {
    const conn = this.ensureInitialized();
    const targetIds = Array.isArray(ids) ? ids.map((value) => this.normalizeText(value)).filter(Boolean) : [];
    if (targetIds.length === 0) {
      return 0;
    }
    const placeholders = targetIds.map(() => "?").join(", ");
    const result = conn
      .prepare(
        `UPDATE memory_records
            SET status = 'superseded',
                updated_at = ?
          WHERE id IN (${placeholders})`,
      )
      .run(now, ...targetIds);
    return Number(result && result.changes ? result.changes : 0);
  }

  writeArchive(params) {
    if (!this.cfg.archive.enabled || !this.cfg.archive.writeMarkdown || params.archive === false) {
      return null;
    }

    const archiveDir = this.getArchiveDir();
    const layers = this.buildLayerTexts(params);
    const ts = Date.now();
    const parts = this.isoDateParts(ts);
    const slug = this.slugify(layers.l0 || params.title || params.summary).slice(0, 48);
    const fileName = `${parts.date}-${slug}.md`;
    const filePath = this.getArchiveDir() ? require("node:path").join(archiveDir, fileName) : fileName;
    const lines = [
      `# Memory Commit: ${parts.date} ${parts.time} UTC`,
      "",
      `- **Scope**: ${params.scope}`,
      `- **Type**: ${params.type}`,
      `- **Importance**: ${params.importance}`,
      `- **Confidence**: ${params.confidence}`,
    ];

    if (params.sessionId) {
      lines.push(`- **Session ID**: ${params.sessionId}`);
    }

    lines.push("");
    lines.push("## L0");
    lines.push("");
    lines.push(layers.l0);
    lines.push("");
    lines.push("## L1");
    lines.push("");
    lines.push(layers.l1);

    if (layers.l2) {
      lines.push("");
      lines.push("## L2");
      lines.push("");
      lines.push(layers.l2);
    }

    if (params.keywords.length > 0) {
      lines.push("");
      lines.push("## Keywords");
      lines.push("");
      for (const keyword of params.keywords) {
        lines.push(`- ${keyword}`);
      }
    }

    this.writeTextFile(filePath, `${lines.join("\n")}\n`);
    return filePath;
  }

  insertRecord(params) {
    const conn = this.ensureInitialized();
    const now = Date.now();
    const scopes = Array.isArray(params.scopes) && params.scopes.length > 0 ? params.scopes : [params.scope];
    const created = [];
    const reused = [];
    let supersededCount = 0;
    const layers = this.buildLayerTexts(params);
    const vectorInfo = this.vectorBackend.info();
    const asyncIndexing = this.cfg.indexing.async !== false;
    const baseEmbeddingSource = this.buildEmbeddingSource(params, layers);
    const baseContentHash = this.computeContentHash(baseEmbeddingSource);

    for (const targetScope of scopes) {
      const scopedParams = {
        ...params,
        scope: targetScope,
      };
      const mergePlan = this.resolveMergePlan(scopedParams, layers, baseContentHash);
      if (mergePlan.duplicate) {
        conn
          .prepare(
            `UPDATE memory_records
                SET updated_at = ?,
                    last_used_at = ?
              WHERE id = ?`,
          )
          .run(now, now, mergePlan.duplicate.id);
        reused.push({
          scope: targetScope,
          id: mergePlan.duplicate.id,
          title: mergePlan.duplicate.title,
          summary: mergePlan.duplicate.summary,
          mergeStrategy: mergePlan.strategy,
        });
        continue;
      }

      supersededCount += this.applySupersedePlan(mergePlan.supersedeIds, now);
      const archivePath = this.writeArchive(scopedParams);
      const recordId = this.randomUUID();
      const contentRef = archivePath || `inline:${recordId}`;
      const rawText = layers.l2;
      const contentHash = baseContentHash || recordId;
      const embeddingVector = asyncIndexing ? [] : this.vectorBackend.buildRecordEmbedding(scopedParams, layers);
      const embeddingJson = this.asJson(embeddingVector, []);
      const indexStatus = asyncIndexing ? "pending" : "indexed";
      const indexedAt = asyncIndexing ? null : now;
      const explicitExpiresAt =
        scopedParams.expiresAt !== null &&
        scopedParams.expiresAt !== undefined &&
        Number.isFinite(Number(scopedParams.expiresAt))
          ? Math.max(0, Math.floor(Number(scopedParams.expiresAt)))
          : null;
      const resolvedExpiresAt = explicitExpiresAt || this.computeAutoExpiryForType(this.cfg, scopedParams.type, now);
      conn
        .prepare(
          `INSERT INTO memory_records (
             id, scope, type, status, title, summary, l0_text, l1_text, l2_text, content_ref, raw_text,
             keywords_json, embedding_json, content_hash, embedding_version, vector_backend, index_status, indexed_at,
             importance, confidence,
             session_id, source_path, start_line, end_line,
             created_at, updated_at, last_used_at, expires_at
           ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          recordId,
          targetScope,
          scopedParams.type,
          layers.l0,
          layers.l1,
          layers.l0,
          layers.l1,
          layers.l2,
          contentRef,
          rawText,
          this.asJson(scopedParams.keywords, []),
          embeddingJson,
          contentHash,
          this.cfg.store.vector.embeddingVersion,
          vectorInfo.backend,
          indexStatus,
          indexedAt,
          scopedParams.importance,
          scopedParams.confidence,
          scopedParams.sessionId || null,
          archivePath,
          1,
          null,
          now,
          now,
          null,
          resolvedExpiresAt,
        );

      this.recordIndexJob({
        recordId,
        jobType: "upsert",
        backend: vectorInfo.backend,
        status: asyncIndexing ? "pending" : "completed",
        payload: {
          scope: targetScope,
          contentHash,
          embeddingVersion: this.cfg.store.vector.embeddingVersion,
        },
      });

      if (!asyncIndexing) {
        conn
          .prepare(
            `INSERT INTO memory_fts_docs (id, title, summary, raw_text, keywords)
               VALUES (?, ?, ?, ?, ?)`,
          )
          .run(recordId, layers.l0, layers.l1, layers.l2, scopedParams.keywords.join(" "));
        this.vectorBackend.upsertNativeEmbedding(conn, recordId, embeddingVector, now);
      }

      created.push({
        scope: targetScope,
        id: recordId,
        title: layers.l0,
        summary: layers.l1,
        l0Text: layers.l0,
        l1Text: layers.l1,
        l2Text: layers.l2,
        contentHash,
        indexStatus,
        archivePath,
        mergeStrategy: mergePlan.strategy,
      });
    }

    conn
      .prepare(
        `INSERT INTO commit_log (
           id, session_id, archive_path, candidate_count, inserted_count, superseded_count, committed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.randomUUID(),
        params.sessionId || "manual",
        created[0]?.archivePath || null,
        Array.isArray(params.candidateIds) ? params.candidateIds.length : 1,
        created.length,
        supersededCount,
        now,
      );

    if (created.length === 0 && reused.length > 0) {
      return {
        action: "duplicate",
        id: reused[0].id,
        title: reused[0].title,
        summary: reused[0].summary,
        archivePath: null,
        reused,
        created,
        supersededCount,
        mergeStrategy: reused[0]?.mergeStrategy || "duplicate",
      };
    }

    return {
      action: created.length > 0 ? "created" : "noop",
      id: created[0]?.id || null,
      title: created[0]?.title || params.title,
      summary: created[0]?.summary || params.summary,
      archivePath: created[0]?.archivePath || null,
      reused,
      created,
      supersededCount,
      mergeStrategy: created[0]?.mergeStrategy || "append",
    };
  }

  readRecordById(id, options = {}) {
    const conn = this.ensureInitialized();
    const row =
      conn
        .prepare(
          `SELECT id, scope, type, status, title, summary, l0_text, l1_text, l2_text, content_ref, raw_text,
                  keywords_json, content_hash, embedding_version, vector_backend, index_status, indexed_at,
                  importance, confidence, session_id, source_path,
                  created_at, updated_at, last_used_at, expires_at, expired_at
             FROM memory_records
            WHERE id = ?
            LIMIT 1`,
        )
        .get(id) || null;

    if (!row) {
      return null;
    }

    if (options.touchLastUsed !== false) {
      conn
        .prepare(
          `UPDATE memory_records
              SET last_used_at = ?,
                  updated_at = updated_at
            WHERE id = ?`,
        )
        .run(Date.now(), id);
    }

    let archiveText = "";
    if (options.includeArchive !== false && row.source_path && this.fs.existsSync(row.source_path)) {
      archiveText = this.readTextFile(row.source_path);
    }

    return {
      id: row.id,
      scope: row.scope,
      type: row.type,
      status: row.status,
      title: row.title,
      summary: row.summary,
      l0Text: row.l0_text || row.title,
      l1Text: row.l1_text || row.summary,
      l2Text: row.l2_text || row.raw_text || "",
      contentRef: row.content_ref,
      rawText: row.raw_text || "",
      keywords: this.parseJson(row.keywords_json, []),
      contentHash: row.content_hash || "",
      embeddingVersion: row.embedding_version || "",
      vectorBackend: row.vector_backend || "",
      indexStatus: row.index_status || "",
      indexedAt: row.indexed_at,
      importance: row.importance,
      confidence: row.confidence,
      sessionId: row.session_id,
      sourcePath: row.source_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      expiredAt: row.expired_at,
      archiveText,
    };
  }
}

module.exports = {
  RecordManager,
};
