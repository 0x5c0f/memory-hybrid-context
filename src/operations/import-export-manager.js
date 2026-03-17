"use strict";

class ImportExportManager {
  constructor(deps) {
    this.normalizeText = deps.normalizeText;
    this.normalizeSearchStatus = deps.normalizeSearchStatus;
    this.formatTimestamp = deps.formatTimestamp;
    this.listRecords = deps.listRecords;
    this.readRecordById = deps.readRecordById;
    this.readTextFile = deps.readTextFile;
    this.fs = deps.fs;
    this.buildLayerTexts = deps.buildLayerTexts;
    this.computeContentHash = deps.computeContentHash;
    this.buildEmbeddingSource = deps.buildEmbeddingSource;
    this.resolveRuntimeScopes = deps.resolveRuntimeScopes;
    this.insertRecord = deps.insertRecord;
    this.normalizeKeywords = deps.normalizeKeywords;
    this.resolveMergePlan = deps.resolveMergePlan;
  }

  exportRecords(params = {}) {
    const format = this.normalizeText(params.format).toLowerCase() === "markdown" ? "markdown" : "json";
    const includeArchive = params.includeArchive === true;
    const records = this.listRecords(params).map((record) => {
      if (format === "json") {
        return this.readRecordById(record.id, {
          touchLastUsed: false,
          includeArchive,
        }) || { ...record };
      }
      const entry = { ...record };
      if (includeArchive && entry.sourcePath && this.fs.existsSync(entry.sourcePath)) {
        entry.archiveText = this.readTextFile(entry.sourcePath);
      }
      return entry;
    });

    let text = "";
    if (format === "markdown") {
      const header = [
        "# Memory Export",
        "",
        `- Count: ${records.length}`,
        `- Status: ${this.normalizeSearchStatus(params.status) || "active"}`,
        `- Type: ${this.normalizeText(params.type) || "(all)"}`,
        `- Scope: ${this.normalizeText(params.scope) || "(all)"}`,
        `- Session: ${this.normalizeText(params.sessionId) || "(all)"}`,
        "",
      ];
      const sections = records.map((entry, index) => {
        const lines = [
          `## ${index + 1}. ${entry.title}`,
          "",
          `- ID: ${entry.id}`,
          `- Type: ${entry.type}`,
          `- Status: ${entry.status}`,
          `- Scope: ${entry.scope}`,
          `- Session: ${entry.sessionId || "(none)"}`,
          `- Index Status: ${entry.indexStatus || "(none)"}`,
          `- Created: ${this.formatTimestamp(entry.createdAt) || "(unknown)"}`,
          `- Updated: ${this.formatTimestamp(entry.updatedAt) || "(unknown)"}`,
        ];
        if (entry.expiresAt) {
          lines.push(`- Expires: ${this.formatTimestamp(entry.expiresAt)}`);
        }
        if (entry.expiredAt) {
          lines.push(`- Expired: ${this.formatTimestamp(entry.expiredAt)}`);
        }
        if (entry.sourcePath) {
          lines.push(`- Archive: ${entry.sourcePath}`);
        }
        lines.push("", "### Summary", "", entry.summary || "(empty)", "");
        if (includeArchive) {
          lines.push("### Archive Text", "");
          if (entry.archiveText) {
            lines.push("```markdown", entry.archiveText, "```", "");
          } else {
            lines.push("(archive missing)", "");
          }
        }
        return lines.join("\n");
      });
      text = header.concat(sections).join("\n");
    } else {
      text = JSON.stringify(
        {
          count: records.length,
          format,
          filters: {
            status: this.normalizeSearchStatus(params.status) || "active",
            type: this.normalizeText(params.type),
            scope: this.normalizeText(params.scope),
            sessionId: this.normalizeText(params.sessionId),
            limit: Math.max(1, Math.min(200, Math.floor(Number(params.limit) || 20))),
            includeArchive,
          },
          records,
        },
        null,
        2,
      );
    }

    return {
      count: records.length,
      format,
      includeArchive,
      records,
      text,
    };
  }

