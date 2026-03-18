"use strict";

class Retriever {
  constructor(deps) {
    this.deps = deps;
  }

  buildSearchContext(params) {
    const limit = Math.max(1, Math.min(20, Math.floor(Number(params.limit) || 5)));
    const query = this.deps.normalizeText(params.query);
    const searchStatus = this.deps.normalizeSearchStatus(params.status) || "active";
    const agentId = this.deps.resolveAgentId(params.agentId);
    if (!query) {
      return null;
    }

    const filters = ["r.agent_id = ?"];
    const values = [agentId];
    if (Array.isArray(params.scopes) && params.scopes.length > 0) {
      const placeholders = params.scopes.map(() => "?").join(", ");
      filters.push(`r.scope IN (${placeholders})`);
      values.push(...params.scopes);
    } else if (params.scope) {
      filters.push("r.scope = ?");
      values.push(params.scope);
    }
    if (params.type) {
      filters.push("r.type = ?");
      values.push(params.type);
    }
    if (searchStatus !== "all") {
      filters.push("r.status = ?");
      values.push(searchStatus);
    }
    if (searchStatus === "active") {
      filters.push("(r.expires_at IS NULL OR r.expires_at > ?)");
      values.push(Date.now());
    }

    const whereClause = filters.length > 0 ? ` AND ${filters.join(" AND ")}` : "";
    const selectColumns =
      "r.id, r.agent_id, r.scope, r.type, r.status, r.title, r.summary, r.l0_text, r.l1_text, r.l2_text, r.content_ref, r.source_path, " +
      "r.importance, r.confidence, r.updated_at";
    const rowToResult = (row, score) => ({
      id: row.id,
      agentId: row.agent_id || agentId,
      scope: row.scope,
      type: row.type,
      status: row.status,
      title: row.title,
      summary: row.summary,
      l0Text: row.l0_text || row.title,
      l1Text: row.l1_text || row.summary,
      l2Text: row.l2_text || "",
      contentRef: row.content_ref,
      sourcePath: row.source_path,
      importance: row.importance,
      confidence: row.confidence,
      score,
      updatedAt: row.updated_at,
    });

    return {
      limit,
      agentId,
      query,
      searchStatus,
      values,
      whereClause,
      selectColumns,
      rowToResult,
    };
  }

  runFtsSearch(conn, context) {
    const results = [];
    const ftsQuery = this.deps.buildFtsQuery(context.query);
    if (!ftsQuery) {
      return results;
    }
    try {
      const rows = conn
        .prepare(
          `SELECT ${context.selectColumns},
                  bm25(memory_fts_docs) AS rank
             FROM memory_fts_docs
             JOIN memory_records r ON r.id = memory_fts_docs.id
            WHERE memory_fts_docs MATCH ?${context.whereClause}
            ORDER BY rank ASC
            LIMIT ?`,
        )
        .all(ftsQuery, ...context.values, context.limit);
      for (const row of rows) {
        results.push(
          context.rowToResult(row, Number.isFinite(row.rank) ? 1 / (1 + Math.max(0, row.rank)) : 0.5),
        );
      }
    } catch (err) {
      this.deps.logDebug("memory-hybrid-context: fts search fallback", { error: String(err) });
    }
    return results;
  }

  mergeResults(ftsRows, vectorRows, limit) {
    if (this.deps.cfg.query.hybrid === false || (ftsRows.length === 0 && vectorRows.length === 0)) {
      return [];
    }

    const merged = new Map();
    for (const row of ftsRows) {
      merged.set(row.id, {
        row,
        fts: row.score,
        vector: 0,
      });
    }
    for (const row of vectorRows) {
      const existing = merged.get(row.id);
      if (existing) {
        existing.vector = row.score;
      } else {
        merged.set(row.id, {
          row,
          fts: 0,
          vector: row.score,
        });
      }
    }

    return Array.from(merged.values())
      .map((entry) => {
        const weightSum =
          (entry.fts > 0 ? this.deps.cfg.query.ftsWeight : 0) +
          (entry.vector > 0 ? this.deps.cfg.query.vectorWeight : 0) ||
          1;
        const combined =
          ((entry.fts * this.deps.cfg.query.ftsWeight) + (entry.vector * this.deps.cfg.query.vectorWeight)) / weightSum;
        const quality =
          ((Number(entry.row.importance) || 0.5) + (Number(entry.row.confidence) || 0.5)) / 2;
        return {
          ...entry.row,
          score: Math.max(0, Math.min(1, combined * 0.95 + quality * 0.05)),
        };
      })
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return (right.updatedAt || 0) - (left.updatedAt || 0);
      })
      .slice(0, limit);
  }

  runLikeFallback(conn, context) {
    const terms = this.deps.extractSearchTerms(context.query);
    const likeTerms = terms.length > 0 ? terms : [context.query];
    const likeConditions = [];
    const likeValues = [];
    for (const term of likeTerms) {
      const likeValue = `%${term}%`;
      likeConditions.push("(r.title LIKE ? OR r.summary LIKE ? OR IFNULL(r.raw_text, '') LIKE ?)");
      likeValues.push(likeValue, likeValue, likeValue);
    }
    const rows = conn
      .prepare(
        `SELECT ${context.selectColumns}
           FROM memory_records r
          WHERE (${likeConditions.join(" OR ")})
                ${context.whereClause}
          ORDER BY r.updated_at DESC
          LIMIT ?`,
      )
      .all(...likeValues, ...context.values, context.limit);
    return rows.map((row) => context.rowToResult(row, 0.25));
  }

  search(conn, params) {
    const context = this.buildSearchContext(params);
    if (!context) {
      return [];
    }

    const ftsRows = this.runFtsSearch(conn, context);
    const vectorRows = this.deps.vectorBackend.search({
      conn,
      query: context.query,
      limit: context.limit,
      whereClause: context.whereClause,
      values: context.values,
      selectColumns: context.selectColumns,
      rowToResult: context.rowToResult,
    });

    const merged = this.mergeResults(ftsRows, vectorRows, context.limit);
    if (merged.length > 0) {
      return merged;
    }
    if (vectorRows.length > 0) {
      return vectorRows.slice(0, context.limit);
    }
    if (ftsRows.length > 0) {
      return ftsRows.slice(0, context.limit);
    }
    return this.runLikeFallback(conn, context);
  }
}

module.exports = {
  Retriever,
};
