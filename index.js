"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { ArchiveGovernanceManager } = require("./src/governance/archive-governance");
const { IndexingManager } = require("./src/indexing/indexing-manager");
const { ImportExportManager } = require("./src/operations/import-export-manager");
const { ProjectManager } = require("./src/core/project-manager");
const { RecordManager } = require("./src/core/record-manager");
const { Retriever } = require("./src/retrieval/retriever");
const { registerMemoryHooks } = require("./src/interfaces/hook-registration");
const { StagingManager } = require("./src/core/staging-manager");
const { StoreQueryManager } = require("./src/core/store-query-manager");
const { StatsPolicyManager } = require("./src/operations/stats-policy-manager");
const { LifecycleManager } = require("./src/governance/lifecycle-manager");
const { registerMemoryCli } = require("./src/interfaces/cli-registration");
const { buildPluginSchemas } = require("./src/interfaces/plugin-schemas");
const { registerMemoryService } = require("./src/interfaces/service-registration");
const { registerMemoryTools } = require("./src/interfaces/tool-registration");
const { evaluateVectorHealth } = require("./src/retrieval/vector-health");
const { ConsistencyManager } = require("./src/governance/consistency-manager");

const DEFAULT_CONFIG = {
  enabled: false,
  debug: false,
  store: {
    driver: "sqlite",
    path: "~/.openclaw/memory-hybrid/main.sqlite",
    vector: {
      backend: "sqlite-vec",
      enabled: true,
      extensionPath: "",
      candidateLimit: 48,
      probePerBand: 1,
      embeddingVersion: "v1",
      embedding: {
        mode: "hash",
        baseURL: "",
        model: "",
        apiKey: "",
        apiKeyEnv: "OPENAI_API_KEY",
        dimensions: 0,
        timeoutMs: 15000,
        fallbackToHash: true,
      },
    },
  },
  archive: {
    enabled: true,
    dir: "~/.openclaw/memory-hybrid/archive",
    writeMarkdown: true,
  },
  capture: {
    autoStage: true,
    useLlmExtraction: false,
    maxCandidatesPerTurn: 3,
    captureAssistant: false,
  },
  indexing: {
    async: true,
    batchSize: 16,
    pollMs: 3000,
    retryLimit: 3,
  },
  commit: {
    onNew: true,
    onReset: true,
    idleMinutes: 0,
  },
  recall: {
    auto: true,
    maxItems: 4,
    maxChars: 900,
    defaultLevel: "L1",
  },
  query: {
    hybrid: true,
    ftsWeight: 0.35,
    vectorWeight: 0.65,
    rerank: false,
  },
  scopes: {
    enabled: ["user", "project"],
    primary: "user",
    fallback: "project",
    autoMirror: false,
    typeRouting: {
      user: ["profile", "preference"],
      project: ["decision", "event", "todo", "entity", "case"],
      agent: ["pattern"],
    },
    enableProject: true,
    enableAgent: true,
  },
  projectResolver: {
    enabled: true,
    mode: "auto",
    workspacePath: "",
    manualKey: "",
    manualName: "",
  },
  ttl: {
    todoDays: 14,
    sessionDays: 30,
    autoCleanup: true,
    cleanupPollMs: 60000,
    purgeAfterDays: 30,
  },
  isolation: {
    mode: "agent",
    defaultAgentId: "main",
  },
};

const VECTOR_DIMENSIONS = 64;