  importRecords(params = {}) {
    const format = this.normalizeText(params.format).toLowerCase() || "json";
    const dryRun = params.dryRun === true;
    if (format !== "json") {
      return {
        dryRun,
        format,
        imported: 0,
        created: 0,
        duplicated: 0,
        skipped: 0,
        errors: [{ reason: "unsupported-format", message: "当前仅支持 JSON 导入。" }],
        results: [],
      };
    }

    const rawPayload = String(params.payload || "").trim();
    if (!rawPayload) {
      return {
        dryRun,
        format,
        imported: 0,
        created: 0,
        duplicated: 0,
        skipped: 0,
        errors: [{ reason: "empty-payload", message: "导入内容为空。" }],
        results: [],
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(rawPayload);
    } catch (error) {
      return {
        dryRun,
        format,
        imported: 0,
        created: 0,
        duplicated: 0,
        skipped: 0,
        errors: [{ reason: "invalid-json", message: this.normalizeText(error && error.message) || "invalid json" }],
        results: [],
      };
    }

    let sourceRecords = [];
    if (Array.isArray(parsed)) {
      sourceRecords = parsed;
    } else if (parsed && Array.isArray(parsed.records)) {
      sourceRecords = parsed.records;
    }

    if (sourceRecords.length === 0) {
      return {
        dryRun,
        format,
        imported: 0,
        created: 0,
        duplicated: 0,
        skipped: 0,
        errors: [{ reason: "invalid-shape", message: "导入 JSON 中没有可用的 records 数组。" }],
        results: [],
      };
    }

    const limit = Math.max(1, Math.min(200, Math.floor(Number(params.limit) || sourceRecords.length || 1)));
    const overrideScope = this.normalizeText(params.scope);
    const overrideSessionId = this.normalizeText(params.sessionId);
    const writeArchive = params.archive !== false;

    const results = [];
    const errors = [];
    let created = 0;
    let duplicated = 0;
    let skipped = 0;

    for (const entry of sourceRecords.slice(0, limit)) {
      const type = this.normalizeText(entry && entry.type).toLowerCase() || "other";
      const title = this.normalizeText(entry && entry.title);
      const summary = this.normalizeText(entry && entry.summary);
      const l0Text = this.normalizeText(entry && entry.l0Text) || title || summary;
      const l1Text = this.normalizeText(entry && entry.l1Text) || summary || l0Text;
      const l2Text =
        this.normalizeText(entry && entry.l2Text) ||
        this.normalizeText(entry && entry.rawText) ||
        this.normalizeText(entry && entry.archiveText) ||
        l1Text;

      if (!l0Text || !l1Text) {
        skipped += 1;
        errors.push({
          reason: "missing-fields",
          message: "记录缺少可导入的标题或摘要。",
          sourceId: this.normalizeText(entry && entry.id),
        });
        continue;
      }

      const resolvedScope = overrideScope || this.normalizeText(entry && entry.scope);
      const resolvedSessionId = overrideSessionId || this.normalizeText(entry && entry.sessionId);
      const keywords = this.normalizeKeywords(entry && entry.keywords);
      const scopes = resolvedScope ? [resolvedScope] : this.resolveRuntimeScopes("", type);
      const importParams = {
        title: l0Text,
        summary: l1Text,
        details: l2Text,
        l0Text,
        l1Text,
        l2Text,
        type,
        scope: resolvedScope,
        scopes,
        sessionId: resolvedSessionId,
        importance: Math.max(0, Math.min(1, Number(entry && entry.importance) || 0.7)),
        confidence: Math.max(0, Math.min(1, Number(entry && entry.confidence) || 0.8)),
        keywords,
        archive: writeArchive,
        expiresAt:
          entry && entry.expiresAt !== null && entry.expiresAt !== undefined && Number.isFinite(Number(entry.expiresAt))
            ? Number(entry.expiresAt)
            : null,
        candidateIds: Array.isArray(entry && entry.candidateIds) ? entry.candidateIds : [],
      };
      const layers = this.buildLayerTexts(importParams);
      const baseContentHash = this.computeContentHash(this.buildEmbeddingSource(importParams, layers));
      let result;
      if (dryRun) {
        const createdScopes = [];
        const reusedScopes = [];
        let previewSupersededCount = 0;
        let previewStrategy = "append";
        for (const targetScope of scopes) {
          const mergePlan = this.resolveMergePlan({ ...importParams, scope: targetScope }, layers, baseContentHash);
          if (mergePlan.duplicate) {
            reusedScopes.push({
              scope: targetScope,
              id: mergePlan.duplicate.id,
              title: mergePlan.duplicate.title,
            });
            previewStrategy = mergePlan.strategy || previewStrategy;
            continue;
          }
          previewSupersededCount += Array.isArray(mergePlan.supersedeIds) ? mergePlan.supersedeIds.length : 0;
          createdScopes.push({
            scope: targetScope,
            title: layers.l0,
            summary: layers.l1,
          });
          previewStrategy = mergePlan.strategy || previewStrategy;
        }
        result = {
          action: createdScopes.length > 0 ? "created" : reusedScopes.length > 0 ? "duplicate" : "noop",
          id: reusedScopes[0]?.id || null,
          title: layers.l0,
          summary: layers.l1,
          reused: reusedScopes,
          created: createdScopes,
          supersededCount: previewSupersededCount,
          mergeStrategy: previewStrategy,
        };
      } else {
        result = this.insertRecord(importParams);
      }

      if (result.action === "created") {
        created += Number(Array.isArray(result.created) ? result.created.length : 0);
      } else if (result.action === "duplicate") {
        duplicated += 1;
      } else {
        skipped += 1;
      }

      results.push({
        sourceId: this.normalizeText(entry && entry.id),
        action: result.action,
        importedId: dryRun ? null : result.id,
        title: result.title,
        type,
        scope: resolvedScope || (result.created && result.created[0] ? result.created[0].scope : ""),
        mergeStrategy: result.mergeStrategy || "",
        dryRun,
        supersededCount: Number(result.supersededCount) || 0,
      });
    }

    return {
      dryRun,
      format,
      imported: results.length,
      created,
      duplicated,
      skipped,
      errors,
      results,
    };
  }
}

module.exports = {
  ImportExportManager,
};
