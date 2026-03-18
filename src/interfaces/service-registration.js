"use strict";

function registerMemoryService({ api, runtime, cfg, summary }) {
  let indexerTimer = null;
  let cleanupTimer = null;
  let idleCommitTimer = null;

  api.registerService({
    id: "memory-hybrid-context",
    start: () => {
      runtime.ensureInitialized();
      if (cfg.enabled && cfg.indexing.async !== false) {
        const runIndexer = () => {
          try {
            const agentIds = runtime.listKnownAgentIds();
            for (const agentId of agentIds) {
              const result = runtime.processIndexJobs({
                agentId,
                limit: cfg.indexing.batchSize,
              });
              if (result.completed > 0 || result.failed > 0) {
                api.logger.info(
                  `memory-hybrid-context: indexer agent=${agentId} claimed=${result.claimed} completed=${result.completed} failed=${result.failed} skipped=${result.skipped}`,
                );
              }
            }
          } catch (err) {
            api.logger.warn(`memory-hybrid-context: indexer tick failed: ${String(err)}`);
          }
        };
        runIndexer();
        indexerTimer = setInterval(runIndexer, cfg.indexing.pollMs);
        if (typeof indexerTimer?.unref === "function") {
          indexerTimer.unref();
        }
      }
      if (cfg.enabled && cfg.ttl.autoCleanup !== false) {
        const runCleanup = () => {
          try {
            const agentIds = runtime.listKnownAgentIds();
            for (const agentId of agentIds) {
              const result = runtime.cleanupExpiredRecords({
                agentId,
                limit: Math.max(25, cfg.indexing.batchSize * 4),
              });
              if (result.cleaned > 0 || result.jobsSkipped > 0) {
                api.logger.info(
                  `memory-hybrid-context: cleanup agent=${agentId} matched=${result.matched} cleaned=${result.cleaned} jobsSkipped=${result.jobsSkipped}`,
                );
              }
              if (cfg.ttl.purgeAfterDays > 0) {
                const purge = runtime.purgeExpiredRecords({
                  agentId,
                  limit: Math.max(25, cfg.indexing.batchSize * 4),
                });
                if (purge.purged > 0 || purge.deletedArchives > 0) {
                  api.logger.info(
                    `memory-hybrid-context: purge agent=${agentId} matched=${purge.matched} purged=${purge.purged} deletedArchives=${purge.deletedArchives}`,
                  );
                }
              }
            }
          } catch (err) {
            api.logger.warn(`memory-hybrid-context: cleanup tick failed: ${String(err)}`);
          }
        };
        runCleanup();
        cleanupTimer = setInterval(runCleanup, cfg.ttl.cleanupPollMs);
        if (typeof cleanupTimer?.unref === "function") {
          cleanupTimer.unref();
        }
      }
      if (cfg.enabled && Math.max(0, Math.floor(Number(cfg.commit.idleMinutes) || 0)) > 0) {
        const idleMs = Math.max(1, Math.floor(Number(cfg.commit.idleMinutes) || 0)) * 60 * 1000;
        const idlePollMs = Math.max(30000, Math.min(300000, Math.floor(idleMs / 2) || 30000));
        const runIdleCommit = () => {
          try {
            const agentIds = runtime.listKnownAgentIds();
            for (const agentId of agentIds) {
              const result = runtime.commitIdleSessions({
                agentId,
                limit: Math.max(10, cfg.capture.maxCandidatesPerTurn * 4),
              });
              if (result.committedRecords > 0 || result.matchedSessions > 0) {
                api.logger.info(
                  `memory-hybrid-context: idle-commit agent=${agentId} matchedSessions=${result.matchedSessions} committedSessions=${result.committedSessions} committedRecords=${result.committedRecords}`,
                );
              }
            }
          } catch (err) {
            api.logger.warn(`memory-hybrid-context: idle commit tick failed: ${String(err)}`);
          }
        };
        runIdleCommit();
        idleCommitTimer = setInterval(runIdleCommit, idlePollMs);
        if (typeof idleCommitTimer?.unref === "function") {
          idleCommitTimer.unref();
        }
      }
      api.logger.info(`memory-hybrid-context: loaded (${JSON.stringify(summary)})`);
    },
    stop: () => {
      if (indexerTimer) {
        clearInterval(indexerTimer);
        indexerTimer = null;
      }
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      if (idleCommitTimer) {
        clearInterval(idleCommitTimer);
        idleCommitTimer = null;
      }
      runtime.close();
        api.logger.info("memory-hybrid-context: stopped");
    },
  });
}

module.exports = {
  registerMemoryService,
};