function mergeObject(defaultValue, rawValue) {
  const base = defaultValue && typeof defaultValue === "object" ? defaultValue : {};
  const raw = rawValue && typeof rawValue === "object" ? rawValue : {};
  const out = { ...base };
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      out[key] = value.slice();
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = mergeObject(base[key], value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function mergeConfig(raw) {
  const cfg = mergeObject(DEFAULT_CONFIG, raw);
  if (cfg.scopes && typeof cfg.scopes === "object") {
    if (typeof cfg.scopes.default === "string" && !cfg.scopes.primary) {
      cfg.scopes.primary = cfg.scopes.default;
    }
    const enabled = Array.isArray(cfg.scopes.enabled)
      ? cfg.scopes.enabled.filter((value) => typeof value === "string" && value.trim())
      : [];
    cfg.scopes.enabled = enabled.length > 0 ? Array.from(new Set(enabled)) : DEFAULT_CONFIG.scopes.enabled.slice();
    if (!cfg.scopes.enabled.includes(cfg.scopes.primary)) {
      cfg.scopes.enabled.unshift(cfg.scopes.primary);
    }
    if (cfg.scopes.fallback && !cfg.scopes.enabled.includes(cfg.scopes.fallback)) {
      cfg.scopes.enabled.push(cfg.scopes.fallback);
    }
    if (cfg.scopes.enableProject === false) {
      cfg.scopes.enabled = cfg.scopes.enabled.filter((value) => value !== "project");
      if (cfg.scopes.fallback === "project") {
        cfg.scopes.fallback = "";
      }
    }
    if (cfg.scopes.enableAgent === false) {
      cfg.scopes.enabled = cfg.scopes.enabled.filter((value) => value !== "agent");
      if (cfg.scopes.fallback === "agent") {
        cfg.scopes.fallback = "";
      }
    }
    const routing = cfg.scopes.typeRouting && typeof cfg.scopes.typeRouting === "object"
      ? cfg.scopes.typeRouting
      : {};
    cfg.scopes.typeRouting = {
      user: normalizeKeywords(routing.user),
      project: normalizeKeywords(routing.project),
      agent: normalizeKeywords(routing.agent),
    };
  }
  if (!cfg.projectResolver || typeof cfg.projectResolver !== "object") {
    cfg.projectResolver = mergeObject(DEFAULT_CONFIG.projectResolver, {});
  }
  if (!cfg.store || typeof cfg.store !== "object") {
    cfg.store = mergeObject(DEFAULT_CONFIG.store, {});
  }
  if (!cfg.store.vector || typeof cfg.store.vector !== "object") {
    cfg.store.vector = mergeObject(DEFAULT_CONFIG.store.vector, {});
  }
  cfg.store.vector.backend = normalizeVectorBackendName(cfg.store.vector.backend);
  cfg.store.vector.candidateLimit = Math.max(
    8,
    Math.min(256, Math.floor(Number(cfg.store.vector.candidateLimit) || 48)),
  );
  cfg.store.vector.probePerBand = Math.max(
    0,
    Math.min(4, Math.floor(Number(cfg.store.vector.probePerBand) || 1)),
  );
  cfg.store.vector.embeddingVersion = normalizeText(cfg.store.vector.embeddingVersion) || "v1";
  if (!cfg.store.vector.embedding || typeof cfg.store.vector.embedding !== "object") {
    cfg.store.vector.embedding = mergeObject(DEFAULT_CONFIG.store.vector.embedding, {});
  }
  cfg.store.vector.embedding.mode = normalizeEmbeddingMode(cfg.store.vector.embedding.mode);
  cfg.store.vector.embedding.baseURL = normalizeText(cfg.store.vector.embedding.baseURL);
  cfg.store.vector.embedding.model = normalizeText(cfg.store.vector.embedding.model);
  cfg.store.vector.embedding.apiKey = normalizeText(cfg.store.vector.embedding.apiKey);
  cfg.store.vector.embedding.apiKeyEnv = normalizeText(cfg.store.vector.embedding.apiKeyEnv) || "OPENAI_API_KEY";
  cfg.store.vector.embedding.dimensions = Math.max(
    0,
    Math.min(8192, Math.floor(Number(cfg.store.vector.embedding.dimensions) || 0)),
  );
  cfg.store.vector.embedding.timeoutMs = Math.max(
    1000,
    Math.min(120000, Math.floor(Number(cfg.store.vector.embedding.timeoutMs) || 15000)),
  );
  cfg.store.vector.embedding.fallbackToHash = cfg.store.vector.embedding.fallbackToHash !== false;
  if (!cfg.indexing || typeof cfg.indexing !== "object") {
    cfg.indexing = mergeObject(DEFAULT_CONFIG.indexing, {});
  }
  cfg.indexing.async = cfg.indexing.async !== false;
  cfg.indexing.batchSize = Math.max(1, Math.min(128, Math.floor(Number(cfg.indexing.batchSize) || 16)));
  cfg.indexing.pollMs = Math.max(500, Math.min(60000, Math.floor(Number(cfg.indexing.pollMs) || 3000)));
  cfg.indexing.retryLimit = Math.max(0, Math.min(20, Math.floor(Number(cfg.indexing.retryLimit) || 3)));
  const mode = normalizeText(cfg.projectResolver.mode).toLowerCase();
  cfg.projectResolver.mode =
    mode === "manual" || mode === "workspace" || mode === "git" || mode === "auto"
      ? mode
      : DEFAULT_CONFIG.projectResolver.mode;
  cfg.projectResolver.workspacePath = normalizeText(cfg.projectResolver.workspacePath);
  cfg.projectResolver.manualKey = normalizeText(cfg.projectResolver.manualKey);
  if (cfg.projectResolver.mode === "manual" && !cfg.projectResolver.manualKey) {
    cfg.projectResolver.manualKey = "default";
  }
  cfg.projectResolver.manualName = normalizeText(cfg.projectResolver.manualName);
  if (cfg.projectResolver.mode === "manual" && !cfg.projectResolver.manualName) {
    cfg.projectResolver.manualName = cfg.projectResolver.manualKey;
  }
  cfg.projectResolver.enabled = cfg.projectResolver.enabled !== false;
  if (!cfg.ttl || typeof cfg.ttl !== "object") {
    cfg.ttl = mergeObject(DEFAULT_CONFIG.ttl, {});
  }
  cfg.ttl.todoDays = Math.max(0, Math.min(3650, Math.floor(Number(cfg.ttl.todoDays) || 0)));
  cfg.ttl.sessionDays = Math.max(0, Math.min(3650, Math.floor(Number(cfg.ttl.sessionDays) || 0)));
  cfg.ttl.autoCleanup = cfg.ttl.autoCleanup !== false;
  cfg.ttl.cleanupPollMs = Math.max(5000, Math.min(24 * 60 * 60 * 1000, Math.floor(Number(cfg.ttl.cleanupPollMs) || 60000)));
  cfg.ttl.purgeAfterDays = Math.max(0, Math.min(3650, Math.floor(Number(cfg.ttl.purgeAfterDays) || 0)));
  if (!cfg.isolation || typeof cfg.isolation !== "object") {
    cfg.isolation = mergeObject(DEFAULT_CONFIG.isolation, {});
  }
  cfg.isolation.mode = normalizeIsolationMode(cfg.isolation.mode);
  cfg.isolation.defaultAgentId = normalizeAgentId(cfg.isolation.defaultAgentId) || DEFAULT_CONFIG.isolation.defaultAgentId;
  const weights = [Number(cfg.query.ftsWeight), Number(cfg.query.vectorWeight)];
  const sum = weights.filter((value) => Number.isFinite(value) && value >= 0).reduce((a, b) => a + b, 0);
  if (sum > 0) {
    cfg.query.ftsWeight = weights[0] / sum;
    cfg.query.vectorWeight = weights[1] / sum;
  } else {
    cfg.query.ftsWeight = DEFAULT_CONFIG.query.ftsWeight;
    cfg.query.vectorWeight = DEFAULT_CONFIG.query.vectorWeight;
  }
  cfg.capture.maxCandidatesPerTurn = Math.max(1, Math.floor(Number(cfg.capture.maxCandidatesPerTurn) || 1));
  cfg.recall.maxItems = Math.max(1, Math.floor(Number(cfg.recall.maxItems) || 1));
  cfg.recall.maxChars = Math.max(64, Math.floor(Number(cfg.recall.maxChars) || 64));
  return cfg;
}

function expandHome(rawPath) {
  if (typeof rawPath !== "string") {
    return rawPath;
  }
  if (rawPath.startsWith("~/")) {
    return path.join(process.env.HOME || "", rawPath.slice(2));
  }
  return rawPath;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeTextFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

function readTextFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function clipText(text, maxChars) {
  const raw = String(text || "").trim();
  if (raw.length <= maxChars) {
    return raw;
  }
  return `${raw.slice(0, Math.max(0, maxChars - 1))}…`;
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeIsolationMode(value) {
  const mode = normalizeText(value).toLowerCase();
  if (mode === "global") {
    return "global";
  }
  return "agent";
}

function normalizeAgentId(value) {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) {
    return "";
  }
  const sanitized = raw
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return sanitized || "";
}

function normalizeSearchStatus(value) {
  const status = normalizeText(value).toLowerCase();
  if (status === "active" || status === "expired" || status === "forgotten" || status === "superseded" || status === "all") {
    return status;
  }
  return "";
}

function normalizeKeywords(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = normalizeText(item);
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function slugify(text) {
  const ascii = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return ascii || "memory";
}

function isoDateParts(ts) {
  const raw = new Date(ts).toISOString();
  const [date, timePart] = raw.split("T");
  return {
    date,
    time: (timePart || "00:00:00.000Z").split(".")[0],
  };
}

function formatTimestamp(ts) {
  if (!Number.isFinite(Number(ts)) || Number(ts) <= 0) {
    return "";
  }
  const parts = isoDateParts(Number(ts));
  return `${parts.date} ${parts.time} UTC`;
}

function makeScope(cfg, rawScope) {
  const scope = normalizeText(rawScope);
  if (scope) {
    return scope;
  }
  return buildScopeUri(cfg, cfg.scopes.primary, null) || buildDefaultScopeUri(cfg, "user");
}

function normalizeScopeName(value) {
  const scope = normalizeText(value);
  if (scope === "user" || scope === "project" || scope === "agent") {
    return scope;
  }
  return "";
}

function isScopeEnabled(cfg, scopeName) {
  const normalized = normalizeScopeName(scopeName);
  return Boolean(normalized && Array.isArray(cfg.scopes.enabled) && cfg.scopes.enabled.includes(normalized));
}

function buildDefaultScopeUri(cfg, scopeName) {
  const normalized = normalizeScopeName(scopeName);
  const resolved = isScopeEnabled(cfg, normalized) ? normalized : cfg.scopes.primary;
  return `mem://${resolved}/default`;
}

function buildScopeUri(cfg, scopeName, projectBinding) {
  const normalized = normalizeScopeName(scopeName);
  if (!normalized || !isScopeEnabled(cfg, normalized)) {
    return "";
  }
  if (normalized === "project") {
    if (!projectBinding || !projectBinding.projectId) {
      return "";
    }
    return `mem://project/${projectBinding.projectId}`;
  }
  return `mem://${normalized}/default`;
}

function resolveRoutedScopeByType(cfg, memoryType) {
  const type = normalizeText(memoryType).toLowerCase();
  if (!type) {
    return "";
  }
  const routing = cfg.scopes && cfg.scopes.typeRouting ? cfg.scopes.typeRouting : {};
  for (const scopeName of ["user", "project", "agent"]) {
    const mappedTypes = Array.isArray(routing[scopeName]) ? routing[scopeName] : [];
    if (mappedTypes.includes(type) && isScopeEnabled(cfg, scopeName)) {
      return scopeName;
    }
  }
  return "";
}

function resolvePreferredScopes(cfg, rawScope, memoryType, options) {
  const projectBinding = options && typeof options === "object" ? options.projectBinding : null;
  const explicit = normalizeText(rawScope);
  if (explicit) {
    return [explicit];
  }

  const scopes = [];
  const push = (scopeName) => {
    const normalized = normalizeScopeName(scopeName);
    if (!normalized || !isScopeEnabled(cfg, normalized)) {
      return;
    }
    const uri = buildScopeUri(cfg, normalized, projectBinding);
    if (!uri) {
      return;
    }
    if (!scopes.includes(uri)) {
      scopes.push(uri);
    }
  };

  const routedPrimary = resolveRoutedScopeByType(cfg, memoryType);
  push(routedPrimary || cfg.scopes.primary);
  if (routedPrimary && routedPrimary !== cfg.scopes.primary) {
    push(cfg.scopes.primary);
  }
  push(cfg.scopes.fallback);

  if (scopes.length === 0) {
    scopes.push(buildDefaultScopeUri(cfg, "user"));
  }

  return scopes;
}

function computeAutoExpiryForType(cfg, memoryType, now) {
  const type = normalizeText(memoryType).toLowerCase();
  const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const ttl = cfg && cfg.ttl && typeof cfg.ttl === "object" ? cfg.ttl : {};
  let days = 0;

  if (type === "todo") {
    days = Math.max(0, Math.floor(Number(ttl.todoDays) || 0));
  } else if (type === "event" || type === "other") {
    days = Math.max(0, Math.floor(Number(ttl.sessionDays) || 0));
  }

  if (days <= 0) {
    return null;
  }
  return current + (days * 24 * 60 * 60 * 1000);
}

function stablePathKey(filePath) {
  const value = normalizeText(filePath);
  if (!value) {
    return "";
  }
  try {
    return fs.realpathSync(value);
  } catch (_err) {
    return path.resolve(value);
  }
}

function findGitRoot(startPath) {
  const current = stablePathKey(startPath);
  if (current && fs.existsSync(path.join(current, ".git"))) {
    return current;
  }
  return "";
}

function readGitRemote(gitRoot) {
  const configPath = path.join(gitRoot, ".git", "config");
  if (!fs.existsSync(configPath)) {
    return "";
  }
  const raw = readTextFile(configPath);
  const match = raw.match(/\[remote\s+"origin"\][\s\S]*?^\s*url\s*=\s*(.+)$/m);
  return match ? normalizeText(match[1]) : "";
}

function makeManualProjectKey(rawKey) {
  const normalized = normalizeText(rawKey);
  if (!normalized) {
    return "";
  }
  if (normalized.startsWith("manual:")) {
    return normalized;
  }
  return `manual:${normalized}`;
}

function normalizeSelectedProjectKey(rawKey) {
  const normalized = normalizeText(rawKey);
  if (!normalized) {
    return "";
  }
  if (normalized.includes(":")) {
    return normalized;
  }
  return makeManualProjectKey(normalized);
}

function makeTitle(summary, rawTitle) {
  const explicit = normalizeText(rawTitle);
  if (explicit) {
    return clipText(explicit, 80);
  }
  return clipText(normalizeText(summary), 48);
}

function resolveConfiguredPath(api, rawPath) {
  const value = expandHome(rawPath);
  if (api && typeof api.resolvePath === "function" && typeof rawPath === "string") {
    try {
      return api.resolvePath(rawPath);
    } catch (_err) {
      return value;
    }
  }
  return value;
}

function buildFtsQuery(query) {
  const tokens = normalizeText(query)
    .split(/\s+/)
    .map((token) => token.replace(/["']/g, "").trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return "";
  }
  return tokens.map((token) => `"${token}"`).join(" AND ");
}

function extractSearchTerms(query) {
  const normalized = normalizeText(query);
  if (!normalized) {
    return [];
  }

  const terms = [];
  const seen = new Set();
  const pushTerm = (term) => {
    const value = normalizeText(term);
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    terms.push(value);
  };

  for (const token of normalized.split(/\s+/)) {
    if (token.length >= 2) {
      pushTerm(token);
    }
  }

  const cjkGroups = normalized.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const group of cjkGroups) {
    pushTerm(group);
    for (let i = 0; i < group.length - 1 && terms.length < 8; i += 1) {
      pushTerm(group.slice(i, i + 2));
    }
  }

  return terms.slice(0, 8);
}

function extractSemanticTokens(text) {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) {
    return [];
  }

  const out = [];
  const seen = new Set();
  const pushToken = (token) => {
    const value = normalizeText(token).toLowerCase();
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    out.push(value);
  };

  for (const token of normalized.split(/\s+/)) {
    if (token.length >= 2) {
      pushToken(token);
    }
  }

  const cjkGroups = normalized.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const group of cjkGroups) {
    pushToken(group);
    for (let i = 0; i < group.length - 1 && out.length < 24; i += 1) {
      pushToken(group.slice(i, i + 2));
    }
  }

  for (const token of extractSearchTerms(normalized)) {
    if (out.length >= 24) {
      break;
    }
    pushToken(token);
  }
  if (out.length === 0) {
    pushToken(normalized);
  }
  return out;
}

function hashToken(token, seed = 2166136261) {
  let hash = seed >>> 0;
  const raw = String(token || "");
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeVector(vector) {
  if (!Array.isArray(vector) || vector.length === 0) {
    return [];
  }
  let norm = 0;
  for (const value of vector) {
    const num = Number(value) || 0;
    norm += num * num;
  }
  if (norm <= 0) {
    return [];
  }
  const scale = Math.sqrt(norm);
  return vector.map((value) => Number((((Number(value) || 0) / scale)).toFixed(6)));
}

function buildHashedEmbedding(text) {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) {
    return [];
  }
  const tokens = extractSemanticTokens(normalized);

  const vector = new Array(VECTOR_DIMENSIONS).fill(0);
  for (const token of tokens) {
    const hash = hashToken(token);
    const idx = hash % VECTOR_DIMENSIONS;
    const signed = (hashToken(token, 1315423911) & 1) === 0 ? 1 : -1;
    const weight = Math.max(1, Math.min(4, Math.ceil(token.length / 4)));
    vector[idx] += signed * weight;
  }

  return normalizeVector(vector);
}

function buildAnnBucketKeys(vector, options) {
  if (!Array.isArray(vector) || vector.length === 0) {
    return [];
  }

  const opts = options && typeof options === "object" ? options : {};
  const expand = opts.expand === true;
  const maxProbePerBand = Math.max(0, Math.min(4, Math.floor(Number(opts.maxProbePerBand) || 0)));

  const dims = vector
    .map((value) => (Number.isFinite(Number(value)) ? Number(value) : 0))
    .slice(0, VECTOR_DIMENSIONS);
  if (dims.length === 0) {
    return [];
  }

  const keys = [];
  const bandCount = 4;
  const bandSize = Math.max(1, Math.floor(VECTOR_DIMENSIONS / bandCount));

  for (let band = 0; band < bandCount; band += 1) {
    const start = band * bandSize;
    const end = Math.min(start + bandSize, dims.length);
    if (start >= end) {
      continue;
    }
    let mask = 0;
    const bandEntries = [];
    for (let idx = start; idx < end; idx += 1) {
      const value = dims[idx];
      if (value >= 0) {
        mask |= (1 << (idx - start));
      }
      bandEntries.push({
        localIndex: idx - start,
        weight: Math.abs(value),
      });
    }
    keys.push(`s${band}:${mask.toString(16).padStart(4, "0")}`);
    if (expand && maxProbePerBand > 0) {
      bandEntries
        .sort((left, right) => right.weight - left.weight)
        .slice(0, maxProbePerBand)
        .forEach((entry) => {
          const probeMask = mask ^ (1 << entry.localIndex);
          keys.push(`s${band}:${probeMask.toString(16).padStart(4, "0")}`);
        });
    }
  }

  const topDims = dims
    .map((value, index) => ({ index, weight: Math.abs(value) }))
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 4)
    .map((entry) => entry.index);
  if (topDims.length > 0) {
    keys.push(`t:${topDims.join("-")}`);
  }

  const means = [];
  for (let band = 0; band < bandCount; band += 1) {
    const start = band * bandSize;
    const end = Math.min(start + bandSize, dims.length);
    if (start >= end) {
      continue;
    }
    let sum = 0;
    for (let idx = start; idx < end; idx += 1) {
      sum += dims[idx];
    }
    means.push(sum >= 0 ? "1" : "0");
  }
  if (means.length > 0) {
    keys.push(`m:${means.join("")}`);
  }

  return Array.from(new Set(keys.filter(Boolean)));
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || right.length === 0) {
    return 0;
  }
  const size = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < size; i += 1) {
    const a = Number(left[i]) || 0;
    const b = Number(right[i]) || 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm <= 0 || rightNorm <= 0) {
    return 0;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function tokenOverlapScore(queryTokens, candidateText) {
  const left = Array.isArray(queryTokens) ? queryTokens.filter(Boolean) : [];
  if (left.length === 0) {
    return 0;
  }
  const rightTokens = extractSemanticTokens(candidateText);
  if (rightTokens.length === 0) {
    return 0;
  }
  const right = new Set(rightTokens);
  let hits = 0;
  for (const token of left) {
    if (right.has(token)) {
      hits += 1;
    }
  }
  if (hits === 0) {
    return 0;
  }
  return hits / Math.sqrt(left.length * right.size);
}

function buildEmbeddingSource(params, layers) {
  const parts = [
    layers.l0,
    layers.l1,
    layers.l2,
    normalizeText(params.summary),
    normalizeText(params.details),
  ];
  if (Array.isArray(params.keywords) && params.keywords.length > 0) {
    parts.push(params.keywords.join(" "));
  }
  return normalizeText(parts.filter(Boolean).join(" "));
}

function computeContentHash(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return "";
  }
  return createHash("sha256").update(normalized).digest("hex");
}

function normalizeVectorBackendName(rawBackend) {
  const value = normalizeText(rawBackend).toLowerCase();
  if (!value) {
    return "hash-vec";
  }
  if (value === "hash" || value === "hash-vec" || value === "runtime-hash") {
    return "hash-vec";
  }
  if (value === "sqlite-vec") {
    return "sqlite-vec";
  }
  if (value === "ann-local" || value === "ann" || value === "hnsw") {
    return "ann-local";
  }
  if (value === "disabled" || value === "none" || value === "off") {
    return "disabled";
  }
  return value;
}

function normalizeEmbeddingMode(rawMode) {
  const value = normalizeText(rawMode).toLowerCase();
  if (!value) {
    return "hash";
  }
  if (value === "hash" || value === "hash-vec" || value === "runtime-hash") {
    return "hash";
  }
  if (value === "openai" || value === "openai-compatible" || value === "embedding-api") {
    return "openai-compatible";
  }
  return "hash";
}

function createVectorBackend(api, cfg) {
  const requestedBackend = normalizeVectorBackendName(cfg?.store?.vector?.backend);
  const isEnabled = cfg?.store?.vector?.enabled !== false && requestedBackend !== "disabled";
  const candidateLimit = Math.max(
    8,
    Math.min(256, Math.floor(Number(cfg?.store?.vector?.candidateLimit) || 48)),
  );
  const extensionPath = normalizeText(resolveConfiguredPath(api, cfg?.store?.vector?.extensionPath || ""));
  const embeddingCfg = cfg?.store?.vector?.embedding && typeof cfg.store.vector.embedding === "object"
    ? cfg.store.vector.embedding
    : DEFAULT_CONFIG.store.vector.embedding;
  const configuredEmbeddingDimensions = Math.max(0, Math.floor(Number(embeddingCfg.dimensions) || 0));
  const embeddingState = {
    mode: normalizeEmbeddingMode(embeddingCfg.mode),
    fallbackToHash: embeddingCfg.fallbackToHash !== false,
    configuredDimensions: configuredEmbeddingDimensions,
    observedDimensions: 0,
    warnedMissingConfig: false,
    warnedMissingKey: false,
    warnedCurlFailure: false,
    warnedResponseFailure: false,
    requestCount: 0,
    successCount: 0,
    fallbackCount: 0,
    lastError: "",
    cache: new Map(),
    cacheLimit: 2048,
  };
  const nativeState = {
    checked: false,
    ready: false,
    mode: "runtime-hash",
    error: "",
  };
  const annState = {
    checked: false,
    ready: false,
    error: "",
    bucketRows: 0,
    probePerBand: Math.max(0, Math.min(4, Math.floor(Number(cfg?.store?.vector?.probePerBand) || 1))),
  };

  function resolveEmbeddingApiKey() {
    if (embeddingCfg.apiKey) {
      return embeddingCfg.apiKey;
    }
    if (embeddingCfg.apiKeyEnv && process.env[embeddingCfg.apiKeyEnv]) {
      return String(process.env[embeddingCfg.apiKeyEnv]);
    }
    return "";
  }

  function rememberEmbeddingCache(key, vector) {
    if (!key || !Array.isArray(vector) || vector.length === 0) {
      return;
    }
    if (embeddingState.cache.size >= embeddingState.cacheLimit) {
      const firstKey = embeddingState.cache.keys().next().value;
      if (firstKey) {
        embeddingState.cache.delete(firstKey);
      }
    }
    embeddingState.cache.set(key, vector);
  }

  function getCachedEmbedding(key) {
    if (!key) {
      return null;
    }
    const value = embeddingState.cache.get(key);
    if (!Array.isArray(value) || value.length === 0) {
      return null;
    }
    return value;
  }

  function logEmbeddingWarning(type, extra) {
    const logger = api && api.logger;
    if (!logger || typeof logger.warn !== "function") {
      return;
    }
    const payload = extra && typeof extra === "object" ? extra : {};
    logger.warn(`memory-hybrid-context: embedding fallback (${type})`, payload);
  }

  function buildEmbeddingCacheKey(normalizedText) {
    const digestSource = [
      embeddingState.mode,
      normalizeText(embeddingCfg.baseURL).toLowerCase(),
      normalizeText(embeddingCfg.model).toLowerCase(),
      String(Math.max(0, Number(embeddingCfg.dimensions) || 0)),
      normalizedText,
    ].join("|");
    return createHash("sha1").update(digestSource).digest("hex");
  }

  function buildFallbackEmbedding(normalizedText) {
    embeddingState.fallbackCount += 1;
    if (embeddingState.fallbackToHash) {
      const vector = buildHashedEmbedding(normalizedText);
      embeddingState.observedDimensions = vector.length;
      return vector;
    }
    return [];
  }

  function embedTextWithProvider(text) {
    const normalized = normalizeText(text);
    if (!normalized) {
      return [];
    }
    const cacheKey = buildEmbeddingCacheKey(normalized);
    const cached = getCachedEmbedding(cacheKey);
    if (cached) {
      return cached;
    }

    if (embeddingState.mode !== "openai-compatible") {
      const vector = buildHashedEmbedding(normalized);
      embeddingState.observedDimensions = vector.length;
      rememberEmbeddingCache(cacheKey, vector);
      return vector;
    }

    if (!embeddingCfg.baseURL || !embeddingCfg.model) {
      if (!embeddingState.warnedMissingConfig) {
        embeddingState.warnedMissingConfig = true;
        logEmbeddingWarning("missing_config", {
          mode: embeddingState.mode,
          baseURL: embeddingCfg.baseURL || "",
          model: embeddingCfg.model || "",
        });
      }
      return buildFallbackEmbedding(normalized);
    }

    const apiKey = resolveEmbeddingApiKey();
    if (!apiKey) {
      if (!embeddingState.warnedMissingKey) {
        embeddingState.warnedMissingKey = true;
        logEmbeddingWarning("missing_api_key", {
          mode: embeddingState.mode,
          apiKeyEnv: embeddingCfg.apiKeyEnv || "",
        });
      }
      return buildFallbackEmbedding(normalized);
    }

    const base = embeddingCfg.baseURL.replace(/\/+$/, "");
    const endpoint = `${base}/embeddings`;
    const payload = {
      model: embeddingCfg.model,
      input: normalized,
    };
    if (Number(embeddingCfg.dimensions) > 0) {
      payload.dimensions = Number(embeddingCfg.dimensions);
    }

    const args = [
      "-sS",
      "-X",
      "POST",
      endpoint,
      "-H",
      "Content-Type: application/json",
      "-H",
      `Authorization: Bearer ${apiKey}`,
      "--max-time",
      String(Math.max(1, Math.floor(Number(embeddingCfg.timeoutMs) / 1000))),
      "--connect-timeout",
      "5",
      "-d",
      asJson(payload, {}),
    ];

    try {
      embeddingState.requestCount += 1;
      const raw = execFileSync("curl", args, {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      });
      const parsed = parseJson(raw, {});
      const vector = normalizeVector(
        Array.isArray(parsed?.data) && parsed.data[0] && Array.isArray(parsed.data[0].embedding)
          ? parsed.data[0].embedding
          : [],
      );
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error("invalid_embedding_response");
      }
      embeddingState.lastError = "";
      embeddingState.successCount += 1;
      embeddingState.observedDimensions = vector.length;
      rememberEmbeddingCache(cacheKey, vector);
      return vector;
    } catch (err) {
      const message = clipText(String(err && err.message ? err.message : err), 240);
      embeddingState.lastError = message;
      const errorType = /invalid_embedding_response/i.test(message) ? "response_error" : "request_error";
      if (errorType === "response_error" && !embeddingState.warnedResponseFailure) {
        embeddingState.warnedResponseFailure = true;
        logEmbeddingWarning("invalid_response", { error: message });
      }
      if (errorType === "request_error" && !embeddingState.warnedCurlFailure) {
        embeddingState.warnedCurlFailure = true;
        logEmbeddingWarning("request_failed", { error: message });
      }
      return buildFallbackEmbedding(normalized);
    }
  }

  const hashBackend = {
    info() {
      return {
        enabled: isEnabled,
        backend: requestedBackend,
        mode: nativeState.ready ? nativeState.mode : (nativeState.checked ? "runtime-hash-fallback" : "runtime-hash"),
        dimensions: VECTOR_DIMENSIONS,
        candidateLimit,
        extensionPath: extensionPath || "",
        nativeReady: nativeState.ready,
        nativeError: nativeState.error || "",
        embeddingMode: embeddingState.mode,
        embeddingFallbackToHash: embeddingState.fallbackToHash,
        embeddingDimensions:
          embeddingState.observedDimensions || embeddingState.configuredDimensions || (embeddingState.mode === "hash" ? VECTOR_DIMENSIONS : 0),
        embeddingModel: embeddingCfg.model || "",
        embeddingBaseURL: embeddingCfg.baseURL || "",
        embeddingLastError: embeddingState.lastError || "",
        embeddingRequestCount: embeddingState.requestCount,
        embeddingSuccessCount: embeddingState.successCount,
        embeddingFallbackCount: embeddingState.fallbackCount,
        embeddingCacheSize: embeddingState.cache.size,
      };
    },
    attach(conn, logger) {
      if (!isEnabled || requestedBackend !== "sqlite-vec" || nativeState.checked) {
        return;
      }
      nativeState.checked = true;
      if (!extensionPath) {
        nativeState.error = "missing_extension_path";
        return;
      }
      try {
        conn.enableLoadExtension(true);
        conn.loadExtension(extensionPath);
        conn.enableLoadExtension(false);
        conn.exec(
          `CREATE TABLE IF NOT EXISTS memory_vector_blobs (
             record_id TEXT PRIMARY KEY,
             embedding BLOB NOT NULL,
             updated_at INTEGER NOT NULL,
             FOREIGN KEY (record_id) REFERENCES memory_records(id) ON DELETE CASCADE
           )`,
        );
        conn.exec("CREATE INDEX IF NOT EXISTS idx_memory_vector_updated_at ON memory_vector_blobs(updated_at DESC)");
        nativeState.ready = true;
        nativeState.mode = "sqlite-vec-func";
        nativeState.error = "";
        if (typeof logger === "function") {
          logger("memory-hybrid-context: sqlite-vec native backend attached", {
            extensionPath,
          });
        }
      } catch (err) {
        nativeState.ready = false;
        nativeState.mode = "runtime-hash-fallback";
        nativeState.error = clipText(String(err && err.message ? err.message : err), 240);
        if (typeof logger === "function") {
          logger("memory-hybrid-context: sqlite-vec native attach failed", {
            extensionPath,
            error: nativeState.error,
          });
        }
      }
    },
    buildRecordEmbedding(params, layers) {
      if (!isEnabled) {
        return [];
      }
      return this.buildTextEmbedding(buildEmbeddingSource(params, layers));
    },
    buildTextEmbedding(text) {
      if (!isEnabled) {
        return [];
      }
      return embedTextWithProvider(text);
    },
    toNativeBlob(conn, vector) {
      if (!nativeState.ready || !Array.isArray(vector) || vector.length === 0) {
        return null;
      }
      const json = asJson(vector, []);
      const row = conn.prepare("SELECT vec_f32(?) AS v").get(json);
      return row ? row.v : null;
    },
    upsertNativeEmbedding(conn, recordId, vector, updatedAt) {
      if (!nativeState.ready) {
        return false;
      }
      const blob = this.toNativeBlob(conn, vector);
      if (!blob) {
        return false;
      }
      conn
        .prepare(
          `INSERT INTO memory_vector_blobs (record_id, embedding, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(record_id) DO UPDATE SET
             embedding = excluded.embedding,
             updated_at = excluded.updated_at`,
        )
        .run(recordId, blob, updatedAt || Date.now());
      return true;
    },
    deleteNativeEmbedding(conn, recordId) {
      if (!nativeState.ready) {
        return;
      }
      conn
        .prepare("DELETE FROM memory_vector_blobs WHERE record_id = ?")
        .run(recordId);
    },
    search(params) {
      if (!isEnabled) {
        return [];
      }
      const queryText = normalizeText(params.query);
      if (!queryText) {
        return [];
      }

      const queryVector = this.buildTextEmbedding(queryText);
      const queryTokens = extractSemanticTokens(queryText);
      if (queryVector.length === 0) {
        return [];
      }

      if (nativeState.ready) {
        try {
          const queryJson = asJson(queryVector, []);
          const rows = params.conn
            .prepare(
              `SELECT ${params.selectColumns},
                      vec_distance_cosine(vb.embedding, vec_f32(?)) AS distance
                 FROM memory_vector_blobs vb
                 JOIN memory_records r ON r.id = vb.record_id
                WHERE 1 = 1${params.whereClause}
                ORDER BY distance ASC, r.updated_at DESC
                LIMIT ?`,
            )
            .all(queryJson, ...params.values, params.limit);

          return rows.map((row) =>
            params.rowToResult(
              row,
              Number.isFinite(row.distance) ? 1 / (1 + Math.max(0, row.distance)) : 0.5,
            ),
          );
        } catch (_err) {
          // Fall through to hash fallback on any native query issue.
        }
      }

      const candidateRows = params.conn
        .prepare(
          `SELECT ${params.selectColumns}, r.embedding_json, r.raw_text
             FROM memory_records r
            WHERE 1 = 1${params.whereClause}
            ORDER BY COALESCE(r.last_used_at, r.updated_at) DESC
            LIMIT ?`,
        )
        .all(...params.values, Math.max(params.limit * 6, candidateLimit));

      const rows = [];
      for (const row of candidateRows) {
        let candidateVector = parseJson(row.embedding_json, []);
        if (!Array.isArray(candidateVector) || candidateVector.length === 0) {
          candidateVector = embedTextWithProvider(
            normalizeText([
              row.l0_text,
              row.l1_text,
              row.l2_text,
              row.summary,
              row.raw_text,
            ].filter(Boolean).join(" ")),
          );
        }
        const candidateText = normalizeText([
          row.l0_text,
          row.l1_text,
          row.l2_text,
          row.summary,
          row.raw_text,
        ].filter(Boolean).join(" "));
        const cosine = Math.max(0, cosineSimilarity(queryVector, candidateVector));
        const overlap = tokenOverlapScore(queryTokens, candidateText);
        const similarity =
          overlap > 0
            ? overlap * 0.7 + cosine * 0.3
            : cosine * 0.35;
        if (similarity <= 0) {
          continue;
        }
        rows.push(params.rowToResult(row, similarity));
      }

      rows.sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return (right.updatedAt || 0) - (left.updatedAt || 0);
      });
      return rows.slice(0, params.limit);
    },
    getStats(conn, params = {}) {
      if (!isEnabled) {
        return {
          backend: requestedBackend,
          mode: "disabled",
        };
      }
      const agentId = normalizeAgentId(params.agentId);
      let nativeRows = 0;
      if (nativeState.ready) {
        try {
          const row = agentId
            ? conn
                .prepare(
                  `SELECT COUNT(*) AS total
                     FROM memory_vector_blobs vb
                     JOIN memory_records r ON r.id = vb.record_id
                    WHERE r.agent_id = ?`,
                )
                .get(agentId)
            : conn.prepare("SELECT COUNT(*) AS total FROM memory_vector_blobs").get();
          nativeRows = Number(row && row.total) || 0;
        } catch (_err) {
          nativeRows = 0;
        }
      }
      return {
        backend: requestedBackend,
        mode: this.info().mode,
        nativeRows,
        embeddingMode: embeddingState.mode,
        embeddingFallbackToHash: embeddingState.fallbackToHash,
        embeddingDimensions:
          embeddingState.observedDimensions || embeddingState.configuredDimensions || (embeddingState.mode === "hash" ? VECTOR_DIMENSIONS : 0),
        embeddingModel: embeddingCfg.model || "",
        embeddingBaseURL: embeddingCfg.baseURL || "",
        embeddingLastError: embeddingState.lastError || "",
        embeddingRequestCount: embeddingState.requestCount,
        embeddingSuccessCount: embeddingState.successCount,
        embeddingFallbackCount: embeddingState.fallbackCount,
        embeddingCacheSize: embeddingState.cache.size,
      };
    },
  };

  const annLocalBackend = {
    info() {
      return {
        enabled: isEnabled,
        backend: requestedBackend,
        mode: annState.ready ? "ann-local-lsh" : (annState.checked ? "ann-local-fallback" : "ann-local-lsh"),
        dimensions: VECTOR_DIMENSIONS,
        candidateLimit,
        extensionPath: "",
        nativeReady: annState.ready,
        nativeError: annState.error || "",
        bucketRows: annState.bucketRows,
        probePerBand: annState.probePerBand,
        embeddingMode: embeddingState.mode,
        embeddingFallbackToHash: embeddingState.fallbackToHash,
        embeddingDimensions:
          embeddingState.observedDimensions || embeddingState.configuredDimensions || (embeddingState.mode === "hash" ? VECTOR_DIMENSIONS : 0),
        embeddingModel: embeddingCfg.model || "",
        embeddingBaseURL: embeddingCfg.baseURL || "",
        embeddingLastError: embeddingState.lastError || "",
        embeddingRequestCount: embeddingState.requestCount,
        embeddingSuccessCount: embeddingState.successCount,
        embeddingFallbackCount: embeddingState.fallbackCount,
        embeddingCacheSize: embeddingState.cache.size,
      };
    },
    attach(conn, logger) {
      if (!isEnabled || requestedBackend !== "ann-local" || annState.checked) {
        return;
      }
      annState.checked = true;
      try {
        conn.exec(
          `CREATE TABLE IF NOT EXISTS memory_ann_buckets (
             record_id TEXT NOT NULL,
             bucket_key TEXT NOT NULL,
             updated_at INTEGER NOT NULL,
             PRIMARY KEY (record_id, bucket_key),
             FOREIGN KEY (record_id) REFERENCES memory_records(id) ON DELETE CASCADE
           )`,
        );
        conn.exec("CREATE INDEX IF NOT EXISTS idx_memory_ann_bucket_key ON memory_ann_buckets(bucket_key, updated_at DESC)");
        conn.exec("CREATE INDEX IF NOT EXISTS idx_memory_ann_record_id ON memory_ann_buckets(record_id)");
        const row = conn.prepare("SELECT COUNT(*) AS total FROM memory_ann_buckets").get();
        annState.bucketRows = Number(row && row.total) || 0;
        annState.ready = true;
        annState.error = "";
        if (typeof logger === "function") {
          logger("memory-hybrid-context: ann-local lsh backend attached", {
            bucketRows: annState.bucketRows,
          });
        }
      } catch (err) {
        annState.ready = false;
        annState.error = clipText(String(err && err.message ? err.message : err), 240);
        if (typeof logger === "function") {
          logger("memory-hybrid-context: ann-local attach failed", {
            error: annState.error,
          });
        }
      }
    },
    buildRecordEmbedding(params, layers) {
      if (!isEnabled) {
        return [];
      }
      return this.buildTextEmbedding(buildEmbeddingSource(params, layers));
    },
    buildTextEmbedding(text) {
      if (!isEnabled) {
        return [];
      }
      return embedTextWithProvider(text);
    },
    toNativeBlob() {
      return null;
    },
    upsertNativeEmbedding(conn, recordId, vector, updatedAt) {
      if (!isEnabled || !annState.ready) {
        return false;
      }
      const current = conn.prepare("SELECT COUNT(*) AS total FROM memory_ann_buckets WHERE record_id = ?").get(recordId);
      const removed = Number(current && current.total) || 0;
      conn.prepare("DELETE FROM memory_ann_buckets WHERE record_id = ?").run(recordId);
      const keys = buildAnnBucketKeys(vector);
      if (keys.length === 0) {
        annState.bucketRows = Math.max(0, annState.bucketRows - removed);
        return false;
      }
      const stmt = conn.prepare(
        `INSERT INTO memory_ann_buckets (record_id, bucket_key, updated_at)
         VALUES (?, ?, ?)`,
      );
      const ts = updatedAt || Date.now();
      for (const key of keys) {
        stmt.run(recordId, key, ts);
      }
      annState.bucketRows = Math.max(0, annState.bucketRows - removed) + keys.length;
      return true;
    },
    deleteNativeEmbedding(conn, recordId) {
      if (!annState.ready) {
        return;
      }
      const current = conn.prepare("SELECT COUNT(*) AS total FROM memory_ann_buckets WHERE record_id = ?").get(recordId);
      const removed = Number(current && current.total) || 0;
      conn.prepare("DELETE FROM memory_ann_buckets WHERE record_id = ?").run(recordId);
      annState.bucketRows = Math.max(0, annState.bucketRows - removed);
    },
    search(params) {
      if (!isEnabled) {
        return [];
      }
      const queryText = normalizeText(params.query);
      if (!queryText) {
        return [];
      }

      const queryVector = this.buildTextEmbedding(queryText);
      const queryTokens = extractSemanticTokens(queryText);
      if (queryVector.length === 0) {
        return [];
      }

      let candidateRows = [];
      if (annState.ready) {
        const bucketKeys = buildAnnBucketKeys(queryVector, {
          expand: true,
          maxProbePerBand: annState.probePerBand,
        });
        if (bucketKeys.length > 0) {
          const placeholders = bucketKeys.map(() => "?").join(", ");
          candidateRows = params.conn
            .prepare(
              `SELECT ${params.selectColumns}, r.embedding_json, r.raw_text,
                      COUNT(DISTINCT ab.bucket_key) AS bucket_hits
                 FROM memory_ann_buckets ab
                 JOIN memory_records r ON r.id = ab.record_id
                WHERE ab.bucket_key IN (${placeholders})${params.whereClause}
                GROUP BY r.id
                ORDER BY bucket_hits DESC, COALESCE(r.last_used_at, r.updated_at) DESC
                LIMIT ?`,
            )
            .all(...bucketKeys, ...params.values, Math.max(params.limit * 8, candidateLimit));
        }
      }

      if (candidateRows.length === 0) {
        candidateRows = params.conn
          .prepare(
            `SELECT ${params.selectColumns}, r.embedding_json, r.raw_text, 0 AS bucket_hits
               FROM memory_records r
              WHERE 1 = 1${params.whereClause}
                AND r.embedding_json IS NOT NULL
                AND LENGTH(r.embedding_json) > 2
              ORDER BY COALESCE(r.last_used_at, r.updated_at) DESC
              LIMIT ?`,
          )
          .all(...params.values, Math.max(params.limit * 6, candidateLimit));
      }

      const rows = [];
      for (const row of candidateRows) {
        let candidateVector = parseJson(row.embedding_json, []);
        if (!Array.isArray(candidateVector) || candidateVector.length === 0) {
          candidateVector = embedTextWithProvider(
            normalizeText([
              row.l0_text,
              row.l1_text,
              row.l2_text,
              row.summary,
              row.raw_text,
            ].filter(Boolean).join(" ")),
          );
        }
        const candidateText = normalizeText([
          row.l0_text,
          row.l1_text,
          row.l2_text,
          row.summary,
          row.raw_text,
        ].filter(Boolean).join(" "));
        const cosine = Math.max(0, cosineSimilarity(queryVector, candidateVector));
        const overlap = tokenOverlapScore(queryTokens, candidateText);
        const bucketHits = Math.max(0, Number(row.bucket_hits) || 0);
        const bucketScore = Math.max(0, Math.min(1, bucketHits / 6));
        const similarity =
          overlap > 0
            ? bucketScore * 0.35 + cosine * 0.35 + overlap * 0.3
            : bucketScore * 0.55 + cosine * 0.45;
        if (similarity <= 0) {
          continue;
        }
        rows.push(params.rowToResult(row, similarity));
      }

      rows.sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return (right.updatedAt || 0) - (left.updatedAt || 0);
      });
      return rows.slice(0, params.limit);
    },
    getStats(conn, params = {}) {
      if (!isEnabled) {
        return {
          backend: requestedBackend,
          mode: "disabled",
        };
      }
      const agentId = normalizeAgentId(params.agentId);
      const summaryRow = agentId
        ? conn
            .prepare(
              `SELECT COUNT(*) AS bucket_rows,
                      COUNT(DISTINCT ab.bucket_key) AS unique_buckets,
                      COUNT(DISTINCT ab.record_id) AS indexed_records
                 FROM memory_ann_buckets ab
                 JOIN memory_records r ON r.id = ab.record_id
                WHERE r.agent_id = ?`,
            )
            .get(agentId)
        : conn
            .prepare(
              `SELECT COUNT(*) AS bucket_rows,
                      COUNT(DISTINCT bucket_key) AS unique_buckets,
                      COUNT(DISTINCT record_id) AS indexed_records
                 FROM memory_ann_buckets`,
            )
            .get();
      const bucketRows = Number(summaryRow && summaryRow.bucket_rows) || 0;
      const uniqueBuckets = Number(summaryRow && summaryRow.unique_buckets) || 0;
      const indexedRecords = Number(summaryRow && summaryRow.indexed_records) || 0;
      const avgBucketsPerRecord =
        indexedRecords > 0 ? Number((bucketRows / indexedRecords).toFixed(2)) : 0;
      const hottestBuckets = agentId
        ? conn
            .prepare(
              `SELECT ab.bucket_key AS bucketKey, COUNT(*) AS recordCount
                 FROM memory_ann_buckets ab
                 JOIN memory_records r ON r.id = ab.record_id
                WHERE r.agent_id = ?
                GROUP BY ab.bucket_key
                ORDER BY recordCount DESC, bucketKey ASC
                LIMIT 8`,
            )
            .all(agentId)
        : conn
            .prepare(
              `SELECT bucket_key AS bucketKey, COUNT(*) AS recordCount
                 FROM memory_ann_buckets
                GROUP BY bucket_key
                ORDER BY recordCount DESC, bucketKey ASC
                LIMIT 8`,
            )
            .all();
      return {
        backend: requestedBackend,
        mode: this.info().mode,
        bucketRows,
        uniqueBuckets,
        indexedRecords,
        avgBucketsPerRecord,
        probePerBand: annState.probePerBand,
        approxQueryBuckets: buildAnnBucketKeys(new Array(VECTOR_DIMENSIONS).fill(1), {
          expand: true,
          maxProbePerBand: annState.probePerBand,
        }).length,
        hottestBuckets: Array.isArray(hottestBuckets) ? hottestBuckets : [],
        embeddingMode: embeddingState.mode,
        embeddingFallbackToHash: embeddingState.fallbackToHash,
        embeddingDimensions:
          embeddingState.observedDimensions || embeddingState.configuredDimensions || (embeddingState.mode === "hash" ? VECTOR_DIMENSIONS : 0),
        embeddingModel: embeddingCfg.model || "",
        embeddingBaseURL: embeddingCfg.baseURL || "",
        embeddingLastError: embeddingState.lastError || "",
        embeddingRequestCount: embeddingState.requestCount,
        embeddingSuccessCount: embeddingState.successCount,
        embeddingFallbackCount: embeddingState.fallbackCount,
        embeddingCacheSize: embeddingState.cache.size,
      };
    },
  };

  if (!isEnabled) {
    return {
      info() {
        return {
          enabled: false,
          backend: requestedBackend,
          mode: "disabled",
          dimensions: 0,
          candidateLimit: 0,
          embeddingMode: "disabled",
        };
      },
      attach() {},
      buildRecordEmbedding() {
        return [];
      },
      buildTextEmbedding() {
        return [];
      },
      toNativeBlob() {
        return null;
      },
      upsertNativeEmbedding() {
        return false;
      },
      deleteNativeEmbedding() {},
      search() {
        return [];
      },
      getStats() {
        return {
          backend: requestedBackend,
          mode: "disabled",
        };
      },
    };
  }

  if (requestedBackend === "hash-vec" || requestedBackend === "sqlite-vec" || requestedBackend === "ann-local") {
    if (requestedBackend === "ann-local") {
      return annLocalBackend;
    }
    return hashBackend;
  }

  return {
    ...hashBackend,
    info() {
      const info = hashBackend.info();
      return {
        ...info,
        mode: "runtime-hash-fallback",
      };
    },
  };
}

