"use strict";

function buildPluginSchemas() {
  const commitParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
      details: { type: "string" },
      l0Text: { type: "string" },
      l1Text: { type: "string" },
      l2Text: { type: "string" },
      type: { type: "string" },
      scope: { type: "string" },
      sessionId: { type: "string" },
      importance: { type: "number", minimum: 0, maximum: 1 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      keywords: {
        type: "array",
        items: { type: "string" },
      },
      archive: { type: "boolean" },
      source: {
        type: "string",
        enum: ["inline", "staging", "both"],
      },
      policy: {
        type: "string",
        enum: ["conservative", "aggressive"],
      },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
  };

  const searchParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 20 },
      scope: { type: "string" },
      type: { type: "string" },
      status: {
        type: "string",
        enum: ["active", "expired", "forgotten", "superseded", "all"],
      },
    },
    required: ["query"],
  };

  const getParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
    },
    required: ["id"],
  };

  const listParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: { type: "string" },
      sessionId: { type: "string" },
      type: { type: "string" },
      status: {
        type: "string",
        enum: ["active", "expired", "forgotten", "superseded", "all"],
      },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
  };

  const archiveRepairParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: { type: "string" },
      sessionId: { type: "string" },
      type: { type: "string" },
      status: {
        type: "string",
        enum: ["active", "expired", "forgotten", "superseded", "all"],
      },
      limit: { type: "integer", minimum: 1, maximum: 500 },
      dryRun: { type: "boolean" },
    },
  };

  const archiveOrphanParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 5000 },
      includeSessions: { type: "boolean" },
      dryRun: { type: "boolean" },
    },
  };

  const archiveQuarantineListParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 5000 },
    },
  };

  const archiveQuarantineRestoreParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 5000 },
      paths: {
        type: "array",
        items: { type: "string" },
      },
      dryRun: { type: "boolean" },
    },
  };

  const archiveQuarantinePurgeParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 5000 },
      paths: {
        type: "array",
        items: { type: "string" },
      },
      dryRun: { type: "boolean" },
    },
  };

  const archiveReportParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: { type: "string" },
      sessionId: { type: "string" },
      type: { type: "string" },
      status: {
        type: "string",
        enum: ["active", "expired", "forgotten", "superseded", "all"],
      },
      limit: { type: "integer", minimum: 1, maximum: 5000 },
      recordLimit: { type: "integer", minimum: 1, maximum: 500 },
      orphanLimit: { type: "integer", minimum: 1, maximum: 5000 },
      quarantineLimit: { type: "integer", minimum: 1, maximum: 5000 },
      includeSessions: { type: "boolean" },
      format: {
        type: "string",
        enum: ["json", "markdown"],
      },
    },
  };

  const consistencyReportParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: { type: "string" },
      sessionId: { type: "string" },
      type: { type: "string" },
      status: {
        type: "string",
        enum: ["active", "expired", "forgotten", "superseded", "all"],
      },
      limit: { type: "integer", minimum: 1, maximum: 5000 },
      recordLimit: { type: "integer", minimum: 1, maximum: 500 },
      orphanLimit: { type: "integer", minimum: 1, maximum: 5000 },
      jobLimit: { type: "integer", minimum: 1, maximum: 500 },
      includeSessions: { type: "boolean" },
      format: {
        type: "string",
        enum: ["json", "markdown"],
      },
    },
  };

  const consistencyRepairParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: { type: "string" },
      sessionId: { type: "string" },
      type: { type: "string" },
      status: {
        type: "string",
        enum: ["active", "expired", "forgotten", "superseded", "all"],
      },
      limit: { type: "integer", minimum: 1, maximum: 5000 },
      recordLimit: { type: "integer", minimum: 1, maximum: 500 },
      orphanLimit: { type: "integer", minimum: 1, maximum: 5000 },
      jobLimit: { type: "integer", minimum: 1, maximum: 500 },
      includeSessions: { type: "boolean" },
      dryRun: { type: "boolean" },
      retryFailed: { type: "boolean" },
    },
  };

  const exportParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: { type: "string" },
      sessionId: { type: "string" },
      type: { type: "string" },
      status: {
        type: "string",
        enum: ["active", "expired", "forgotten", "superseded", "all"],
      },
      limit: { type: "integer", minimum: 1, maximum: 200 },
      format: {
        type: "string",
        enum: ["json", "markdown"],
      },
      includeArchive: { type: "boolean" },
    },
  };

  const importParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      payload: { type: "string" },
      format: {
        type: "string",
        enum: ["json"],
      },
      limit: { type: "integer", minimum: 1, maximum: 200 },
      scope: { type: "string" },
      sessionId: { type: "string" },
      archive: { type: "boolean" },
      dryRun: { type: "boolean" },
    },
    required: ["payload"],
  };

  const stageListParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
  };

  const idleParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      idleMinutes: { type: "integer", minimum: 0, maximum: 10080 },
      limit: { type: "integer", minimum: 1, maximum: 1000 },
    },
  };

  const stageDropParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
      },
      sessionId: { type: "string" },
    },
  };

  const restoreParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
      },
      sessionId: { type: "string" },
      scope: { type: "string" },
      type: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 1000 },
    },
  };

  const forgetParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
      },
      sessionId: { type: "string" },
      scope: { type: "string" },
      type: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 1000 },
      dryRun: { type: "boolean" },
    },
  };

  const emptyParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {},
  };

  return {
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
  };
}

module.exports = {
  buildPluginSchemas,
};
