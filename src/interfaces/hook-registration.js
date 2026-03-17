"use strict";

function isSystemInitiatedPrompt(prompt) {
  const text = (prompt || "").trim();
  if (!text) {
    return true;
  }
  if (/<memory-hybrid-context>[\s\S]*<\/memory-hybrid-context>/i.test(text)) {
    return true;
  }
  if (
    /a new session was started via\s*\/new\s*or\s*\/reset/i.test(text) ||
    /execute your session startup sequence now/i.test(text) ||
    /do not mention internal steps,\s*files,\s*tools,\s*or reasoning/i.test(text)
  ) {
    return true;
  }
  if (
    /^pre-compaction memory flush\b/i.test(text) ||
    /store durable memories only in memory\/yyyy-mm-dd\.md/i.test(text)
  ) {
    return true;
  }
  return false;
}

function registerMemoryHooks({
  api,
  cfg,
  runtime,
  extractTextBlocksFromMessages,
  normalizeText,
  shouldAutoRecallPrompt,
  packRecallContext,
}) {
  api.on("agent_end", async (event, ctx) => {
    if (!cfg.capture.autoStage) {
      return;
    }
    if (!event || event.success !== true || !Array.isArray(event.messages)) {
      return;
    }

    const items = extractTextBlocksFromMessages(event.messages, cfg.capture.captureAssistant).slice(
      0,
      cfg.capture.maxCandidatesPerTurn,
    );
    if (items.length === 0) {
      return;
    }

    const staged = runtime.stageCandidates({
      sessionId:
        normalizeText((ctx && ctx.sessionId) || event.sessionId || event.session_id) || "unknown",
      items,
    });

    if (staged.inserted > 0) {
      api.logger.info(
        `memory-hybrid-context: staged ${staged.inserted} candidate(s) on agent_end`,
      );
    }
  });

  api.on("before_reset", async (event, ctx) => {
    const result = runtime.handleBeforeReset({
      reason: normalizeText(event && event.reason),
      sessionFile: normalizeText(event && event.sessionFile),
      messages: Array.isArray(event && event.messages) ? event.messages : [],
      sessionId: normalizeText((ctx && ctx.sessionId) || ""),
    });

    if (result.action === "skipped") {
      return;
    }

    const committedCount = result.committed && typeof result.committed.committed === "number"
      ? result.committed.committed
      : 0;
    const stagedCount = result.staged && typeof result.staged.inserted === "number"
      ? result.staged.inserted
      : 0;

    api.logger.info(
      `memory-hybrid-context: before_reset(${result.reason}) staged=${stagedCount} committed=${committedCount}`,
    );
  });

  api.on("before_agent_start", async (event, ctx) => {
    if (!cfg.recall.auto) {
      return;
    }
    const trigger = normalizeText((ctx && ctx.trigger) || "").toLowerCase();
    if (trigger && trigger !== "user") {
      return;
    }

    const prompt = normalizeText(event && event.prompt);
    if (isSystemInitiatedPrompt(prompt)) {
      return;
    }
    if (!shouldAutoRecallPrompt(prompt)) {
      return;
    }

    const scopes = runtime.resolvePreferredScopes("", "");
    const records = runtime.searchRecords({
      query: prompt,
      limit: cfg.recall.maxItems,
      scopes,
    });
    if (records.length === 0) {
      return;
    }

    const packedRecall = packRecallContext(
      records,
      cfg.recall.maxChars,
      cfg.recall.defaultLevel,
    );
    const prependSystemContext = packedRecall.text;
    if (!prependSystemContext) {
      return;
    }

    runtime.recordRecallEvent({
      sessionId: normalizeText(event && event.sessionId),
      queryText: prompt,
      queryScope: scopes.join(","),
      level: packedRecall.usedLevel,
      injectedChars: prependSystemContext.length,
      selectedIds: packedRecall.selectedIds,
    });

    return { prependSystemContext };
  });
}

module.exports = {
  registerMemoryHooks,
};