function asJson(value, fallback) {
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return JSON.stringify(fallback);
  }
}

function detectCandidateType(text) {
  const lower = normalizeText(text).toLowerCase();
  if (!lower) {
    return "other";
  }
  if (/(喜欢|偏好|习惯|prefer|like|love|hate|want)/i.test(lower)) {
    return "preference";
  }
  if (/(决定|改用|以后用|decided|will use|always|never|important)/i.test(lower)) {
    return "decision";
  }
  if (/(todo|待办|稍后|明天|记得|follow up)/i.test(lower)) {
    return "todo";
  }
  if (/(项目|project|仓库|repo|服务|service)/i.test(lower)) {
    return "entity";
  }
  if (/(是|有|使用|版本|地址|叫做|is |has |using )/i.test(lower)) {
    return "event";
  }
  return "other";
}

function sanitizeIncomingMemoryText(text) {
  let normalized = normalizeText(text);
  if (!normalized) {
    return "";
  }

  normalized = normalized
    .replace(/<memory-hybrid-context>[\s\S]*?<\/memory-hybrid-context>/gi, " ")
    .replace(/Sender\s*\(untrusted metadata\)\s*:\s*```[\s\S]*?```/gi, " ")
    .replace(/Sender\s*\(untrusted metadata\)\s*:\s*\{[\s\S]*?\}/gi, " ")
    .replace(/^\[[^\]]+\]\s*/u, " ");

  return normalizeText(normalized);
}

