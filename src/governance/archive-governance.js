"use strict";

const fs = require("node:fs");
const path = require("node:path");

class ArchiveGovernanceManager {
  constructor(deps) {
    this.deps = deps;
  }

  getArchiveDir() {
    return this.deps.getArchiveDir();
  }

  isManagedArchivePath(filePath) {
    const normalized = this.deps.normalizeText(filePath);
    const archiveDir = this.getArchiveDir();
    if (!normalized || !archiveDir) {
      return false;
    }
    const archiveRoot = this.deps.stablePathKey(archiveDir);
    const safeArchiveRoot = `${archiveRoot}${path.sep}`;
    const resolved = this.deps.stablePathKey(normalized);
    return Boolean(resolved && (resolved === archiveRoot || resolved.startsWith(safeArchiveRoot)));
  }

  buildArchiveContentFromRecord(record) {
    const timestamp = Number.isFinite(Number(record.createdAt)) ? Number(record.createdAt) : Date.now();
    const parts = this.deps.isoDateParts(timestamp);
    const keywords = Array.isArray(record.keywords) ? record.keywords : [];
    const lines = [
      `# Memory Commit: ${parts.date} ${parts.time} UTC`,
      "",
      `- **Scope**: ${record.scope}`,
      `- **Type**: ${record.type}`,
      `- **Importance**: ${record.importance}`,
      `- **Confidence**: ${record.confidence}`,
    ];
    if (record.sessionId) {
      lines.push(`- **Session ID**: ${record.sessionId}`);
    }
    lines.push("");
    lines.push("## L0");
    lines.push("");
    lines.push(record.l0Text || record.title || "");
    lines.push("");
    lines.push("## L1");
    lines.push("");
    lines.push(record.l1Text || record.summary || "");
    if (record.l2Text) {
      lines.push("");
      lines.push("## L2");
      lines.push("");
      lines.push(record.l2Text);
    }
    if (keywords.length > 0) {
      lines.push("");
      lines.push("## Keywords");
      lines.push("");
      for (const keyword of keywords) {
        lines.push(`- ${keyword}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  buildArchiveRepairPath(record) {
    const archiveDir = this.getArchiveDir();
    if (this.isManagedArchivePath(record.sourcePath)) {
      return this.deps.stablePathKey(record.sourcePath);
    }
    const timestamp = Number.isFinite(Number(record.createdAt)) ? Number(record.createdAt) : Date.now();
    const parts = this.deps.isoDateParts(timestamp);
    const slug = this.deps.slugify(record.l0Text || record.title || record.summary).slice(0, 48);
    const baseName = `${parts.date}-${slug}.md`;
    const primaryPath = path.join(archiveDir, baseName);
    if (!fs.existsSync(primaryPath)) {
      return primaryPath;
    }
    const fallbackName = `${parts.date}-${slug}-${String(record.id || "").slice(0, 8) || "repair"}.md`;
    return path.join(archiveDir, fallbackName);
  }

  listManagedArchiveFiles(params = {}) {
    const archiveDir = this.getArchiveDir();
    const limit = Math.max(1, Math.min(5000, Math.floor(Number(params.limit) || 200)));
    if (!archiveDir || !fs.existsSync(archiveDir)) {
      return {
        limit,
        scannedFiles: 0,
        files: [],
      };
    }

    const includeSessions = params.includeSessions === true;
    const skippedRoots = new Set(includeSessions ? ["quarantine"] : ["sessions", "quarantine"]);
    const results = [];
    const queue = [archiveDir];

    while (queue.length > 0 && results.length < limit) {
      const currentDir = queue.shift();
      let entries = [];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (results.length >= limit) {
          break;
        }
        const absolutePath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          const relativeDir = path.relative(archiveDir, absolutePath);
          const head = this.deps.normalizeText(relativeDir.split(path.sep)[0]).toLowerCase();
          if (currentDir === archiveDir && skippedRoots.has(head)) {
            continue;
          }
          queue.push(absolutePath);
          continue;
        }
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") {
          continue;
        }
        results.push({
          path: absolutePath,
          relativePath: path.relative(archiveDir, absolutePath),
          managed: this.isManagedArchivePath(absolutePath),
        });
      }
    }

    return {
      limit,
      scannedFiles: results.length,
      files: results,
    };
  }

  auditArchiveRecords(params = {}) {
    this.deps.ensureInitialized();
    const limit = Math.max(1, Math.min(500, Math.floor(Number(params.limit) || 50)));
    const records = this.deps.listRecords({
      scope: params.scope,
      sessionId: params.sessionId,
      type: params.type,
      status: this.deps.normalizeSearchStatus(params.status) || "all",
      limit,
    });
    const results = records.map((entry) => {
      const record = this.deps.readRecordById(entry.id, { touchLastUsed: false, includeArchive: false }) || entry;
      const hasSourcePath = Boolean(this.deps.normalizeText(record.sourcePath));
      const managed = this.isManagedArchivePath(record.sourcePath);
      const exists = hasSourcePath && fs.existsSync(record.sourcePath);
      let state = "ok";
      if (!hasSourcePath) {
        state = "missing-link";
      } else if (!managed) {
        state = "outside-root";
      } else if (!exists) {
        state = "missing-file";
      }
      return {
        id: record.id,
        scope: record.scope,
        type: record.type,
        status: record.status,
        title: record.title,
        sessionId: record.sessionId || "",
        sourcePath: record.sourcePath || "",
        managed,
        exists,
        state,
        contentRef: record.contentRef || "",
      };
    });

    const summary = {
      total: results.length,
      ok: results.filter((entry) => entry.state === "ok").length,
      missingLink: results.filter((entry) => entry.state === "missing-link").length,
      missingFile: results.filter((entry) => entry.state === "missing-file").length,
      outsideRoot: results.filter((entry) => entry.state === "outside-root").length,
    };

    return {
      limit,
      summary,
      results,
    };
  }

  repairArchiveRecords(params = {}) {
    const conn = this.deps.ensureInitialized();
    const dryRun = params.dryRun === true;
    const audit = this.auditArchiveRecords(params);
    const targets = audit.results.filter((entry) => entry.state !== "ok");

    if (dryRun || targets.length === 0) {
      return {
        dryRun,
        matched: targets.length,
        repaired: 0,
        records: targets,
      };
    }

    const now = Date.now();
    let repaired = 0;
    const records = [];
    for (const entry of targets) {
      const record = this.deps.readRecordById(entry.id, { touchLastUsed: false, includeArchive: false });
      if (!record) {
        continue;
      }
      const targetPath = this.buildArchiveRepairPath(record);
      const content = this.buildArchiveContentFromRecord(record);
      this.deps.writeTextFile(targetPath, content);

      conn
        .prepare(
          `UPDATE memory_records
              SET source_path = ?,
                  content_ref = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(targetPath, targetPath, now, record.id);

      repaired += 1;
      records.push({
        id: record.id,
        previousState: entry.state,
        repairedPath: targetPath,
      });
    }

    return {
      dryRun: false,
      matched: targets.length,
      repaired,
      records,
    };
  }

  auditOrphanArchiveFiles(params = {}) {
    const conn = this.deps.ensureInitialized();
    const scan = this.listManagedArchiveFiles(params);
    const referenced = new Set(
      conn
        .prepare(
          `SELECT source_path
             FROM memory_records
            WHERE source_path IS NOT NULL
              AND TRIM(source_path) <> ''`,
        )
        .all()
        .map((row) => this.deps.stablePathKey(row.source_path))
        .filter(Boolean),
    );

    const results = scan.files
      .filter((entry) => entry.managed && !referenced.has(this.deps.stablePathKey(entry.path)))
      .map((entry) => ({
        path: entry.path,
        relativePath: entry.relativePath,
        size: (() => {
          try {
            return fs.statSync(entry.path).size;
          } catch {
            return 0;
          }
        })(),
      }));

    return {
      limit: scan.limit,
      includeSessions: params.includeSessions === true,
      summary: {
        scannedFiles: scan.scannedFiles,
        orphaned: results.length,
      },
      results,
    };
  }

  buildArchiveQuarantinePath(filePath) {
    const archiveDir = this.getArchiveDir();
    const quarantineRoot = path.join(archiveDir, "quarantine");
    const relativePath = path.relative(archiveDir, filePath);
    const targetPath = path.join(quarantineRoot, relativePath);
    if (!fs.existsSync(targetPath)) {
      return targetPath;
    }
    const parsed = path.parse(targetPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(parsed.dir, `${parsed.name}-${stamp}${parsed.ext}`);
  }

  quarantineOrphanArchiveFiles(params = {}) {
    const dryRun = params.dryRun === true;
    const audit = this.auditOrphanArchiveFiles(params);
    const targets = audit.results;
    if (dryRun || targets.length === 0) {
      return {
        dryRun,
        matched: targets.length,
        moved: 0,
        results: targets.map((entry) => ({
          fromPath: entry.path,
          toPath: this.buildArchiveQuarantinePath(entry.path),
          size: entry.size,
        })),
      };
    }

    const movedResults = [];
    let moved = 0;
    for (const entry of targets) {
      if (!fs.existsSync(entry.path)) {
        continue;
      }
      const targetPath = this.buildArchiveQuarantinePath(entry.path);
      this.deps.ensureDir(path.dirname(targetPath));
      fs.renameSync(entry.path, targetPath);
      moved += 1;
      movedResults.push({
        fromPath: entry.path,
        toPath: targetPath,
        size: entry.size,
      });
    }

    return {
      dryRun: false,
      matched: targets.length,
      moved,
      results: movedResults,
    };
  }

  listQuarantinedArchiveFiles(params = {}) {
    this.deps.ensureInitialized();
    const limit = Math.max(1, Math.min(5000, Math.floor(Number(params.limit) || 200)));
    const archiveDir = this.getArchiveDir();
    const quarantineRoot = archiveDir ? path.join(archiveDir, "quarantine") : "";
    if (!quarantineRoot || !fs.existsSync(quarantineRoot)) {
      return {
        limit,
        count: 0,
        results: [],
      };
    }

    const results = [];
    const queue = [quarantineRoot];
    while (queue.length > 0 && results.length < limit) {
      const currentDir = queue.shift();
      let entries = [];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (results.length >= limit) {
          break;
        }
        const absolutePath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          queue.push(absolutePath);
          continue;
        }
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") {
          continue;
        }
        const relativePath = path.relative(quarantineRoot, absolutePath);
        let size = 0;
        try {
          size = fs.statSync(absolutePath).size;
        } catch {}
        results.push({
          path: absolutePath,
          relativePath,
          size,
        });
      }
    }

    return {
      limit,
      count: results.length,
      results,
    };
  }

