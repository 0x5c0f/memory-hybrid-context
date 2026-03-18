"use strict";

function registerMemoryTools({
  api,
  runtime,
  schemas,
  runCommit,
  clipText,
  normalizeSearchStatus,
  normalizeText,
}) {
  const {
    commitParamsSchema,
    searchParamsSchema,
    getParamsSchema,
    listParamsSchema,
    archiveRepairParamsSchema,
    archiveOrphanParamsSchema,
    archiveQuarantineListParamsSchema,
    archiveQuarantineRestoreParamsSchema,
    archiveQuarantinePurgeParamsSchema,
    archiveReportParamsSchema,
    consistencyReportParamsSchema,
    consistencyRepairParamsSchema,
    exportParamsSchema,
    importParamsSchema,
    stageListParamsSchema,
    idleParamsSchema,
    stageDropParamsSchema,
    restoreParamsSchema,
    forgetParamsSchema,
    emptyParamsSchema,
  } = schemas;

  const activateAgentContext = (params = {}) => {
    const agentId = runtime.resolveAgentId(params.agentId);
    runtime.setActiveAgentContext({
      agentId,
      sessionId: normalizeText(params.sessionId),
    });
    return agentId;
  };

  api.registerTool(
    {
      name: "memory_commit",
      label: "Memory Commit",
      description:
        "Commit a structured long-term memory entry into the layered dual-track memory store.",
      parameters: commitParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        return runCommit({
          ...(params || {}),
          agentId,
        });
      },
    },
    { name: "memory_commit" },
  );

  api.registerTool(
    {
      name: "memory_search",
      label: "Memory Search",
      description:
        "Search committed memories using the local structured store and FTS index.",
      parameters: searchParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const results = runtime.searchRecords({
          agentId,
          query: params.query,
          limit: params.limit,
          scopes: params.scope ? [normalizeText(params.scope)] : runtime.resolvePreferredScopes("", ""),
          type: normalizeText(params.type),
          status: normalizeSearchStatus(params.status),
        });

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "没有找到匹配的记忆。" }],
            details: { count: 0, results: [] },
          };
        }

        const lines = results.map(
          (entry, index) =>
            `${index + 1}. [${entry.type}/${entry.status}] ${entry.title} (${(entry.score * 100).toFixed(0)}%)`,
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            count: results.length,
            results,
          },
        };
      },
    },
    { name: "memory_search" },
  );

  api.registerTool(
    {
      name: "memory_get",
      label: "Memory Get",
      description:
        "Read a committed memory record, including archive content when available.",
      parameters: getParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const record = runtime.getRecordById(normalizeText(params.id), { agentId });
        if (!record) {
          return {
            content: [{ type: "text", text: "未找到对应的记忆记录。" }],
            details: { found: false },
          };
        }

        const preview = [
          `标题: ${record.title}`,
          `类型: ${record.type}`,
          `范围: ${record.scope}`,
          `摘要: ${record.summary}`,
        ];
        if (record.sourcePath) {
          preview.push(`归档: ${record.sourcePath}`);
        }

        return {
          content: [{ type: "text", text: preview.join("\n") }],
          details: record,
        };
      },
    },
    { name: "memory_get" },
  );

  api.registerTool(
    {
      name: "memory_list",
      label: "Memory List",
      description:
        "List committed memory records using governance-friendly filters without requiring a query string.",
      parameters: listParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const results = runtime.listRecords({
          agentId,
          scope: params.scope,
          sessionId: params.sessionId,
          type: params.type,
          status: normalizeSearchStatus(params.status),
          limit: params.limit,
        });
        return {
          content: [
            {
              type: "text",
              text:
                results.length === 0
                  ? "没有匹配的记忆记录。"
                  : results
                      .map((entry, index) => `${index + 1}. [${entry.type}/${entry.status}] ${entry.title}`)
                      .join("\n"),
            },
          ],
          details: {
            count: results.length,
            results,
          },
        };
      },
    },
    { name: "memory_list" },
  );

  api.registerTool(
    {
      name: "memory_archive_audit",
      label: "Memory Archive Audit",
      description:
        "Audit whether database-linked archive files exist and are stored under the managed archive root.",
      parameters: listParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const result = runtime.auditArchiveRecords({
          agentId,
          scope: params.scope,
          sessionId: params.sessionId,
          type: params.type,
          status: normalizeSearchStatus(params.status),
          limit: params.limit,
        });
        return {
          content: [
            {
              type: "text",
              text:
                result.results.length === 0
                  ? "没有匹配的记录可供校验。"
                  : `归档校验：ok=${result.summary.ok} missing-link=${result.summary.missingLink} missing-file=${result.summary.missingFile} outside-root=${result.summary.outsideRoot}`,
            },
          ],
          details: result,
        };
      },
    },
    { name: "memory_archive_audit" },
  );

  api.registerTool(
    {
      name: "memory_archive_repair",
      label: "Memory Archive Repair",
      description:
        "Repair missing or unmanaged archive links by regenerating archive files from stored records.",
      parameters: archiveRepairParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const result = runtime.repairArchiveRecords({
          agentId,
          scope: params.scope,
          sessionId: params.sessionId,
          type: params.type,
          status: normalizeSearchStatus(params.status),
          limit: params.limit,
          dryRun: params.dryRun === true,
        });
        return {
          content: [
            {
              type: "text",
              text:
                result.dryRun === true
                  ? `预演完成：发现 ${result.matched} 条待修复记录。`
                  : result.repaired > 0
                    ? `已修复 ${result.repaired} 条归档记录。`
                    : "没有需要修复的归档记录。",
            },
          ],
          details: result,
        };
      },
    },
    { name: "memory_archive_repair" },
  );

  api.registerTool(
    {
      name: "memory_archive_orphan_audit",
      label: "Memory Archive Orphan Audit",
      description:
        "Scan managed archive markdown files that are not linked by any memory record.",
      parameters: archiveOrphanParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const result = runtime.auditOrphanArchiveFiles({
          agentId,
          limit: params.limit,
          includeSessions: params.includeSessions === true,
        });
        return {
          content: [
            {
              type: "text",
              text:
                result.results.length === 0
                  ? "没有发现孤儿归档文件。"
                  : `孤儿归档扫描完成：scanned=${result.summary.scannedFiles} orphaned=${result.summary.orphaned}`,
            },
          ],
          details: result,
        };
      },
    },
    { name: "memory_archive_orphan_audit" },
  );

  api.registerTool(
    {
      name: "memory_archive_orphan_quarantine",
      label: "Memory Archive Orphan Quarantine",
      description:
        "Move orphan archive markdown files into the managed quarantine directory.",
      parameters: archiveOrphanParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const result = runtime.quarantineOrphanArchiveFiles({
          agentId,
          limit: params.limit,
          includeSessions: params.includeSessions === true,
          dryRun: params.dryRun === true,
        });
        return {
          content: [
            {
              type: "text",
              text:
                result.dryRun === true
                  ? `预演完成：发现 ${result.matched} 个待隔离的孤儿归档文件。`
                  : result.moved > 0
                    ? `已隔离 ${result.moved} 个孤儿归档文件。`
                    : "没有需要隔离的孤儿归档文件。",
            },
          ],
          details: result,
        };
      },
    },
    { name: "memory_archive_orphan_quarantine" },
  );

  api.registerTool(
    {
      name: "memory_archive_quarantine_list",
      label: "Memory Archive Quarantine List",
      description:
        "List markdown files currently stored in the managed archive quarantine directory.",
      parameters: archiveQuarantineListParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const result = runtime.listQuarantinedArchiveFiles({
          agentId,
          limit: params.limit,
        });
        return {
          content: [
            {
              type: "text",
              text:
                result.count === 0
                  ? "隔离区中没有归档文件。"
                  : `隔离区当前有 ${result.count} 个归档文件。`,
            },
          ],
          details: result,
        };
      },
    },
    { name: "memory_archive_quarantine_list" },
  );

  api.registerTool(
    {
      name: "memory_archive_quarantine_restore",
      label: "Memory Archive Quarantine Restore",
      description:
        "Restore quarantined archive markdown files back into the managed archive root.",
      parameters: archiveQuarantineRestoreParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const result = runtime.restoreQuarantinedArchiveFiles({
          agentId,
          limit: params.limit,
          paths: params.paths,
          dryRun: params.dryRun === true,
        });
        return {
          content: [
            {
              type: "text",
              text:
                result.dryRun === true
                  ? `预演完成：发现 ${result.matched} 个待恢复的隔离归档文件。`
                  : result.restored > 0
                    ? `已恢复 ${result.restored} 个隔离归档文件。`
                    : "没有需要恢复的隔离归档文件。",
            },
          ],
          details: result,
        };
      },
    },
    { name: "memory_archive_quarantine_restore" },
  );

  api.registerTool(
    {
      name: "memory_archive_quarantine_purge",
      label: "Memory Archive Quarantine Purge",
      description:
        "Permanently delete markdown files stored in the managed archive quarantine directory.",
      parameters: archiveQuarantinePurgeParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const result = runtime.purgeQuarantinedArchiveFiles({
          agentId,
          limit: params.limit,
          paths: params.paths,
          dryRun: params.dryRun === true,
        });
        return {
          content: [
            {
              type: "text",
              text:
                result.dryRun === true
                  ? `预演完成：发现 ${result.matched} 个待删除的隔离归档文件。`
                  : result.purged > 0
                    ? `已删除 ${result.purged} 个隔离归档文件。`
                    : "没有需要删除的隔离归档文件。",
            },
          ],
          details: result,
        };
      },
    },
    { name: "memory_archive_quarantine_purge" },
  );

  api.registerTool(
    {
      name: "memory_archive_report",
      label: "Memory Archive Report",
      description:
        "Generate a unified archive governance report combining linked archive issues, orphan files, and quarantine files.",
      parameters: archiveReportParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const result = runtime.getArchiveAuditReport({
          agentId,
          scope: params.scope,
          sessionId: params.sessionId,
          type: params.type,
          status: normalizeSearchStatus(params.status),
          limit: params.limit,
          recordLimit: params.recordLimit,
          orphanLimit: params.orphanLimit,
          quarantineLimit: params.quarantineLimit,
          includeSessions: params.includeSessions === true,
        });
        const rendered = runtime.renderArchiveAuditReport(result, params.format);
        return {
          content: [
            {
              type: "text",
              text: rendered,
            },
          ],
          details: result,
        };
      },
    },
    { name: "memory_archive_report" },
  );

  api.registerTool(
    {
      name: "memory_consistency_report",
      label: "Memory Consistency Report",
      description:
        "Generate a unified consistency audit across records, indexes, jobs, archive state, and ann-local health.",
      parameters: consistencyReportParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const result = runtime.getConsistencyReport({
          agentId,
          scope: params.scope,
          sessionId: params.sessionId,
          type: params.type,
          status: normalizeSearchStatus(params.status),
          limit: params.limit,
          recordLimit: params.recordLimit,
          orphanLimit: params.orphanLimit,
          jobLimit: params.jobLimit,
          includeSessions: params.includeSessions === true,
        });
        const rendered = runtime.renderConsistencyReport(result, params.format);
        return {
          content: [
            {
              type: "text",
              text: rendered,
            },
          ],
          details: result,
        };
      },
    },
    { name: "memory_consistency_report" },
  );

  api.registerTool(
    {
      name: "memory_consistency_repair",
      label: "Memory Consistency Repair",
      description:
        "Repair safe consistency issues by requeueing missing indexes, cleaning orphan index rows, and recovering stuck jobs.",
      parameters: consistencyRepairParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const result = runtime.repairConsistency({
          agentId,
          scope: params.scope,
          sessionId: params.sessionId,
          type: params.type,
          status: normalizeSearchStatus(params.status),
          limit: params.limit,
          recordLimit: params.recordLimit,
          orphanLimit: params.orphanLimit,
          jobLimit: params.jobLimit,
          includeSessions: params.includeSessions === true,
          dryRun: params.dryRun === true,
          retryFailed: params.retryFailed === true,
        });
        return {
          content: [
            {
              type: "text",
              text:
                result.dryRun === true
                  ? "一致性修复预演已完成。"
                  : "一致性修复已执行。",
            },
          ],
          details: result,
        };
      },
    },
    { name: "memory_consistency_repair" },
  );

  api.registerTool(
    {
      name: "memory_export",
      label: "Memory Export",
      description:
        "Export filtered memory records as JSON or Markdown for audit and migration.",
      parameters: exportParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const result = runtime.exportRecords({
          agentId,
          scope: params.scope,
          sessionId: params.sessionId,
          type: params.type,
          status: normalizeSearchStatus(params.status),
          limit: params.limit,
          format: params.format,
          includeArchive: params.includeArchive === true,
        });
        return {
          content: [{ type: "text", text: result.text }],
          details: {
            count: result.count,
            format: result.format,
            includeArchive: result.includeArchive,
            records: result.records,
          },
        };
      },
    },
    { name: "memory_export" },
  );

  api.registerTool(
    {
      name: "memory_import",
      label: "Memory Import",
      description:
        "Import memory records from exported JSON payloads using the current merge and indexing pipeline.",
      parameters: importParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const result = runtime.importRecords({
          agentId,
          payload: params.payload,
          format: params.format,
          limit: params.limit,
          scope: params.scope,
          sessionId: params.sessionId,
          archive: params.archive !== false,
          dryRun: params.dryRun === true,
        });
        return {
          content: [
            {
              type: "text",
              text:
                result.dryRun === true
                  ? `预演完成：将创建 ${result.created} 条，重复 ${result.duplicated} 条，跳过 ${result.skipped} 条。`
                  : result.created > 0
                    ? `已导入 ${result.created} 条记忆。`
                    : result.duplicated > 0
                      ? `检测到 ${result.duplicated} 条重复记忆，未新增。`
                      : "没有成功导入任何记忆。",
            },
          ],
          details: result,
        };
      },
    },
    { name: "memory_import" },
  );

  api.registerTool(
    {
      name: "memory_stage_list",
      label: "Memory Stage List",
      description: "List staged memory candidates before they are committed.",
      parameters: stageListParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const results = runtime.listStagedCandidates({
          agentId,
          sessionId: normalizeText(params.sessionId),
          limit: params.limit,
        });
        return {
          content: [
            {
              type: "text",
              text:
                results.length === 0
                  ? "暂存区为空。"
                  : results
                      .map((entry, index) => `${index + 1}. [${entry.type}] ${clipText(entry.text, 80)}`)
                      .join("\n"),
            },
          ],
          details: {
            count: results.length,
            results,
          },
        };
      },
    },
    { name: "memory_stage_list" },
  );

  api.registerTool(
    {
      name: "memory_idle_list",
      label: "Memory Idle List",
      description: "List staged sessions that are eligible for idle commit.",
      parameters: idleParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const results = runtime.listIdleStageSessions({
          agentId,
          idleMinutes: params.idleMinutes,
          limit: params.limit,
        });
        return {
          content: [
            {
              type: "text",
              text:
                results.length === 0
                  ? "当前没有达到 idle commit 条件的暂存会话。"
                  : results.map((entry, index) => `${index + 1}. ${entry.sessionId} (${entry.candidateCount} 条)`).join("\n"),
            },
          ],
          details: {
            count: results.length,
            results,
          },
        };
      },
    },
    { name: "memory_idle_list" },
  );

  api.registerTool(
    {
      name: "memory_idle_commit",
      label: "Memory Idle Commit",
      description: "Commit staged candidates for sessions that have been idle for long enough.",
      parameters: idleParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const result = runtime.commitIdleSessions({
          agentId,
          idleMinutes: params.idleMinutes,
          limit: params.limit,
        });
        return {
          content: [
            {
              type: "text",
              text:
                result.committedRecords > 0
                  ? `已通过 idle commit 提交 ${result.committedRecords} 条记忆。`
                  : "没有可通过 idle commit 提交的记忆。",
            },
          ],
          details: result,
        };
      },
    },
    { name: "memory_idle_commit" },
  );

  api.registerTool(
    {
      name: "memory_stage_drop",
      label: "Memory Stage Drop",
      description: "Delete staged memory candidates by ids or by session.",
      parameters: stageDropParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const removed = runtime.dropStagedCandidates({
          agentId,
          ids: Array.isArray(params.ids) ? params.ids : [],
          sessionId: normalizeText(params.sessionId),
        });
        return {
          content: [{ type: "text", text: `已删除 ${removed} 条暂存候选。` }],
          details: { removed },
        };
      },
    },
    { name: "memory_stage_drop" },
  );

  api.registerTool(
    {
      name: "memory_stats",
      label: "Memory Stats",
      description:
        "Show counts for committed records, staged candidates, and commit operations.",
      parameters: emptyParamsSchema,
      execute: async (_toolCallId, params = {}) => {
        const agentId = activateAgentContext(params || {});
        return ({
        content: [
          {
            type: "text",
            text: `records=${runtime.countRecords()} staging=${runtime.countStaging()} commits=${runtime.countCommits()} recalls=${runtime.countRecallEvents()} expired=${runtime.countExpiredRecords()} forgotten=${runtime.countForgottenRecords()} pendingExpiry=${runtime.countPendingExpiry()} purgeEligible=${runtime.countPurgeEligible()}`,
          },
        ],
        details: {
          records: runtime.countRecords(),
          staging: runtime.countStaging(),
          commits: runtime.countCommits(),
          recalls: runtime.countRecallEvents(),
          expiredRecords: runtime.countExpiredRecords(),
          forgottenRecords: runtime.countForgottenRecords(),
          pendingExpiry: runtime.countPendingExpiry(),
          purgeEligible: runtime.countPurgeEligible(),
          breakdown: runtime.getBreakdownSnapshot(),
          indexing: runtime.getIndexStats(),
          storePath: runtime.getStorePath(),
          archiveDir: runtime.getArchiveDir(agentId),
          vector: runtime.getVectorInfo(),
          vectorStats: runtime.getVectorStats({ agentId }),
          vectorHealth: runtime.getVectorHealth({ agentId }),
          policy: runtime.getPolicySnapshot(),
          currentProject: runtime.getCurrentProject(),
          activeProjectOverride: runtime.getProjectOverride(),
        },
      });
      },
    },
    { name: "memory_stats" },
  );

  api.registerTool(
    {
      name: "memory_forget",
      label: "Memory Forget",
      description:
        "Soft-delete active records from search and recall while keeping the main record for audit.",
      parameters: forgetParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const result = runtime.forgetRecords({
          agentId,
          ids: Array.isArray(params.ids) ? params.ids : [],
          sessionId: params.sessionId,
          scope: params.scope,
          type: params.type,
          limit: params.limit,
          dryRun: params.dryRun === true,
        });
        return {
          content: [
            {
              type: "text",
              text: result.forgotten > 0 ? `已软删除 ${result.forgotten} 条记忆。` : "没有可软删除的 active 记忆。",
            },
          ],
          details: result,
        };
      },
    },
    { name: "memory_forget" },
  );

  api.registerTool(
    {
      name: "memory_restore",
      label: "Memory Restore",
      description:
        "Restore expired records back to active state and queue them for reindexing.",
      parameters: restoreParamsSchema,
      execute: async (_toolCallId, params) => {
        const agentId = activateAgentContext(params || {});
        const result = runtime.restoreExpiredRecords({
          agentId,
          ids: Array.isArray(params.ids) ? params.ids : [],
          sessionId: params.sessionId,
          scope: params.scope,
          type: params.type,
          limit: params.limit,
        });
        return {
          content: [
            {
              type: "text",
              text: result.restored > 0 ? `已恢复 ${result.restored} 条过期记忆。` : "没有可恢复的过期记忆。",
            },
          ],
          details: result,
        };
      },
    },
    { name: "memory_restore" },
  );
}

module.exports = {
  registerMemoryTools,
};