function shouldStageText(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }
  if (normalized.length < 8 || normalized.length > 800) {
    return false;
  }
  if (normalized.startsWith("/")) {
    return false;
  }
  if (/^(hi|hello|thanks|ok|好的|收到|嗯嗯)$/i.test(normalized)) {
    return false;
  }
  if (/^(heartbeat|ping)$/i.test(normalized)) {
    return false;
  }
  if (/<memory-hybrid-context>[\s\S]*<\/memory-hybrid-context>/i.test(normalized)) {
    return false;
  }
  if (/Sender\s*\(untrusted metadata\)\s*:/i.test(normalized)) {
    return false;
  }
  if (/<\s*(system|assistant|developer|tool)\b/i.test(normalized)) {
    return false;
  }
  if (
    /[?？]\s*$/.test(normalized) ||
    /^(你还记得|请问|what\b|how\b|why\b|where\b|when\b)/i.test(normalized) ||
    /(是什么|什么是|怎么|怎么办|为什么|哪里|在哪|多少|谁是|吗[？?]?)/u.test(normalized)
  ) {
    return false;
  }
  return true;
}

function extractTextBlocksFromMessages(messages, captureAssistant) {
  if (!Array.isArray(messages)) {
    return [];
  }

  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }

    const role = typeof msg.role === "string" ? msg.role : "";
    if (role !== "user" && !(captureAssistant && role === "assistant")) {
      continue;
    }

    const content = msg.content;
    if (typeof content === "string") {
      out.push({ role, text: content });
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string"
      ) {
        out.push({ role, text: block.text });
      }
    }
  }

  return out;
}