  buildArchiveRestorePathFromQuarantine(filePath) {
    const archiveDir = this.getArchiveDir();
    const quarantineRoot = path.join(archiveDir, "quarantine");
    const relativePath = path.relative(quarantineRoot, filePath);
    const targetPath = path.join(archiveDir, relativePath);
    if (!fs.existsSync(targetPath)) {
      return targetPath;
    }
    const parsed = path.parse(targetPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(parsed.dir, `${parsed.name}-${stamp}${parsed.ext}`);
  }

  restoreQuarantinedArchiveFiles(params = {}) {
    const dryRun = params.dryRun === true;
    const listed = this.listQuarantinedArchiveFiles({ limit: params.limit });
    const requestedPaths = Array.isArray(params.paths)
      ? params.paths.map((value) => this.deps.normalizeText(value)).filter(Boolean)
      : [];
    const archiveDir = this.getArchiveDir();
    const quarantineRoot = archiveDir ? path.join(archiveDir, "quarantine") : "";
    const normalizedRequested = new Set(
      requestedPaths.map((value) => {
        if (!quarantineRoot) {
          return value;
        }
        const absolute = path.isAbsolute(value) ? value : path.join(quarantineRoot, value);
        return this.deps.stablePathKey(absolute);
      }),
    );
    const targets = normalizedRequested.size > 0
      ? listed.results.filter((entry) => normalizedRequested.has(this.deps.stablePathKey(entry.path)))
      : listed.results;

    if (dryRun || targets.length === 0) {
      return {
        dryRun,
        matched: targets.length,
        restored: 0,
        results: targets.map((entry) => ({
          fromPath: entry.path,
          toPath: this.buildArchiveRestorePathFromQuarantine(entry.path),
          size: entry.size,
        })),
      };
    }

    const results = [];
    let restored = 0;
    for (const entry of targets) {
      if (!fs.existsSync(entry.path)) {
        continue;
      }
      const targetPath = this.buildArchiveRestorePathFromQuarantine(entry.path);
      this.deps.ensureDir(path.dirname(targetPath));
      fs.renameSync(entry.path, targetPath);
      restored += 1;
      results.push({
        fromPath: entry.path,
        toPath: targetPath,
        size: entry.size,
      });
    }

    return {
      dryRun: false,
      matched: targets.length,
      restored,
      results,
    };
  }

  purgeQuarantinedArchiveFiles(params = {}) {
    const dryRun = params.dryRun === true;
    const listed = this.listQuarantinedArchiveFiles({ limit: params.limit });
    const requestedPaths = Array.isArray(params.paths)
      ? params.paths.map((value) => this.deps.normalizeText(value)).filter(Boolean)
      : [];
    const archiveDir = this.getArchiveDir();
    const quarantineRoot = archiveDir ? path.join(archiveDir, "quarantine") : "";
    const normalizedRequested = new Set(
      requestedPaths.map((value) => {
        if (!quarantineRoot) {
          return value;
        }
        const absolute = path.isAbsolute(value) ? value : path.join(quarantineRoot, value);
        return this.deps.stablePathKey(absolute);
      }),
    );
    const targets = normalizedRequested.size > 0
      ? listed.results.filter((entry) => normalizedRequested.has(this.deps.stablePathKey(entry.path)))
      : listed.results;

    if (dryRun || targets.length === 0) {
      return {
        dryRun,
        matched: targets.length,
        purged: 0,
        results: targets.map((entry) => ({
          path: entry.path,
          relativePath: entry.relativePath,
          size: entry.size,
        })),
      };
    }

    const results = [];
    let purged = 0;
    for (const entry of targets) {
      if (!fs.existsSync(entry.path)) {
        continue;
      }
      fs.unlinkSync(entry.path);
      purged += 1;
      results.push({
        path: entry.path,
        relativePath: entry.relativePath,
        size: entry.size,
      });
    }

    return {
      dryRun: false,
      matched: targets.length,
      purged,
      results,
    };
  }

  getArchiveAuditReport(params = {}) {
    const recordLimit = Math.max(1, Math.min(500, Math.floor(Number(params.recordLimit || params.limit) || 50)));
    const orphanLimit = Math.max(1, Math.min(5000, Math.floor(Number(params.orphanLimit || params.limit) || 200)));
    const quarantineLimit = Math.max(1, Math.min(5000, Math.floor(Number(params.quarantineLimit || params.limit) || 200)));

    const linked = this.auditArchiveRecords({
      scope: params.scope,
      sessionId: params.sessionId,
      type: params.type,
      status: this.deps.normalizeSearchStatus(params.status) || "all",
      limit: recordLimit,
    });
    const orphan = this.auditOrphanArchiveFiles({
      limit: orphanLimit,
      includeSessions: params.includeSessions === true,
    });
    const quarantine = this.listQuarantinedArchiveFiles({
      limit: quarantineLimit,
    });
    const vectorHealth =
      typeof this.deps.getVectorHealth === "function" ? this.deps.getVectorHealth() : null;

    return {
      generatedAt: Date.now(),
      filters: {
        scope: this.deps.normalizeText(params.scope),
        sessionId: this.deps.normalizeText(params.sessionId),
        type: this.deps.normalizeText(params.type),
        status: this.deps.normalizeSearchStatus(params.status) || "all",
        includeSessions: params.includeSessions === true,
      },
      summary: {
        linkedRecordsAudited: linked.summary.total,
        linkedIssues:
          linked.summary.missingLink +
          linked.summary.missingFile +
          linked.summary.outsideRoot,
        orphanedFiles: orphan.summary.orphaned,
        quarantinedFiles: quarantine.count,
        annHealthLevel: vectorHealth && vectorHealth.level ? vectorHealth.level : "unknown",
      },
      linked,
      orphan,
      quarantine,
      vectorHealth,
    };
  }

  renderArchiveAuditReport(report, format = "json") {
    const normalizedFormat = this.deps.normalizeText(format).toLowerCase() === "markdown" ? "markdown" : "json";
    if (normalizedFormat === "json") {
      return JSON.stringify(report, null, 2);
    }

    const generatedAt = this.deps.formatTimestamp(report.generatedAt) || "(unknown)";
    const filters = report.filters || {};
    const summary = report.summary || {};
    const linkedSummary = (report.linked && report.linked.summary) || {};
    const orphanSummary = (report.orphan && report.orphan.summary) || {};
    const quarantine = report.quarantine || { count: 0, results: [] };
    const vectorHealth = report.vectorHealth || null;
    const lines = [
      "# Archive Audit Report",
      "",
      `- Generated: ${generatedAt}`,
      `- Linked Records Audited: ${summary.linkedRecordsAudited || 0}`,
      `- Linked Issues: ${summary.linkedIssues || 0}`,
      `- Orphaned Files: ${summary.orphanedFiles || 0}`,
      `- Quarantined Files: ${summary.quarantinedFiles || 0}`,
      `- ANN Health: ${summary.annHealthLevel || "unknown"}`,
      "",
      "## Filters",
      "",
      `- Scope: ${filters.scope || "(all)"}`,
      `- Session: ${filters.sessionId || "(all)"}`,
      `- Type: ${filters.type || "(all)"}`,
      `- Status: ${filters.status || "all"}`,
      `- Include Sessions In Orphan Scan: ${filters.includeSessions === true ? "yes" : "no"}`,
      "",
      "## Linked Records",
      "",
      `- Total: ${linkedSummary.total || 0}`,
      `- OK: ${linkedSummary.ok || 0}`,
      `- Missing Link: ${linkedSummary.missingLink || 0}`,
      `- Missing File: ${linkedSummary.missingFile || 0}`,
      `- Outside Root: ${linkedSummary.outsideRoot || 0}`,
      "",
      "## Orphan Files",
      "",
      `- Scanned Files: ${orphanSummary.scannedFiles || 0}`,
      `- Orphaned Files: ${orphanSummary.orphaned || 0}`,
      "",
      "## Quarantine",
      "",
      `- Files: ${quarantine.count || 0}`,
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
      const metrics = vectorHealth.metrics || {};
      lines.push(`- Indexed Records: ${metrics.indexedRecords || 0}`);
      lines.push(`- Bucket Rows: ${metrics.bucketRows || 0}`);
      lines.push(`- Unique Buckets: ${metrics.uniqueBuckets || 0}`);
      lines.push(`- Avg Buckets / Record: ${metrics.avgBucketsPerRecord || 0}`);
      lines.push(`- Approx Query Buckets: ${metrics.approxQueryBuckets || 0}`);
      if (Array.isArray(vectorHealth.warnings) && vectorHealth.warnings.length > 0) {
        lines.push("");
        lines.push("### Warnings");
        lines.push("");
        for (const warning of vectorHealth.warnings) {
          lines.push(`- ${warning}`);
        }
      }
      if (Array.isArray(vectorHealth.suggestions) && vectorHealth.suggestions.length > 0) {
        lines.push("");
        lines.push("### Suggestions");
        lines.push("");
        for (const suggestion of vectorHealth.suggestions) {
          lines.push(`- ${suggestion}`);
        }
      }
    }

    if (Array.isArray(quarantine.results) && quarantine.results.length > 0) {
      lines.push("");
      for (const entry of quarantine.results) {
        lines.push(`- ${entry.relativePath || entry.path} (${entry.size || 0} bytes)`);
      }
    }

    return `${lines.join("\n")}\n`;
  }
}

module.exports = {
  ArchiveGovernanceManager,
};
