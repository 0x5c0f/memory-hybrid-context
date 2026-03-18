"use strict";

const { buildLegacyImportPayload } = require("../../scripts/legacy-session-memory-export");

function registerMemoryCli({
  api,
  runtime,
  runCommit,
  normalizeSearchStatus,
  normalizeText,
  expandHome,
  ensureDir,
  fs,
  path,
}) {
  api.registerCli(
    ({ program }) => {
      const group = program
        .command("mhm")
        .description("Memory Hybrid Context commands")
        .option("--agent-id <id>", "Agent isolation id (default from isolation.defaultAgentId)");

      group.hook("preAction", (_thisCommand, actionCommand) => {
        const options = actionCommand && typeof actionCommand.optsWithGlobals === "function"
          ? actionCommand.optsWithGlobals()
          : actionCommand.opts();
        const agentId = runtime.resolveAgentId(normalizeText(options && options.agentId));
        runtime.setActiveAgentContext({
          agentId,
          sessionId: normalizeText((options && (options.session || options.sessionId)) || ""),
        });
      });

      group
        .command("stats")
        .description("Show memory store statistics")
        .action(() => {
          runtime.ensureInitialized();
          console.log(
            JSON.stringify(
              {
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
                archiveDir: runtime.getArchiveDir(),
                vector: runtime.getVectorInfo(),
                vectorStats: runtime.getVectorStats(),
                vectorHealth: runtime.getVectorHealth(),
                policy: runtime.getPolicySnapshot(),
                currentProject: runtime.getCurrentProject(),
                activeProjectOverride: runtime.getProjectOverride(),
              },
              null,
              2,
            ),
          );
        });

      group
        .command("ann-stats")
        .description("Show detailed ann-local bucket statistics")
        .action(() => {
          runtime.ensureInitialized();
          console.log(
            JSON.stringify(
              {
                vector: runtime.getVectorInfo(),
                stats: runtime.getVectorStats(),
                health: runtime.getVectorHealth(),
              },
              null,
              2,
            ),
          );
        });

      group
        .command("ann-health")
        .description("Show ann-local health summary and warnings")
        .action(() => {
          runtime.ensureInitialized();
          console.log(JSON.stringify(runtime.getVectorHealth(), null, 2));
        });

      group
        .command("policy")
        .description("Show current routing and TTL policy")
        .action(() => {
          runtime.ensureInitialized();
          console.log(JSON.stringify(runtime.getPolicySnapshot(), null, 2));
        });

      group
        .command("routing")
        .description("Show explicit type routing and lifecycle rules")
        .action(() => {
          runtime.ensureInitialized();
          const rules = runtime.getTypeRoutingRules();
          console.log(JSON.stringify({ count: rules.length, rules }, null, 2));
        });

      group
        .command("breakdown")
        .description("Show record distribution by type and scope")
        .action(() => {
          runtime.ensureInitialized();
          const snapshot = runtime.getBreakdownSnapshot();
          console.log(
            JSON.stringify(
              {
                byTypeCount: snapshot.byType.length,
                byScopeCount: snapshot.byScope.length,
                ...snapshot,
              },
              null,
              2,
            ),
          );
        });

      group
        .command("idle-list")
        .description("List staged sessions eligible for idle commit")
        .option("--idle-minutes <n>", "Override idle threshold in minutes", (value) => Number(value))
        .option("--limit <n>", "Max sessions to show", (value) => Number(value))
        .action((options) => {
          runtime.ensureInitialized();
          const result = runtime.listIdleStageSessions({
            idleMinutes: options.idleMinutes,
            limit: options.limit,
          });
          console.log(JSON.stringify({ count: result.length, results: result }, null, 2));
        });

      group
        .command("idle-run")
        .description("Run idle commit once for eligible staged sessions")
        .option("--idle-minutes <n>", "Override idle threshold in minutes", (value) => Number(value))
        .option("--limit <n>", "Max sessions to process", (value) => Number(value))
        .action((options) => {
          runtime.ensureInitialized();
          const result = runtime.commitIdleSessions({
            idleMinutes: options.idleMinutes,
            limit: options.limit,
          });
          console.log(JSON.stringify(result, null, 2));
        });

      group
        .command("cleanup")
        .description("Expire and clean records whose TTL has passed")
        .option("--dry-run", "Preview records that would be expired")
        .option("--limit <n>", "Max records to process", (value) => Number(value))
        .action((options) => {
          runtime.ensureInitialized();
          const result = runtime.cleanupExpiredRecords({
            dryRun: options.dryRun === true,
            limit: options.limit,
          });
          console.log(JSON.stringify(result, null, 2));
        });

      group
        .command("forget")
        .description("Soft-delete active records by ids or filters")
        .option("--id <recordId...>", "Specific active record ids to soft-delete")
        .option("--session <sessionId>", "Only soft-delete records from one session")
        .option("--scope <scope>", "Only soft-delete records from one scope")
        .option("--type <type>", "Only soft-delete one memory type")
        .option("--limit <n>", "Max records to process", (value) => Number(value))
        .option("--dry-run", "Preview records that would be soft-deleted")
        .action((options) => {
          runtime.ensureInitialized();
          const result = runtime.forgetRecords({
            ids: Array.isArray(options.id) ? options.id : [],
            sessionId: options.session,
            scope: options.scope,
            type: options.type,
            limit: options.limit,
            dryRun: options.dryRun === true,
          });
          console.log(JSON.stringify(result, null, 2));
        });

      group
        .command("purge")
        .description("Permanently delete expired records after retention or delete records by filters")
        .option("--dry-run", "Preview records that would be purged")
        .option("--limit <n>", "Max records to process", (value) => Number(value))
        .option("--retention-days <n>", "Override retention days", (value) => Number(value))
        .option("--id <recordId...>", "Specific record ids to permanently delete")
        .option("--session <sessionId>", "Only permanently delete records from one session")
        .option("--scope <scope>", "Only permanently delete records from one scope")
        .option("--type <type>", "Only permanently delete one memory type")
        .option("--all", "Ignore retention and purge all expired records")
        .action((options) => {
          runtime.ensureInitialized();
          const result = runtime.purgeExpiredRecords({
            dryRun: options.dryRun === true,
            limit: options.limit,
            retentionDays: options.retentionDays,
            ids: Array.isArray(options.id) ? options.id : [],
            sessionId: options.session,
            scope: options.scope,
            type: options.type,
            all: options.all === true,
          });
          console.log(JSON.stringify(result, null, 2));
        });

      group
        .command("restore")
        .description("Restore expired records by ids or filters")
        .option("--id <recordId...>", "Specific expired record ids to restore")
        .option("--session <sessionId>", "Only restore records from one session")
        .option("--scope <scope>", "Only restore records from one scope")
        .option("--type <type>", "Only restore one memory type")
        .option("--limit <n>", "Max expired records to restore", (value) => Number(value))
        .action((options) => {
          runtime.ensureInitialized();
          const result = runtime.restoreExpiredRecords({
            ids: Array.isArray(options.id) ? options.id : [],
            sessionId: options.session,
            scope: options.scope,
            type: options.type,
            limit: options.limit,
          });
          console.log(JSON.stringify(result, null, 2));
        });

      group
        .command("index-run")
        .description("Process queued index jobs once")
        .option("--limit <n>", "Max jobs to process", (value) => Number(value))
        .option("--drain", "Keep processing until queue is empty or limit is reached")
        .action((options) => {
          runtime.ensureInitialized();
          const result = runtime.processIndexJobs({ limit: options.limit, drain: options.drain === true });
          console.log(JSON.stringify(result, null, 2));
        });

      group
        .command("index-list")
        .description("List recent index jobs")
        .option("--limit <n>", "Max jobs to show", (value) => Number(value))
        .option("--status <status>", "Filter by job status")
        .action((options) => {
          runtime.ensureInitialized();
          const result = runtime.listIndexJobs({
            limit: options.limit,
            status: options.status,
          });
          console.log(JSON.stringify({ count: result.length, jobs: result }, null, 2));
        });

      group
        .command("index-retry")
        .description("Retry failed index jobs")
        .option("--limit <n>", "Max failed jobs to retry", (value) => Number(value))
        .option("--id <jobId...>", "Specific failed job ids to retry")
        .action((options) => {
          runtime.ensureInitialized();
          const result = runtime.retryIndexJobs({
            limit: options.limit,
            ids: Array.isArray(options.id) ? options.id : [],
          });
          console.log(JSON.stringify(result, null, 2));
        });

      group
        .command("index-rebuild")
        .description("Queue records for reindexing")
        .option("--limit <n>", "Max records to enqueue", (value) => Number(value))
        .option("--scope <scope>", "Only rebuild one scope")
        .option("--type <type>", "Only rebuild one memory type")
        .option("--missing-native", "Only enqueue records missing native vector rows")
        .action((options) => {
          runtime.ensureInitialized();
          const result = runtime.enqueueReindexJobs({
            limit: options.limit,
            scope: options.scope,
            type: options.type,
            onlyMissingNative: options.missingNative === true,
          });
          console.log(JSON.stringify(result, null, 2));
        });

      group
        .command("commit")
        .description("Commit a memory entry or commit staged candidates")
        .argument("[summary]", "Summary text, omit with --source staging")
        .option("--title <text>", "Optional title")
        .option("--details <text>", "Optional details")
        .option("--l0 <text>", "Explicit L0 short title")
        .option("--l1 <text>", "Explicit L1 summary")
        .option("--l2 <text>", "Explicit L2 full text")
        .option("--type <type>", "Memory type", "other")
        .option("--scope <uri>", "Explicit scope URI")
        .option("--session <id>", "Session id for staged or linked records")
        .option("--source <mode>", "inline | staging | both", "inline")
        .option("--policy <mode>", "conservative | aggressive", "conservative")
        .option("--limit <n>", "Max staged candidates to commit", "5")
        .option("--no-archive", "Do not write markdown archive")
        .action(async (summary, opts) => {
          const result = await runCommit({
            title: opts.title,
            summary: summary || "",
            details: opts.details,
            l0Text: opts.l0,
            l1Text: opts.l1,
            l2Text: opts.l2,
            type: opts.type,
            scope: opts.scope,
            sessionId: opts.session,
            source: opts.source,
            policy: opts.policy,
            limit: Number(opts.limit),
            archive: opts.archive,
          });
          console.log(JSON.stringify(result, null, 2));
        });

      group
        .command("list")
        .description("List committed memory records without a search query")
        .option("--limit <n>", "Max records", "20")
        .option("--scope <scope>", "Only list one scope")
        .option("--session <sessionId>", "Only list one session")
        .option("--type <type>", "Only list one memory type")
        .option("--status <status>", "List one status: active|expired|forgotten|superseded|all")
        .action((opts) => {
          const results = runtime.listRecords({
            limit: Number(opts.limit),
            scope: opts.scope,
            sessionId: opts.session,
            type: opts.type,
            status: normalizeSearchStatus(opts.status),
          });
          console.log(JSON.stringify({ count: results.length, results }, null, 2));
        });

      group
        .command("archive-audit")
        .description("Audit record-linked archive files")
        .option("--limit <n>", "Max records", "50")
        .option("--scope <scope>", "Only audit one scope")
        .option("--session <sessionId>", "Only audit one session")
        .option("--type <type>", "Only audit one memory type")
        .option("--status <status>", "Audit one status: active|expired|forgotten|superseded|all")
        .action((opts) => {
          const result = runtime.auditArchiveRecords({
            limit: Number(opts.limit),
            scope: opts.scope,
            sessionId: opts.session,
            type: opts.type,
            status: normalizeSearchStatus(opts.status),
          });
          console.log(JSON.stringify(result, null, 2));
        });

      group
        .command("archive-repair")
        .description("Repair missing or unmanaged record-linked archive files")
        .option("--limit <n>", "Max records", "50")
        .option("--scope <scope>", "Only repair one scope")
        .option("--session <sessionId>", "Only repair one session")
        .option("--type <type>", "Only repair one memory type")
        .option("--status <status>", "Repair one status: active|expired|forgotten|superseded|all")
        .option("--dry-run", "Preview repairs without writing files")
        .action((opts) => {
          const result = runtime.repairArchiveRecords({
            limit: Number(opts.limit),
            scope: opts.scope,
            sessionId: opts.session,
            type: opts.type,
            status: normalizeSearchStatus(opts.status),
            dryRun: opts.dryRun === true,
          });
          console.log(JSON.stringify(result, null, 2));
        });

      group
        .command("archive-orphan-audit")
        .description("Scan managed archive markdown files that are not linked by any memory record")
        .option("--limit <n>", "Max files", "200")
        .option("--include-sessions", "Also scan archiveDir/sessions")
        .action((opts) => {
          const result = runtime.auditOrphanArchiveFiles({
            limit: Number(opts.limit),
            includeSessions: opts.includeSessions === true,
          });
          console.log(JSON.stringify(result, null, 2));
        });

      group
        .command("archive-orphan-quarantine")
        .description("Move orphan archive markdown files into archiveDir/quarantine")
        .option("--limit <n>", "Max files", "200")
        .option("--include-sessions", "Also quarantine orphan files from archiveDir/sessions")
        .option("--dry-run", "Preview quarantine operations without moving files")
        .action((opts) => {
          const result = runtime.quarantineOrphanArchiveFiles({
            limit: Number(opts.limit),
            includeSessions: opts.includeSessions === true,
            dryRun: opts.dryRun === true,
          });
          console.log(JSON.stringify(result, null, 2));
        });

      group
        .command("archive-quarantine-list")
        .description("List markdown files currently stored in archiveDir/quarantine")
        .option("--limit <n>", "Max files", "200")
        .action((opts) => {
          const result = runtime.listQuarantinedArchiveFiles({
            limit: Number(opts.limit),
          });
          console.log(JSON.stringify(result, null, 2));
        });

      group
        .command("archive-quarantine-restore")
        .description("Restore markdown files from archiveDir/quarantine back into the archive root")
        .option("--limit <n>", "Max files", "200")
        .option("--path <relativePath...>", "Only restore selected quarantine-relative file paths")
        .option("--dry-run", "Preview restore operations without moving files")
        .action((opts) => {
          const result = runtime.restoreQuarantinedArchiveFiles({
            limit: Number(opts.limit),
            paths: Array.isArray(opts.path) ? opts.path : opts.path ? [opts.path] : [],
            dryRun: opts.dryRun === true,
          });
          console.log(JSON.stringify(result, null, 2));
        });

      group
        .command("archive-quarantine-purge")
        .description("Permanently delete markdown files from archiveDir/quarantine")
        .option("--limit <n>", "Max files", "200")
        .option("--path <relativePath...>", "Only purge selected quarantine-relative file paths")
        .option("--dry-run", "Preview purge operations without deleting files")
        .action((opts) => {
          const result = runtime.purgeQuarantinedArchiveFiles({
            limit: Number(opts.limit),
            paths: Array.isArray(opts.path) ? opts.path : opts.path ? [opts.path] : [],
            dryRun: opts.dryRun === true,
          });
          console.log(JSON.stringify(result, null, 2));
        });

      group
        .command("archive-report")
        .description("Generate a unified archive governance report")
        .option("--limit <n>", "Shared default limit", "50")
        .option("--record-limit <n>", "Max linked records to audit")
        .option("--orphan-limit <n>", "Max archive files to scan for orphan detection")
        .option("--quarantine-limit <n>", "Max quarantined files to list")
        .option("--scope <scope>", "Only audit linked records from one scope")
        .option("--session <sessionId>", "Only audit linked records from one session")
        .option("--type <type>", "Only audit linked records for one memory type")
        .option("--status <status>", "Audit linked records with one status: active|expired|forgotten|superseded|all")
        .option("--include-sessions", "Also scan archiveDir/sessions for orphan detection")
        .option("--format <format>", "json | markdown", "json")
        .option("--output <path>", "Write report output to a file instead of stdout")
        .action((opts) => {
          const result = runtime.getArchiveAuditReport({
            limit: Number(opts.limit),
            recordLimit: opts.recordLimit ? Number(opts.recordLimit) : undefined,
            orphanLimit: opts.orphanLimit ? Number(opts.orphanLimit) : undefined,
            quarantineLimit: opts.quarantineLimit ? Number(opts.quarantineLimit) : undefined,
            scope: opts.scope,
            sessionId: opts.session,
            type: opts.type,
            status: normalizeSearchStatus(opts.status),
            includeSessions: opts.includeSessions === true,
          });
          const format = normalizeText(opts.format).toLowerCase() === "markdown" ? "markdown" : "json";
          const rendered = runtime.renderArchiveAuditReport(result, format);
          const outputPath = normalizeText(opts.output);
          if (outputPath) {
            const resolved = path.resolve(expandHome(outputPath));
            ensureDir(path.dirname(resolved));
            fs.writeFileSync(resolved, rendered, "utf8");
            console.log(
              JSON.stringify(
                {
                  format,
                  outputPath: resolved,
                  summary: result.summary,
                },
                null,
                2,
              ),
            );
            return;
          }
          console.log(rendered);
        });

      group
        .command("consistency-report")
        .description("Generate a unified consistency audit report")
        .option("--limit <n>", "Shared default limit", "50")
        .option("--record-limit <n>", "Max records to audit")
        .option("--orphan-limit <n>", "Max orphan index rows to sample")
        .option("--job-limit <n>", "Max index jobs to sample")
        .option("--scope <scope>", "Only audit one scope")
        .option("--session <sessionId>", "Only audit one session")
        .option("--type <type>", "Only audit one memory type")
        .option("--status <status>", "Audit one status: active|expired|forgotten|superseded|all")
        .option("--include-sessions", "Also include session archives in nested archive summary")
        .option("--format <format>", "json | markdown", "json")
        .option("--output <path>", "Write report output to a file instead of stdout")
        .action((opts) => {
          const result = runtime.getConsistencyReport({
            limit: Number(opts.limit),
            recordLimit: opts.recordLimit ? Number(opts.recordLimit) : undefined,
            orphanLimit: opts.orphanLimit ? Number(opts.orphanLimit) : undefined,
            jobLimit: opts.jobLimit ? Number(opts.jobLimit) : undefined,
            scope: opts.scope,
            sessionId: opts.session,
            type: opts.type,
            status: normalizeSearchStatus(opts.status),
            includeSessions: opts.includeSessions === true,
          });
          const format = normalizeText(opts.format).toLowerCase() === "markdown" ? "markdown" : "json";
          const rendered = runtime.renderConsistencyReport(result, format);
          const outputPath = normalizeText(opts.output);
          if (outputPath) {
            const resolved = path.resolve(expandHome(outputPath));
            ensureDir(path.dirname(resolved));
            fs.writeFileSync(resolved, rendered, "utf8");
            console.log(
              JSON.stringify(
                {
                  format,
                  outputPath: resolved,
                  summary: result.summary,
                },
                null,
                2,
              ),
            );
            return;
          }
          console.log(rendered);
        });

      group
        .command("consistency-repair")
        .description("Repair safe consistency issues found by consistency-report")
        .option("--limit <n>", "Shared default limit", "50")
        .option("--record-limit <n>", "Max records to audit")
        .option("--orphan-limit <n>", "Max orphan index rows to sample")
        .option("--job-limit <n>", "Max index jobs to sample")
        .option("--scope <scope>", "Only repair one scope")
        .option("--session <sessionId>", "Only repair one session")
        .option("--type <type>", "Only repair one memory type")
        .option("--status <status>", "Repair one status: active|expired|forgotten|superseded|all")
        .option("--include-sessions", "Also include session archives in nested archive summary")
        .option("--retry-failed", "Also retry failed index jobs")
        .option("--dry-run", "Preview repair actions without changing data")
        .action((opts) => {
          const result = runtime.repairConsistency({
            limit: Number(opts.limit),
            recordLimit: opts.recordLimit ? Number(opts.recordLimit) : undefined,
            orphanLimit: opts.orphanLimit ? Number(opts.orphanLimit) : undefined,
            jobLimit: opts.jobLimit ? Number(opts.jobLimit) : undefined,
            scope: opts.scope,
            sessionId: opts.session,
            type: opts.type,
            status: normalizeSearchStatus(opts.status),
            includeSessions: opts.includeSessions === true,
            retryFailed: opts.retryFailed === true,
            dryRun: opts.dryRun === true,
          });
          console.log(JSON.stringify(result, null, 2));
        });

      group
        .command("export")
        .description("Export committed memory records by filters")
        .option("--limit <n>", "Max records", "20")
        .option("--scope <scope>", "Only export one scope")
        .option("--session <sessionId>", "Only export one session")
        .option("--type <type>", "Only export one memory type")
        .option("--status <status>", "Export one status: active|expired|forgotten|superseded|all")
        .option("--format <format>", "json | markdown", "json")
        .option("--with-archive", "Include archive text in export output")
        .option("--output <path>", "Write export output to a file instead of stdout")
        .action((opts) => {
          const result = runtime.exportRecords({
            limit: Number(opts.limit),
            scope: opts.scope,
            sessionId: opts.session,
            type: opts.type,
            status: normalizeSearchStatus(opts.status),
            format: opts.format,
            includeArchive: opts.withArchive === true,
          });
          const outputPath = normalizeText(opts.output);
          if (outputPath) {
            const resolved = path.resolve(expandHome(outputPath));
            ensureDir(path.dirname(resolved));
            fs.writeFileSync(resolved, result.text, "utf8");
            console.log(
              JSON.stringify(
                {
                  count: result.count,
                  format: result.format,
                  includeArchive: result.includeArchive,
                  outputPath: resolved,
                },
                null,
                2,
              ),
            );
            return;
          }
          console.log(result.text);
        });

      group
        .command("import")
        .description("Import memory records from a JSON export file")
        .requiredOption("--input <path>", "Path to a JSON export file")
        .option("--format <format>", "json", "json")
        .option("--limit <n>", "Max records to import", (value) => Number(value))
        .option("--scope <scope>", "Override imported scope")
        .option("--session <sessionId>", "Override imported session id")
        .option("--dry-run", "Preview import actions without writing records")
        .option("--no-archive", "Do not write markdown archive during import")
        .action((opts) => {
          const inputPath = path.resolve(expandHome(normalizeText(opts.input)));
          const payload = fs.readFileSync(inputPath, "utf8");
          const result = runtime.importRecords({
            payload,
            format: opts.format,
            limit: opts.limit,
            scope: opts.scope,
            sessionId: opts.session,
            archive: opts.archive,
            dryRun: opts.dryRun === true,
          });
          console.log(
            JSON.stringify(
              {
                inputPath,
                ...result,
              },
              null,
              2,
            ),
          );
        });

      group
        .command("migrate-session-memory")
        .description("Migrate legacy session-memory markdown files into memory records")
        .option("--input <path>", "Legacy markdown file or directory", "~/.openclaw/workspace/memory")
        .option("--output <path>", "Write converted import payload JSON to a file")
        .option("--scope <scope>", "Imported scope", "mem://user/default")
        .option("--session-prefix <prefix>", "Imported session id prefix", "legacy-session")
        .option("--limit <n>", "Max records to migrate", (value) => Number(value))
        .option("--dry-run", "Preview migration without writing records")
        .option("--verbose", "Include migrated record preview in output")
        .option("--no-archive", "Do not write markdown archive during import")
        .action((opts) => {
          const migration = buildLegacyImportPayload({
            input: normalizeText(opts.input),
            scope: normalizeText(opts.scope),
            sessionPrefix: normalizeText(opts.sessionPrefix),
            limit: Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : 0,
          });
          const outputPath = normalizeText(opts.output);
          let resolvedOutput = "";
          if (outputPath) {
            resolvedOutput = path.resolve(expandHome(outputPath));
            ensureDir(path.dirname(resolvedOutput));
            fs.writeFileSync(resolvedOutput, `${JSON.stringify(migration.payload, null, 2)}\n`, "utf8");
          }

          const result = runtime.importRecords({
            payload: JSON.stringify(migration.payload),
            format: "json",
            archive: opts.archive,
            dryRun: opts.dryRun === true,
          });

          const response = {
            inputPath: migration.inputPath,
            fileCount: migration.fileCount,
            converted: migration.recordCount,
            byType: migration.byType,
            outputPath: resolvedOutput || "",
            import: result,
          };
          if (opts.verbose === true) {
            response.preview = migration.records.slice(0, 8).map((entry) => ({
              sourceId: entry.id,
              type: entry.type,
              title: entry.title,
              sessionId: entry.sessionId,
              sourcePath: entry.sourcePath,
            }));
          }
          console.log(JSON.stringify(response, null, 2));
        });

      group
        .command("search")
        .description("Search committed memories")
        .argument("<query>", "Search query")
        .option("--limit <n>", "Max results", "5")
        .option("--scope <scope>", "Only search one scope")
        .option("--type <type>", "Only search one memory type")
        .option("--status <status>", "Search one status: active|expired|forgotten|superseded|all")
        .action((query, opts) => {
          const results = runtime.searchRecords({
            query,
            limit: Number(opts.limit),
            scope: opts.scope,
            type: opts.type,
            status: normalizeSearchStatus(opts.status),
          });
          console.log(JSON.stringify({ count: results.length, results }, null, 2));
        });

      group
        .command("get")
        .description("Read one committed memory record by id")
        .argument("<id>", "Memory record id")
        .action((id) => {
          const record = runtime.getRecordById(normalizeText(id));
          if (!record) {
            console.log(JSON.stringify({ found: false }, null, 2));
            return;
          }
          console.log(JSON.stringify({ found: true, record }, null, 2));
        });

      group
        .command("stage-stats")
        .description("Show staging candidate count")
        .action(() => {
          runtime.ensureInitialized();
          console.log(JSON.stringify({ staging: runtime.countStaging() }, null, 2));
        });

      group
        .command("stage-list")
        .description("List staged candidates")
        .option("--session <id>", "Filter by session id")
        .option("--limit <n>", "Max results", "10")
        .action((opts) => {
          const results = runtime.listStagedCandidates({
            sessionId: opts.session,
            limit: Number(opts.limit),
          });
          console.log(JSON.stringify({ count: results.length, results }, null, 2));
        });

      const projectGroup = group.command("project").description("Project binding commands");

      projectGroup
        .command("current")
        .description("Show current resolved project binding")
        .action(() => {
          console.log(
            JSON.stringify(
              {
                currentProject: runtime.getCurrentProject(true),
                activeOverride: runtime.getProjectOverride(),
              },
              null,
              2,
            ),
          );
        });

      projectGroup
        .command("list")
        .description("List known project bindings")
        .action(() => {
          const projects = runtime.listProjects();
          console.log(JSON.stringify({ count: projects.length, projects }, null, 2));
        });

      projectGroup
        .command("use")
        .description("Set and persist the active manual project binding")
        .argument("<key>", "Existing project key or a new stable key, for example memory-plugin")
        .option("--name <name>", "Display name for this project")
        .action((key, opts) => {
          const project = runtime.useProject(key, opts.name);
          if (!project) {
            console.log(JSON.stringify({ ok: false, reason: "invalid_project_key" }, null, 2));
            return;
          }
          console.log(
            JSON.stringify(
              {
                ok: true,
                activeOverride: runtime.getProjectOverride(),
                project,
              },
              null,
              2,
            ),
          );
        });

      projectGroup
        .command("bind")
        .description("Rename the current resolved project binding")
        .argument("<name>", "Display name for the current project")
        .action((name) => {
          const project = runtime.bindCurrentProject(name);
          if (!project) {
            console.log(JSON.stringify({ ok: false, reason: "project_unresolved" }, null, 2));
            return;
          }
          console.log(JSON.stringify({ ok: true, project }, null, 2));
        });

      projectGroup
        .command("clear")
        .description("Clear the active manual project override and fall back to auto resolution")
        .action(() => {
          const project = runtime.clearProjectOverride();
          console.log(
            JSON.stringify(
              {
                ok: true,
                activeOverride: runtime.getProjectOverride(),
                currentProject: project,
              },
              null,
              2,
            ),
          );
        });
    },
    { commands: ["mhm"] },
  );
}

module.exports = {
  registerMemoryCli,
};