function selectRecentTextBlocks(items, limit) {
  const list = Array.isArray(items) ? items : [];
  const max = Math.max(1, Math.floor(Number(limit) || 1));
  if (list.length <= max) {
    return list;
  }
  return list.slice(-max);
}

function normalizeRecallLevel(level) {
  const raw = normalizeText(level).toUpperCase();
  if (raw === "L0" || raw === "L1" || raw === "L2") {
    return raw;
  }
  return "L1";
}

function packRecallContext(records, maxChars, maxLevel) {
  if (!Array.isArray(records) || records.length === 0) {
    return {
      text: "",
      selectedIds: [],
      usedLevel: "L0",
      itemCount: 0,
    };
  }

  const level = normalizeRecallLevel(maxLevel);
  const openTag = "<memory-hybrid-context>";
  const closeTag = "</memory-hybrid-context>";
  const header = `Use the following recalled memories as historical context only. MaxLevel=${level}.`;
  const minimumChars = openTag.length + 1 + header.length + 1 + closeTag.length;
  const budget = Math.max(minimumChars + 24, Math.floor(Number(maxChars) || 0));
  const candidates = [];

  for (const entry of records) {
    const baseText = normalizeText(entry.l0Text || entry.title);
    if (!baseText) {
      continue;
    }
    candidates.push({
      id: entry.id,
      type: entry.type,
      base: baseText,
      l1: normalizeText(entry.l1Text || entry.summary),
      l2: normalizeText(entry.l2Text || entry.contentRef),
    });
  }

  if (candidates.length === 0) {
    return {
      text: "",
      selectedIds: [],
      usedLevel: "L0",
      itemCount: 0,
    };
  }

  const prefixLength = (type) => `- [${type}] `.length;
  const selected = [];
  let used = minimumChars;

  for (const item of candidates) {
    const baseLineLength = prefixLength(item.type) + item.base.length + 1;
    if (selected.length > 0 && used + baseLineLength > budget) {
      break;
    }
    if (selected.length === 0 && used + baseLineLength > budget) {
      const clippedBase = clipText(item.base, Math.max(16, budget - used - prefixLength(item.type) - 4));
      if (!clippedBase) {
        break;
      }
      selected.push({
        ...item,
        base: clippedBase,
        includeL1: false,
        includeL2: false,
      });
      used += prefixLength(item.type) + clippedBase.length + 1;
      break;
    }
    selected.push({
      ...item,
      includeL1: false,
      includeL2: false,
    });
    used += baseLineLength;
  }

  if (selected.length === 0) {
    return {
      text: "",
      selectedIds: [],
      usedLevel: "L0",
      itemCount: 0,
    };
  }

  let usedLevel = "L0";

  if (level === "L1" || level === "L2") {
    for (const item of selected) {
      if (!item.l1) {
        continue;
      }
      const addition = ` | ${item.l1}`;
      if (used + addition.length > budget) {
        continue;
      }
      item.includeL1 = true;
      used += addition.length;
      usedLevel = "L1";
    }
  }

  if (level === "L2") {
    for (const item of selected) {
      if (!item.l2) {
        continue;
      }
      const addition = ` | ${item.l2}`;
      if (used + addition.length > budget) {
        continue;
      }
      item.includeL2 = true;
      used += addition.length;
      usedLevel = "L2";
    }
  }

  const lines = [openTag, `${header} UsedLevel=${usedLevel}.`];
  for (const item of selected) {
    let body = item.base;
    if (item.includeL1) {
      body += ` | ${item.l1}`;
    }
    if (item.includeL2) {
      body += ` | ${item.l2}`;
    }
    lines.push(`- [${item.type}] ${body}`);
  }
  lines.push(closeTag);

  return {
    text: lines.join("\n"),
    selectedIds: selected.map((item) => item.id),
    usedLevel,
    itemCount: selected.length,
  };
}

