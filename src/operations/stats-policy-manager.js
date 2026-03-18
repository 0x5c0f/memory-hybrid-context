"use strict";

class StatsPolicyManager {
  constructor(deps) {
    this.cfg = deps.cfg;
    this.ensureInitialized = deps.ensureInitialized;
    this.resolveAgentId = deps.resolveAgentId;
    this.normalizeText = deps.normalizeText;
    this.computeAutoExpiryForType = deps.computeAutoExpiryForType;
    this.resolveRoutedScopeByType = deps.resolveRoutedScopeByType;
    this.vectorBackend = deps.vectorBackend;
  }

  getTypeBreakdown() {
    const conn = this.ensureInitialized();
    const agentId = this.resolveAgentId();
    const rows = conn
      .prepare(
        `SELECT type, status, COUNT(*) AS c
           FROM memory_records
          WHERE agent_id = ?
          GROUP BY type, status
          ORDER BY type ASC, status ASC`,
      )
      .all(agentId);

    const grouped = new Map();
    for (const row of rows) {
      const type = this.normalizeText(row.type) || "other";
      const status = this.normalizeText(row.status) || "unknown";
      const entry = grouped.get(type) || {
        type,
        total: 0,
        active: 0,
        expired: 0,
        forgotten: 0,
        superseded: 0,
        other: 0,
      };
      const count = Number(row.c) || 0;
      entry.total += count;
      if (status === "active" || status === "expired" || status === "forgotten" || status === "superseded") {
        entry[status] += count;
      } else {
        entry.other += count;
      }
      grouped.set(type, entry);
    }
    return Array.from(grouped.values()).sort(
      (left, right) => right.total - left.total || left.type.localeCompare(right.type),
    );
  }

  getScopeBreakdown() {
    const conn = this.ensureInitialized();
    const agentId = this.resolveAgentId();
    const rows = conn
      .prepare(
        `SELECT scope, status, COUNT(*) AS c
           FROM memory_records
          WHERE agent_id = ?
          GROUP BY scope, status
          ORDER BY scope ASC, status ASC`,
      )
      .all(agentId);

    const grouped = new Map();
    for (const row of rows) {
      const scope = this.normalizeText(row.scope) || "unknown";
      const status = this.normalizeText(row.status) || "unknown";
      const entry = grouped.get(scope) || {
        scope,
        total: 0,
        active: 0,
        expired: 0,
        forgotten: 0,
        superseded: 0,
        other: 0,
      };
      const count = Number(row.c) || 0;
      entry.total += count;
      if (status === "active" || status === "expired" || status === "forgotten" || status === "superseded") {
        entry[status] += count;
      } else {
        entry.other += count;
      }
      grouped.set(scope, entry);
    }
    return Array.from(grouped.values()).sort(
      (left, right) => right.total - left.total || left.scope.localeCompare(right.scope),
    );
  }

  getBreakdownSnapshot() {
    return {
      byType: this.getTypeBreakdown(),
      byScope: this.getScopeBreakdown(),
    };
  }

  getTypeRoutingRules() {
    const types = [
      "profile",
      "preference",
      "decision",
      "event",
      "todo",
      "entity",
      "pattern",
      "case",
      "other",
    ];
    const primary = this.normalizeText(this.cfg.scopes.primary) || "user";
    const fallback = this.normalizeText(this.cfg.scopes.fallback);
    const purgeAfterDays = Math.max(0, Math.floor(Number(this.cfg.ttl?.purgeAfterDays) || 0));

    return types.map((memoryType) => {
      const routed = this.resolveRoutedScopeByType(this.cfg, memoryType) || primary;
      const autoExpiryTs = this.computeAutoExpiryForType(this.cfg, memoryType, 0);
      let autoExpireDays = 0;
      if (memoryType === "todo") {
        autoExpireDays = Math.max(0, Math.floor(Number(this.cfg.ttl?.todoDays) || 0));
      } else if (memoryType === "event" || memoryType === "other") {
        autoExpireDays = Math.max(0, Math.floor(Number(this.cfg.ttl?.sessionDays) || 0));
      } else if (autoExpiryTs) {
        autoExpireDays = Math.max(1, Math.round(autoExpiryTs / (24 * 60 * 60 * 1000)));
      }

      const fallbackScope = routed !== primary ? primary : fallback;
      const lifecycle = autoExpireDays > 0
        ? (purgeAfterDays > 0 ? "active -> expired -> purge" : "active -> expired")
        : "active (manual expire)";

      return {
        type: memoryType,
        preferredScope: routed,
        fallbackScope: this.normalizeText(fallbackScope),
        autoExpireDays,
        purgeAfterDays: autoExpireDays > 0 ? purgeAfterDays : 0,
        lifecycle,
        note:
          autoExpireDays > 0
            ? `默认 ${autoExpireDays} 天后过期`
            : "默认长期保留，除非手动过期或删除",
      };
    });
  }

  getPolicySnapshot() {
    const todoDays = Math.max(0, Math.floor(Number(this.cfg.ttl?.todoDays) || 0));
    const sessionDays = Math.max(0, Math.floor(Number(this.cfg.ttl?.sessionDays) || 0));
    return {
      scopes: {
        enabled: Array.isArray(this.cfg.scopes.enabled) ? this.cfg.scopes.enabled.slice() : [],
        primary: this.normalizeText(this.cfg.scopes.primary) || "user",
        fallback: this.normalizeText(this.cfg.scopes.fallback),
        autoMirror: this.cfg.scopes.autoMirror === true,
        typeRouting: {
          user: Array.isArray(this.cfg.scopes.typeRouting?.user) ? this.cfg.scopes.typeRouting.user.slice() : [],
          project: Array.isArray(this.cfg.scopes.typeRouting?.project) ? this.cfg.scopes.typeRouting.project.slice() : [],
          agent: Array.isArray(this.cfg.scopes.typeRouting?.agent) ? this.cfg.scopes.typeRouting.agent.slice() : [],
        },
      },
      ttl: {
        todoDays,
        sessionDays,
        autoCleanup: this.cfg.ttl.autoCleanup !== false,
        cleanupPollMs: this.cfg.ttl.cleanupPollMs,
        purgeAfterDays: Math.max(0, Math.floor(Number(this.cfg.ttl.purgeAfterDays) || 0)),
        autoExpireByType: {
          todo: todoDays > 0 ? `${todoDays}d` : "off",
          event: sessionDays > 0 ? `${sessionDays}d` : "off",
          other: sessionDays > 0 ? `${sessionDays}d` : "off",
          preference: "manual",
          profile: "manual",
          decision: "manual",
          entity: "manual",
          pattern: "manual",
          case: "manual",
        },
      },
      indexing: {
        async: this.cfg.indexing.async !== false,
        batchSize: this.cfg.indexing.batchSize,
        pollMs: this.cfg.indexing.pollMs,
        retryLimit: this.cfg.indexing.retryLimit,
      },
      vector: {
        ...this.vectorBackend.info(),
      },
      isolation: {
        mode: this.normalizeText(this.cfg.isolation?.mode) || "agent",
        defaultAgentId: this.normalizeText(this.cfg.isolation?.defaultAgentId) || "main",
        activeAgentId: this.resolveAgentId(),
      },
      projectResolver: {
        enabled: this.cfg.projectResolver.enabled !== false,
        mode: this.normalizeText(this.cfg.projectResolver.mode) || "auto",
      },
      routingRules: this.getTypeRoutingRules(),
    };
  }
}

module.exports = {
  StatsPolicyManager,
};