function trimTerminalPunctuation(text) {
  return normalizeText(text).replace(/[。！？!?,，；;：:、.\s]+$/g, "");
}

function pickFirstClause(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return "";
  }
  const parts = normalized.split(/(?<=[。！？!?.；;])/u);
  return trimTerminalPunctuation(parts[0] || normalized);
}

function stripLeadByType(text, memoryType) {
  const normalized = normalizeText(text);
  const type = normalizeText(memoryType).toLowerCase();
  if (!normalized) {
    return "";
  }

  const apply = (patterns) => {
    let out = normalized;
    for (const pattern of patterns) {
      out = out.replace(pattern, "");
    }
    return trimTerminalPunctuation(out) || trimTerminalPunctuation(normalized);
  };

  if (type === "preference" || type === "profile") {
    return apply([
      /^(我(们)?)(比较)?(更)?(喜欢|偏好|习惯|希望|想要|通常|一般|默认)\s*/u,
      /^(请)?(默认|以后默认|保持|继续保持)\s*/u,
      /^(用|采用|使用|先|以)\s*/u,
    ]);
  }

  if (type === "decision") {
    return apply([
      /^(这个项目|当前项目|项目|我们|目前|后续)\s*/u,
      /^(决定|改用|改为|继续使用|继续沿用|继续|沿用|采用|使用)\s*/u,
    ]);
  }

  if (type === "todo") {
    return apply([
      /^(待办|稍后|后续|记得|需要)\s*/u,
    ]);
  }

  if (type === "entity") {
    return apply([
      /^(这个项目|项目|仓库|服务)\s*/u,
    ]);
  }

  if (type === "event") {
    return apply([
      /^(目前|当前|现在)\s*/u,
    ]);
  }

  return trimTerminalPunctuation(normalized);
}

function autoLayerTexts(params) {
  const type = normalizeText(params.type).toLowerCase();
  const source = normalizeText(params.details || params.summary || params.l2Text);
  const base = stripLeadByType(source, type) || pickFirstClause(source);
  const firstClause = pickFirstClause(base || source);

  if (type === "preference" || type === "profile") {
    const topic = clipText(firstClause || base || source, 26);
    return {
      l0: clipText(`偏好: ${topic}`, 80),
      l1: clipText(`用户偏好${base || source}`, 160),
    };
  }

  if (type === "decision") {
    const topic = clipText(firstClause || base || source, 30);
    return {
      l0: clipText(`决策: ${topic}`, 80),
      l1: clipText(`当前决策：${base || source}`, 180),
    };
  }

  if (type === "todo") {
    const topic = clipText(firstClause || base || source, 28);
    return {
      l0: clipText(`待办: ${topic}`, 80),
      l1: clipText(`待处理事项：${base || source}`, 180),
    };
  }

  if (type === "entity") {
    const topic = clipText(firstClause || base || source, 30);
    return {
      l0: clipText(`实体: ${topic}`, 80),
      l1: clipText(`项目实体信息：${base || source}`, 180),
    };
  }

  if (type === "event") {
    const topic = clipText(firstClause || base || source, 30);
    return {
      l0: clipText(`事件: ${topic}`, 80),
      l1: clipText(`近期事件：${base || source}`, 180),
    };
  }

  if (type === "pattern") {
    const topic = clipText(firstClause || base || source, 30);
    return {
      l0: clipText(`模式: ${topic}`, 80),
      l1: clipText(`可复用模式：${base || source}`, 180),
    };
  }

  if (type === "case") {
    const topic = clipText(firstClause || base || source, 30);
    return {
      l0: clipText(`案例: ${topic}`, 80),
      l1: clipText(`经验案例：${base || source}`, 180),
    };
  }

  return {
    l0: clipText(firstClause || base || source, 80),
    l1: clipText(base || source, 180),
  };
}

function buildLayerTexts(params) {
  const explicitL2 = normalizeText(params.l2Text);
  const explicitL1 = clipText(normalizeText(params.l1Text), 500);
  const explicitL0 = clipText(normalizeText(params.l0Text), 80);
  const autoLayers = autoLayerTexts(params);
  const baseSummary = clipText(normalizeText(params.summary), 500);
  const l1 = explicitL1 || autoLayers.l1 || baseSummary || clipText(explicitL2, 500);
  const l0 = explicitL0 || autoLayers.l0 || makeTitle(l1 || explicitL2, params.title);
  const detail = explicitL2 || normalizeText(params.details || params.summary);
  const l2 = detail || l1 || l0;
  return { l0, l1, l2 };
}

function shouldAutoRecallPrompt(prompt) {
  const normalized = normalizeText(prompt);
  if (!normalized || normalized.length < 6) {
    return false;
  }
  if (/<memory-hybrid-context>[\s\S]*<\/memory-hybrid-context>/i.test(normalized)) {
    return false;
  }
  if (
    /a new session was started via\s*\/new\s*or\s*\/reset/i.test(normalized) ||
    /execute your session startup sequence now/i.test(normalized) ||
    /do not mention internal steps,\s*files,\s*tools,\s*or reasoning/i.test(normalized)
  ) {
    return false;
  }
  if (
    /^pre-compaction memory flush\b/i.test(normalized) ||
    /store durable memories only in memory\/yyyy-mm-dd\.md/i.test(normalized)
  ) {
    return false;
  }
  if (normalized.startsWith("/")) {
    return false;
  }
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s!?.,~]+$/u.test(normalized)) {
    return false;
  }

  const lower = normalized.toLowerCase();
  if (/^(hi|hello|thanks|thank you|ok|okay|好的|收到|明白了|嗯嗯|在吗)$/i.test(lower)) {
    return false;
  }
  if (/^(是|不是|好|不好|行|不行|可以|不可以|yes|no)$/i.test(lower)) {
    return false;
  }

  if (/(之前|上次|记得|记忆|偏好|决定|项目|继续|沿用|不要忘|remember|previous|last time|preference|decision|project)/i.test(lower)) {
    return true;
  }

  return normalized.length >= 12;
}

function parseJson(value, fallback) {
  if (typeof value !== "string" || !value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch (_err) {
    return fallback;
  }
}

function summarizeConfig(cfg) {
  return {
    enabled: cfg.enabled,
    storePath: expandHome(cfg.store.path),
    vectorBackend: cfg.store?.vector?.backend || "sqlite-vec",
    vectorEnabled: cfg.store?.vector?.enabled !== false,
    embeddingMode: cfg.store?.vector?.embedding?.mode || "hash",
    embeddingFallbackToHash: cfg.store?.vector?.embedding?.fallbackToHash !== false,
    indexingAsync: cfg.indexing?.async !== false,
    indexingBatchSize: cfg.indexing?.batchSize || 16,
    archiveDir: expandHome(cfg.archive.dir),
    primaryScope: cfg.scopes.primary,
    fallbackScope: cfg.scopes.fallback,
    projectResolverMode: cfg.projectResolver.mode,
    ttlAutoCleanup: cfg.ttl.autoCleanup !== false,
    ttlCleanupPollMs: cfg.ttl.cleanupPollMs,
    ttlPurgeAfterDays: cfg.ttl.purgeAfterDays,
    idleCommitMinutes: cfg.commit.idleMinutes,
    recallLevel: cfg.recall.defaultLevel,
    recallMaxItems: cfg.recall.maxItems,
    captureMaxCandidates: cfg.capture.maxCandidatesPerTurn,
    isolationMode: cfg.isolation?.mode || "agent",
    isolationDefaultAgentId: cfg.isolation?.defaultAgentId || "main",
  };
}

function createRuntime(api, cfg) {
  let db = null;
  let initialized = false;
  let storePath = "";
  let archiveRootDir = "";
  const vectorBackend = createVectorBackend(api, cfg);
  const activeContext = {
    agentId: normalizeAgentId(cfg.isolation?.defaultAgentId) || "main",
    sessionId: "",
  };

  function resolveAgentId(rawAgentId) {
    const mode = normalizeIsolationMode(cfg?.isolation?.mode);
    if (mode === "global") {
      return "global";
    }
    const current = normalizeAgentId(rawAgentId);
    if (current) {
      return current;
    }
    const active = normalizeAgentId(activeContext.agentId);
    if (active) {
      return active;
    }
    const fallback = normalizeAgentId(cfg?.isolation?.defaultAgentId);
    return fallback || "main";
  }

  function setActiveAgentContext(context = {}) {
    if (context && Object.prototype.hasOwnProperty.call(context, "agentId")) {
      activeContext.agentId = resolveAgentId(context.agentId);
    }
    if (context && Object.prototype.hasOwnProperty.call(context, "sessionId")) {
      activeContext.sessionId = normalizeText(context.sessionId);
    }
  }

  function getActiveAgentId() {
    return resolveAgentId(activeContext.agentId);
  }

  function getArchiveDir(rawAgentId) {
    const root = archiveRootDir;
    if (!root) {
      return "";
    }
    if (normalizeIsolationMode(cfg?.isolation?.mode) !== "agent") {
      return root;
    }
    return path.join(root, resolveAgentId(rawAgentId));
  }

  function logDebug(message, meta) {
    if (!cfg.debug) {
      return;
    }
    if (meta) {
      api.logger.info(`${message} ${JSON.stringify(meta)}`);
      return;
    }
    api.logger.info(message);
  }

  const retriever = new Retriever({
    cfg,
    vectorBackend,
    logDebug,
    resolveAgentId,
    normalizeText,
    normalizeSearchStatus,
    buildFtsQuery,
    extractSearchTerms,
  });

  function ensureInitialized() {
    if (initialized && db) {
      return db;
    }

    storePath = resolveConfiguredPath(api, cfg.store.path);
    archiveRootDir = resolveConfiguredPath(api, cfg.archive.dir);
    ensureDir(path.dirname(storePath));
    if (cfg.archive.enabled && cfg.archive.writeMarkdown) {
      ensureDir(archiveRootDir);
      ensureDir(getArchiveDir(getActiveAgentId()));
    }

    db = new DatabaseSync(storePath, {
      allowExtension: normalizeVectorBackendName(cfg.store.vector.backend) === "sqlite-vec",
    });
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(readTextFile(path.join(__dirname, "schema.sql")));
    vectorBackend.attach(db, logDebug);
    ensureSchemaMigrations(db);
    initialized = true;

    logDebug("memory-hybrid-context: sqlite initialized", {
      storePath,
      archiveRootDir,
      activeArchiveDir: getArchiveDir(getActiveAgentId()),
    });

    return db;
  }

  function ensureSchemaMigrations(conn) {
    const vectorInfo = vectorBackend.info();
    const getKnownColumns = (tableName) =>
      new Set(
        conn
          .prepare(`PRAGMA table_info(${tableName})`)
          .all()
          .map((row) => String(row.name || "")),
      );

    const addColumnIfMissing = (tableName, knownColumns, name, sqlType) => {
      if (knownColumns.has(name)) {
        return;
      }
      conn.exec(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${sqlType}`);
      knownColumns.add(name);
    };

    const memoryColumns = getKnownColumns("memory_records");
    addColumnIfMissing("memory_records", memoryColumns, "agent_id", "TEXT NOT NULL DEFAULT 'global'");
    addColumnIfMissing("memory_records", memoryColumns, "l0_text", "TEXT");
    addColumnIfMissing("memory_records", memoryColumns, "l1_text", "TEXT");
    addColumnIfMissing("memory_records", memoryColumns, "l2_text", "TEXT");
    addColumnIfMissing("memory_records", memoryColumns, "content_hash", "TEXT");
    addColumnIfMissing("memory_records", memoryColumns, "embedding_version", "TEXT");
    addColumnIfMissing("memory_records", memoryColumns, "vector_backend", "TEXT");
    addColumnIfMissing("memory_records", memoryColumns, "index_status", "TEXT");
    addColumnIfMissing("memory_records", memoryColumns, "indexed_at", "INTEGER");
    addColumnIfMissing("memory_records", memoryColumns, "expired_at", "INTEGER");

    const agentScopedTables = [
      "staging_candidates",
      "commit_log",
      "index_jobs",
      "index_failures",
      "recall_events",
    ];
    for (const tableName of agentScopedTables) {
      const knownColumns = getKnownColumns(tableName);
      addColumnIfMissing(tableName, knownColumns, "agent_id", "TEXT NOT NULL DEFAULT 'global'");
    }

    conn.exec(
      `UPDATE memory_records
          SET l0_text = COALESCE(NULLIF(l0_text, ''), title),
              l1_text = COALESCE(NULLIF(l1_text, ''), summary),
              l2_text = COALESCE(NULLIF(l2_text, ''), NULLIF(raw_text, ''), summary, title)
        WHERE l0_text IS NULL
           OR l0_text = ''
           OR l1_text IS NULL
           OR l1_text = ''
           OR l2_text IS NULL
           OR l2_text = ''`,
    );

    conn.exec(
      `UPDATE memory_records
          SET expired_at = updated_at
        WHERE status = 'expired'
          AND expired_at IS NULL`,
    );

    conn
      .prepare(
        `UPDATE memory_records
            SET content_hash = COALESCE(NULLIF(content_hash, ''), id),
                embedding_version = COALESCE(NULLIF(embedding_version, ''), ?),
                vector_backend = COALESCE(NULLIF(vector_backend, ''), ?),
                index_status = COALESCE(
                  NULLIF(index_status, ''),
                  CASE
                    WHEN ? = 0 THEN 'disabled'
                    WHEN embedding_json IS NOT NULL AND LENGTH(embedding_json) > 2 THEN 'indexed'
                    ELSE 'pending'
                  END
                ),
                indexed_at = COALESCE(
                  indexed_at,
                  CASE
                    WHEN embedding_json IS NOT NULL AND LENGTH(embedding_json) > 2 THEN updated_at
                    ELSE NULL
                  END
                )`,
      )
      .run(
        cfg.store.vector.embeddingVersion,
        vectorInfo.backend,
        vectorInfo.enabled ? 1 : 0,
      );

    conn.exec(
      `UPDATE memory_records
          SET agent_id = COALESCE(NULLIF(TRIM(agent_id), ''), 'global')`,
    );
    conn.exec(
      `UPDATE staging_candidates
          SET agent_id = COALESCE(NULLIF(TRIM(agent_id), ''), 'global')`,
    );
    conn.exec(
      `UPDATE commit_log
          SET agent_id = COALESCE(NULLIF(TRIM(agent_id), ''), 'global')`,
    );
    conn.exec(
      `UPDATE index_jobs
          SET agent_id = COALESCE(NULLIF(TRIM(agent_id), ''), 'global')`,
    );
    conn.exec(
      `UPDATE index_failures
          SET agent_id = COALESCE(NULLIF(TRIM(agent_id), ''), 'global')`,
    );
    conn.exec(
      `UPDATE recall_events
          SET agent_id = COALESCE(NULLIF(TRIM(agent_id), ''), 'global')`,
    );

    conn.exec("CREATE INDEX IF NOT EXISTS idx_memory_index_status ON memory_records(index_status)");
    conn.exec("CREATE INDEX IF NOT EXISTS idx_memory_vector_backend ON memory_records(vector_backend)");
    conn.exec("CREATE INDEX IF NOT EXISTS idx_memory_indexed_at ON memory_records(indexed_at DESC)");
    conn.exec("CREATE INDEX IF NOT EXISTS idx_memory_agent_updated_at ON memory_records(agent_id, updated_at DESC)");
    conn.exec("CREATE INDEX IF NOT EXISTS idx_memory_agent_scope_type_status ON memory_records(agent_id, scope, type, status)");
    conn.exec("CREATE INDEX IF NOT EXISTS idx_staging_agent_session_created_at ON staging_candidates(agent_id, session_id, created_at DESC)");
    conn.exec("CREATE INDEX IF NOT EXISTS idx_index_jobs_agent_status ON index_jobs(agent_id, status, updated_at DESC)");
    conn.exec("CREATE INDEX IF NOT EXISTS idx_index_failures_agent_failed_at ON index_failures(agent_id, failed_at DESC)");
    conn.exec("CREATE INDEX IF NOT EXISTS idx_recall_events_agent_created_at ON recall_events(agent_id, created_at DESC)");
  }

  const projectManager = new ProjectManager({
    cfg,
    ensureInitialized,
    normalizeText,
    stablePathKey,
    resolveConfiguredWorkspace: (explicit) => resolveConfiguredPath(api, explicit),
    getArchiveDir,
    resolveAgentId,
    randomUUID,
    findGitRoot,
    readGitRemote,
    makeManualProjectKey,
    normalizeSelectedProjectKey,
    path,
  });

  function resolveRuntimeScopes(rawScope, memoryType) {
    const projectBinding = projectManager.getCurrentProject(false, {
      agentId: getActiveAgentId(),
    });
    return resolvePreferredScopes(cfg, rawScope, memoryType, {
      projectBinding,
    });
  }

  function close() {
    if (!db) {
      return;
    }
    try {
      db.close();
    } catch (_err) {
      // Best effort; plugin shutdown should not hard-fail.
    }
    db = null;
    initialized = false;
  }

  const indexingManager = new IndexingManager({
    cfg,
    ensureInitialized,
    resolveAgentId,
    normalizeText,
    asJson,
    parseJson,
    clipText,
    computeContentHash,
    vectorBackend,
    randomUUID,
  });

  function writeSessionArchiveSnapshot(params) {
    if (!cfg.archive.enabled || !cfg.archive.writeMarkdown) {
      return null;
    }
    const transcript = extractTextBlocksFromMessages(params.messages, true);
    if (transcript.length === 0) {
      return null;
    }

    const ts = Date.now();
    const parts = isoDateParts(ts);
    const resolvedAgentId = resolveAgentId(params.agentId);
    const sessionsDir = path.join(getArchiveDir(resolvedAgentId), "sessions");
    ensureDir(sessionsDir);

    const reason = normalizeText(params.reason) || "reset";
    const sessionSlug = slugify(params.sessionId || reason).slice(0, 48);
    const fileName = `${parts.date}-${reason}-${sessionSlug}.md`;
    const filePath = path.join(sessionsDir, fileName);
    const lines = [
      `# Session Archive: ${parts.date} ${parts.time} UTC`,
      "",
      `- **Agent ID**: ${resolvedAgentId}`,
      `- **Reason**: ${reason}`,
      `- **Session ID**: ${normalizeText(params.sessionId) || "unknown"}`,
    ];

    if (params.sessionFile) {
      lines.push(`- **Session File**: ${params.sessionFile}`);
    }

    lines.push("");
    lines.push("## Transcript");
    lines.push("");

    for (const item of transcript) {
      const text = normalizeText(item.text);
      if (!text) {
        continue;
      }
      lines.push(`### ${String(item.role || "user").toUpperCase()}`);
      lines.push("");
      lines.push(text);
      lines.push("");
    }

    writeTextFile(filePath, `${lines.join("\n")}\n`);
    return filePath;
  }

  const recordManager = new RecordManager({
    cfg,
    ensureInitialized,
    resolveAgentId,
    normalizeText,
    parseJson,
    asJson,
    fs,
    readTextFile,
    writeTextFile,
    randomUUID,
    computeAutoExpiryForType,
    buildLayerTexts,
    buildEmbeddingSource,
    vectorBackend,
    computeContentHash,
    recordIndexJob: indexingManager.recordIndexJob.bind(indexingManager),
    getArchiveDir,
    isoDateParts,
    slugify,
    clipText,
    stripLeadByType,
    pickFirstClause,
  });

  const storeQueryManager = new StoreQueryManager({
    ensureInitialized,
    resolveAgentId,
    normalizeText,
    normalizeSearchStatus,
    asJson,
    randomUUID,
  });

  function searchRecords(params) {
    const conn = ensureInitialized();
    const safeParams = params && typeof params === "object" ? params : {};
    return retriever.search(conn, {
      ...safeParams,
      agentId: resolveAgentId(safeParams.agentId),
    });
  }

  function getVectorStatsByAgent(agentId) {
    return vectorBackend.getStats(ensureInitialized(), {
      agentId: resolveAgentId(agentId),
    });
  }

  function getVectorHealthByAgent(agentId) {
    return evaluateVectorHealth({
      vectorInfo: {
        ...vectorBackend.info(),
      },
      vectorStats: getVectorStatsByAgent(agentId),
    });
  }

  const archiveGovernance = new ArchiveGovernanceManager({
    getArchiveDir,
    resolveAgentId,
    ensureInitialized,
    getVectorHealth: getVectorHealthByAgent,
    listRecords: storeQueryManager.listRecords.bind(storeQueryManager),
    readRecordById: recordManager.readRecordById.bind(recordManager),
    normalizeText,
    normalizeSearchStatus,
    stablePathKey,
    slugify,
    isoDateParts,
    formatTimestamp,
    ensureDir,
    writeTextFile,
  });

  const consistencyManager = new ConsistencyManager({
    ensureInitialized,
    resolveAgentId,
    normalizeText,
    normalizeSearchStatus,
    formatTimestamp,
    getIndexingPollMs: () => cfg.indexing.pollMs,
    recordIndexJob: indexingManager.recordIndexJob.bind(indexingManager),
    getVectorInfo: () => ({
      ...vectorBackend.info(),
    }),
    getVectorHealth: getVectorHealthByAgent,
    getArchiveAuditReport: archiveGovernance.getArchiveAuditReport.bind(archiveGovernance),
  });

  const importExportManager = new ImportExportManager({
    resolveAgentId,
    normalizeText,
    normalizeSearchStatus,
    formatTimestamp,
    listRecords: storeQueryManager.listRecords.bind(storeQueryManager),
    readRecordById: recordManager.readRecordById.bind(recordManager),
    readTextFile,
    fs,
    buildLayerTexts,
    computeContentHash,
    buildEmbeddingSource,
    resolveRuntimeScopes,
    insertRecord: recordManager.insertRecord.bind(recordManager),
    normalizeKeywords,
    resolveMergePlan: recordManager.resolveMergePlan.bind(recordManager),
  });

  function getRecordById(id, options = {}) {
    return recordManager.readRecordById(id, {
      touchLastUsed: true,
      includeArchive: true,
      agentId: options.agentId,
    });
  }

  const lifecycleManager = new LifecycleManager({
    cfg,
    resolveAgentId,
    getArchiveDir,
    ensureInitialized,
    normalizeText,
    stablePathKey,
    vectorBackend,
    computeAutoExpiryForType,
    recordIndexJob: indexingManager.recordIndexJob.bind(indexingManager),
    processIndexJobs: indexingManager.processIndexJobs.bind(indexingManager),
  });
  const statsPolicyManager = new StatsPolicyManager({
    cfg,
    ensureInitialized,
    resolveAgentId,
    normalizeText,
    computeAutoExpiryForType,
    resolveRoutedScopeByType,
    vectorBackend,
  });

  const stagingManager = new StagingManager({
    cfg,
    ensureInitialized,
    resolveAgentId,
    normalizeText,
    sanitizeIncomingMemoryText,
    shouldStageText,
    randomUUID,
    detectCandidateType,
    clipText,
    resolveRuntimeScopes,
    insertRecord: recordManager.insertRecord.bind(recordManager),
    makeTitle,
    extractTextBlocksFromMessages,
    selectRecentTextBlocks,
    writeSessionArchiveSnapshot,
  });

  const getVectorInfo = () => ({
    ...vectorBackend.info(),
  });

  const getVectorStats = (params = {}) =>
    getVectorStatsByAgent(params && typeof params === "object" ? params.agentId : undefined);

  const getVectorHealth = (params = {}) =>
    getVectorHealthByAgent(params && typeof params === "object" ? params.agentId : undefined);

  function listKnownAgentIds() {
    const conn = ensureInitialized();
    const ids = new Set();
    const tables = [
      "memory_records",
      "staging_candidates",
      "commit_log",
      "index_jobs",
      "index_failures",
      "recall_events",
    ];
    for (const tableName of tables) {
      const rows = conn
        .prepare(
          `SELECT DISTINCT agent_id
             FROM ${tableName}
            WHERE agent_id IS NOT NULL
              AND TRIM(agent_id) <> ''`,
        )
        .all();
      for (const row of rows) {
        ids.add(resolveAgentId(row.agent_id));
      }
    }
    if (ids.size === 0) {
      ids.add(getActiveAgentId());
    }
    return Array.from(ids);
  }

  return {
    ensureInitialized,
    close,
    resolveAgentId,
    setActiveAgentContext,
    getActiveAgentId,
    listKnownAgentIds,
    countRecords: storeQueryManager.countRecords.bind(storeQueryManager),
    countCommits: storeQueryManager.countCommits.bind(storeQueryManager),
    countRecallEvents: storeQueryManager.countRecallEvents.bind(storeQueryManager),
    countStaging: storeQueryManager.countStaging.bind(storeQueryManager),
    countExpiredRecords: lifecycleManager.countExpiredRecords.bind(lifecycleManager),
    countForgottenRecords: lifecycleManager.countForgottenRecords.bind(lifecycleManager),
    countPendingExpiry: lifecycleManager.countPendingExpiry.bind(lifecycleManager),
    countPurgeEligible: lifecycleManager.countPurgeEligible.bind(lifecycleManager),
    getTypeBreakdown: statsPolicyManager.getTypeBreakdown.bind(statsPolicyManager),
    getScopeBreakdown: statsPolicyManager.getScopeBreakdown.bind(statsPolicyManager),
    getBreakdownSnapshot: statsPolicyManager.getBreakdownSnapshot.bind(statsPolicyManager),
    getIndexStats: indexingManager.getIndexStats.bind(indexingManager),
    listRecords: storeQueryManager.listRecords.bind(storeQueryManager),
    auditArchiveRecords: archiveGovernance.auditArchiveRecords.bind(archiveGovernance),
    repairArchiveRecords: archiveGovernance.repairArchiveRecords.bind(archiveGovernance),
    auditOrphanArchiveFiles: archiveGovernance.auditOrphanArchiveFiles.bind(archiveGovernance),
    quarantineOrphanArchiveFiles: archiveGovernance.quarantineOrphanArchiveFiles.bind(archiveGovernance),
    listQuarantinedArchiveFiles: archiveGovernance.listQuarantinedArchiveFiles.bind(archiveGovernance),
    restoreQuarantinedArchiveFiles: archiveGovernance.restoreQuarantinedArchiveFiles.bind(archiveGovernance),
    purgeQuarantinedArchiveFiles: archiveGovernance.purgeQuarantinedArchiveFiles.bind(archiveGovernance),
    getArchiveAuditReport: archiveGovernance.getArchiveAuditReport.bind(archiveGovernance),
    renderArchiveAuditReport: archiveGovernance.renderArchiveAuditReport.bind(archiveGovernance),
    getConsistencyReport: consistencyManager.getConsistencyReport.bind(consistencyManager),
    renderConsistencyReport: consistencyManager.renderConsistencyReport.bind(consistencyManager),
    repairConsistency: consistencyManager.repairConsistency.bind(consistencyManager),
    exportRecords: importExportManager.exportRecords.bind(importExportManager),
    importRecords: importExportManager.importRecords.bind(importExportManager),
    listIndexJobs: indexingManager.listIndexJobs.bind(indexingManager),
    retryIndexJobs: indexingManager.retryIndexJobs.bind(indexingManager),
    enqueueReindexJobs: indexingManager.enqueueReindexJobs.bind(indexingManager),
    processIndexJobs: indexingManager.processIndexJobs.bind(indexingManager),
    insertRecord: recordManager.insertRecord.bind(recordManager),
    searchRecords,
    getRecordById,
    stageCandidates: stagingManager.stageCandidates.bind(stagingManager),
    listStagedCandidates: stagingManager.listStagedCandidates.bind(stagingManager),
    dropStagedCandidates: stagingManager.dropStagedCandidates.bind(stagingManager),
    commitStagedCandidates: stagingManager.commitStagedCandidates.bind(stagingManager),
    listIdleStageSessions: stagingManager.listIdleStageSessions.bind(stagingManager),
    commitIdleSessions: stagingManager.commitIdleSessions.bind(stagingManager),
    handleBeforeReset: stagingManager.handleBeforeReset.bind(stagingManager),
    recordRecallEvent: storeQueryManager.recordRecallEvent.bind(storeQueryManager),
    forgetRecords: lifecycleManager.forgetRecords.bind(lifecycleManager),
    cleanupExpiredRecords: lifecycleManager.cleanupExpiredRecords.bind(lifecycleManager),
    purgeExpiredRecords: lifecycleManager.purgeExpiredRecords.bind(lifecycleManager),
    restoreExpiredRecords: lifecycleManager.restoreExpiredRecords.bind(lifecycleManager),
    getPolicySnapshot: statsPolicyManager.getPolicySnapshot.bind(statsPolicyManager),
    getTypeRoutingRules: statsPolicyManager.getTypeRoutingRules.bind(statsPolicyManager),
    getCurrentProject: projectManager.getCurrentProject.bind(projectManager),
    listProjects: projectManager.listProjects.bind(projectManager),
    bindCurrentProject: projectManager.bindCurrentProject.bind(projectManager),
    useProject: projectManager.useProject.bind(projectManager),
    clearProjectOverride: projectManager.clearProjectOverride.bind(projectManager),
    getProjectOverride: projectManager.getProjectOverride.bind(projectManager),
    resolvePreferredScopes: resolveRuntimeScopes,
    getStorePath: () => storePath,
    getArchiveDir,
    getArchiveRootDir: () => archiveRootDir,
    getVectorInfo,
    getVectorStats,
    getVectorHealth,
  };
}

/*
Planned implementation stages:

1. Boot:
   - open SQLite db
   - load schema.sql
   - register CLI and tools

2. agent_end:
   - run candidate detector
   - write staging_candidates

3. commit:
   - archive session to markdown
   - normalize staged candidates
   - dedupe / merge into memory_records
   - update FTS and vector rows

4. before_agent_start:
   - run adaptive retrieval
   - pack L0/L1 within token budget
   - prepend context
*/

const plugin = {
  id: "memory-hybrid-context",
  name: "Memory Hybrid Context",
  version: "0.2.0",
  description: "Layered dual-track memory plugin.",
  kind: "memory",
  register(api) {
    const cfg = mergeConfig(api.pluginConfig);
    const summary = summarizeConfig(cfg);
    const runtime = createRuntime(api, cfg);
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
    } = buildPluginSchemas();

    const runCommit = async (params = {}) => {
      const safeParams = params && typeof params === "object" ? params : {};
      const resolvedAgentId = runtime.resolveAgentId(safeParams.agentId);
      const resolvedSessionId = normalizeText(safeParams.sessionId);
      runtime.setActiveAgentContext({
        agentId: resolvedAgentId,
        sessionId: resolvedSessionId,
      });
      const summaryText = normalizeText(safeParams.summary);
      const commitSource = normalizeText(safeParams.source) || (summaryText ? "inline" : "staging");
      const resolvedType = normalizeText(safeParams.type) || "other";
      const scopeUris = runtime.resolvePreferredScopes(safeParams.scope, resolvedType);

      if ((commitSource === "staging" || commitSource === "both") && !summaryText) {
        const staged = runtime.commitStagedCandidates({
          agentId: resolvedAgentId,
          sessionId: resolvedSessionId,
          scopes: safeParams.scope ? [normalizeText(safeParams.scope)] : [],
          policy: normalizeText(safeParams.policy) || "conservative",
          archive: safeParams.archive !== false,
          limit: safeParams.limit,
        });
        const message =
          staged.action === "empty"
            ? "暂存区没有可提交的候选。"
            : `已从暂存区提交 ${staged.committed} 条记忆。`;
        return {
          content: [{ type: "text", text: message }],
          details: staged,
        };
      }

      if (!summaryText) {
        return {
          content: [{ type: "text", text: "summary 不能为空，或使用 source=staging 提交暂存候选。" }],
          details: { status: "error", reason: "missing_summary" },
        };
      }

      const record = runtime.insertRecord({
        agentId: resolvedAgentId,
        title: makeTitle(summaryText, safeParams.title),
        summary: clipText(summaryText, 500),
        details: normalizeText(safeParams.details),
        l0Text: safeParams.l0Text,
        l1Text: safeParams.l1Text,
        l2Text: safeParams.l2Text,
        type: resolvedType,
        scope: scopeUris[0] || makeScope(cfg, safeParams.scope),
        scopes: cfg.scopes.autoMirror
          ? scopeUris
          : [scopeUris[0] || makeScope(cfg, safeParams.scope)],
        sessionId: resolvedSessionId,
        importance:
          typeof safeParams.importance === "number" && Number.isFinite(safeParams.importance)
            ? Math.max(0, Math.min(1, safeParams.importance))
            : 0.7,
        confidence:
          typeof safeParams.confidence === "number" && Number.isFinite(safeParams.confidence)
            ? Math.max(0, Math.min(1, safeParams.confidence))
            : 0.8,
        keywords: normalizeKeywords(safeParams.keywords),
        archive: safeParams.archive !== false,
      });

      let staged = null;
      if (commitSource === "both") {
        staged = runtime.commitStagedCandidates({
          agentId: resolvedAgentId,
          sessionId: resolvedSessionId,
          scopes: safeParams.scope ? [normalizeText(safeParams.scope)] : [],
          policy: normalizeText(safeParams.policy) || "conservative",
          archive: safeParams.archive !== false,
          limit: safeParams.limit,
        });
      }

      if (record.action === "duplicate") {
        return {
          content: [
            {
              type: "text",
              text: `检测到重复记忆，已复用现有记录：${record.title}`,
            },
          ],
          details: {
            ...record,
            staged,
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              staged && staged.committed > 0
                ? `已提交记忆：${record.title}；并从暂存区提交 ${staged.committed} 条。`
                : `已提交记忆：${record.title}`,
          },
        ],
        details: {
          ...record,
          staged,
        },
      };
    };

    registerMemoryService({
      api,
      runtime,
      cfg,
      summary,
    });

    if (!cfg.enabled) {
      api.logger.info("memory-hybrid-context: disabled by plugin config; service not registered");
      return;
    }

    registerMemoryTools({
      api,
      runtime,
      schemas: {
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
      },
      runCommit,
      clipText,
      normalizeSearchStatus,
      normalizeText,
    });

    registerMemoryCli({
      api,
      runtime,
      runCommit,
      normalizeSearchStatus,
      normalizeText,
      expandHome,
      ensureDir,
      fs,
      path,
    });

    registerMemoryHooks({
      api,
      cfg,
      runtime,
      extractTextBlocksFromMessages,
      normalizeText,
      shouldAutoRecallPrompt,
      packRecallContext,
    });

    api.logger.info(
      "memory-hybrid-context: runtime enabled (sqlite init, staging, manual commit/search/get, auto recall ready)",
    );
  },
};

module.exports = plugin;
