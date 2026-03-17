#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/legacy-session-memory-export.js [options]",
      "",
      "Options:",
      "  --input <path>           Legacy markdown file or directory",
      "                           default: ~/.openclaw/workspace/memory",
      "  --output <path>          Output JSON path",
      "                           default: /tmp/mhm-legacy-import.json",
      "  --scope <scope-uri>      Imported scope, default: mem://user/default",
      "  --session-prefix <text>  Session id prefix, default: legacy-session",
      "  --limit <n>              Max records in output",
      "  --verbose                Print record preview",
      "  --help                   Show this help",
      "",
    ].join("\n"),
  );
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function expandHome(rawPath) {
  const input = String(rawPath || "");
  if (input.startsWith("~/")) {
    return path.join(process.env.HOME || "", input.slice(2));
  }
  return input;
}

function clipText(text, maxChars) {
  const normalized = normalizeText(text);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function toIsoDate(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString();
}

function parseArgs(argv) {
  const out = {
    input: "~/.openclaw/workspace/memory",
    output: "/tmp/mhm-legacy-import.json",
    scope: "mem://user/default",
    sessionPrefix: "legacy-session",
    limit: 0,
    verbose: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--verbose") {
      out.verbose = true;
      continue;
    }
    if (arg === "--input" && argv[i + 1]) {
      out.input = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--output" && argv[i + 1]) {
      out.output = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--scope" && argv[i + 1]) {
      out.scope = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--session-prefix" && argv[i + 1]) {
      out.sessionPrefix = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--limit" && argv[i + 1]) {
      out.limit = Math.max(0, Math.floor(Number(argv[i + 1]) || 0));
      i += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  return out;
}

function collectMarkdownFiles(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input path does not exist: ${inputPath}`);
  }
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) {
    return inputPath.endsWith(".md") ? [inputPath] : [];
  }

  const out = [];
  const queue = [inputPath];
  while (queue.length > 0) {
    const current = queue.shift();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(abs);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        out.push(abs);
      }
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function splitSections(markdown) {
  const text = String(markdown || "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  let dayTitle = "";
  const sections = [];
  let current = null;

  for (const line of lines) {
    if (!dayTitle) {
      const dayMatch = line.match(/^#\s+(.+)$/);
      if (dayMatch) {
        dayTitle = normalizeText(dayMatch[1]);
        continue;
      }
    }

    const sectionMatch = line.match(/^##\s+(.+)$/);
    if (sectionMatch) {
      if (current) {
        sections.push(current);
      }
      current = {
        title: normalizeText(sectionMatch[1]),
        lines: [],
      };
      continue;
    }

    if (current) {
      current.lines.push(line);
    }
  }

  if (current) {
    sections.push(current);
  }

  return {
    dayTitle,
    sections,
  };
}

function parseSectionFields(sectionLines) {
  const fields = {};
  let currentField = "";
  for (const rawLine of sectionLines) {
    const line = String(rawLine || "");
    const keyValue = line.match(/^\s*-\s+\*\*(.+?)\*\*:\s*(.*)$/);
    if (keyValue) {
      const key = normalizeText(keyValue[1]);
      const value = normalizeText(keyValue[2]);
      fields[key] = normalizeText(value);
      currentField = key;
      continue;
    }

    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && currentField) {
      fields[currentField] = normalizeText(`${fields[currentField] || ""} ${listItem[1]}`);
      continue;
    }

    const plain = normalizeText(line);
    if (plain && currentField) {
      fields[currentField] = normalizeText(`${fields[currentField] || ""} ${plain}`);
    }
  }
  return fields;
}

function parseDateKey(filePath, dayTitle) {
  const fromName = path.basename(filePath).match(/(\d{4}-\d{2}-\d{2})/);
  if (fromName) {
    return fromName[1];
  }
  const fromTitle = normalizeText(dayTitle).match(/(\d{4}-\d{2}-\d{2})/);
  if (fromTitle) {
    return fromTitle[1];
  }
  return "unknown-date";
}

function cleanQuote(text) {
  const raw = normalizeText(text);
  return raw
    .replace(/^["“”'`]+/u, "")
    .replace(/["“”'`]+$/u, "");
}

function detectType(text) {
  const lower = normalizeText(text).toLowerCase();
  if (!lower) {
    return "event";
  }
  if (/(偏好|喜欢|习惯|prefer|like|dislike|hate)/i.test(lower)) {
    return "preference";
  }
  if (/(决定|改用|方案|后续默认|计划|将会|will use|decide|adopt)/i.test(lower)) {
    return "decision";
  }
  if (/(待办|todo|follow up|下周|明天|稍后|记得)/i.test(lower)) {
    return "todo";
  }
  if (/(路径|地址|端口|服务器|数据库|repo|仓库|机器|project id)/i.test(lower)) {
    return "entity";
  }
  return "event";
}

function extractKeywords(parts) {
  const bag = new Set();
  for (const part of parts) {
    const normalized = normalizeText(part);
    if (!normalized) {
      continue;
    }
    const words = normalized
      .split(/[^0-9A-Za-z\u4e00-\u9fff_\-./]+/u)
      .map((item) => normalizeText(item))
      .filter(Boolean);
    for (const word of words) {
      if (word.length < 2) {
        continue;
      }
      bag.add(word.slice(0, 48));
      if (bag.size >= 12) {
        return Array.from(bag);
      }
    }
  }
  return Array.from(bag);
}

function buildRecord({ filePath, section, sectionIndex, dayTitle, options }) {
  const fields = parseSectionFields(section.lines);
  const dateKey = parseDateKey(filePath, dayTitle);
  const question = cleanQuote(fields["用户问题"]);
  const event = normalizeText(fields["事件"]);
  const operation = normalizeText(fields["操作"]);
  const finding = normalizeText(fields["发现"]);
  const answer = normalizeText(fields["助手回答"]);
  const tsText = normalizeText(fields["时间"]);

  const titleSeed = event || operation || question || section.title || "迁移历史记忆";
  const l0Text = clipText(`迁移记忆: ${titleSeed}`, 120);

  const summaryParts = [];
  if (event) {
    summaryParts.push(`事件：${event}`);
  }
  if (operation) {
    summaryParts.push(`操作：${operation}`);
  }
  if (!event && !operation && question) {
    summaryParts.push(`用户问题：${question}`);
  }
  if (finding) {
    summaryParts.push(`发现：${finding}`);
  }
  const l1Text = clipText(summaryParts.join("；") || l0Text, 280);

  const l2Parts = [
    `来源文件: ${path.basename(filePath)}`,
    `来源章节: ${section.title || `section-${sectionIndex + 1}`}`,
  ];
  if (tsText) {
    l2Parts.push(`时间: ${tsText}`);
  }
  if (question) {
    l2Parts.push(`用户问题: ${question}`);
  }
  if (event) {
    l2Parts.push(`事件: ${event}`);
  }
  if (operation) {
    l2Parts.push(`操作: ${operation}`);
  }
  if (finding) {
    l2Parts.push(`发现: ${finding}`);
  }
  if (answer) {
    l2Parts.push(`助手回答: ${answer}`);
  }
  const l2Text = clipText(l2Parts.join("\n"), 1200);

  const type = detectType([l0Text, l1Text, l2Text].join(" "));
  const base = `${filePath}#${section.title}#${sectionIndex}`;
  const sourceId = `legacy-${createHash("sha1").update(base).digest("hex").slice(0, 24)}`;
  const sessionId = `${options.sessionPrefix}-${dateKey}`;
  const keywords = extractKeywords([section.title, question, event, operation, finding, answer, dateKey]);

  return {
    id: sourceId,
    title: l0Text,
    summary: l1Text,
    l0Text,
    l1Text,
    l2Text,
    rawText: l2Text,
    type,
    scope: options.scope,
    sessionId,
    importance: type === "decision" || type === "entity" ? 0.75 : 0.68,
    confidence: 0.78,
    keywords,
    sourcePath: filePath,
    migratedFrom: "session-memory-markdown",
  };
}

function buildLegacyImportPayload(inputOptions = {}) {
  const options = {
    input: normalizeText(inputOptions.input) || "~/.openclaw/workspace/memory",
    scope: normalizeText(inputOptions.scope) || "mem://user/default",
    sessionPrefix: normalizeText(inputOptions.sessionPrefix) || "legacy-session",
    limit: Math.max(0, Math.floor(Number(inputOptions.limit) || 0)),
  };
  const inputPath = path.resolve(expandHome(options.input));
  const files = collectMarkdownFiles(inputPath);
  const records = [];
  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = splitSections(raw);
    parsed.sections.forEach((section, idx) => {
      const record = buildRecord({
        filePath,
        section,
        sectionIndex: idx,
        dayTitle: parsed.dayTitle,
        options,
      });
      if (!record.l0Text || !record.l1Text) {
        return;
      }
      records.push(record);
    });
  }

  const limited = options.limit > 0 ? records.slice(0, options.limit) : records;
  const byType = {};
  for (const item of limited) {
    byType[item.type] = (byType[item.type] || 0) + 1;
  }

  const payload = {
    generatedAt: toIsoDate(Date.now()),
    generator: "legacy-session-memory-export",
    inputPath,
    fileCount: files.length,
    count: limited.length,
    filters: {
      scope: options.scope,
      sessionPrefix: options.sessionPrefix,
      limit: options.limit > 0 ? options.limit : null,
    },
    stats: {
      byType,
    },
    records: limited,
  };

  return {
    inputPath,
    fileCount: files.length,
    recordCount: limited.length,
    byType,
    payload,
    records: limited,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const outputPath = path.resolve(expandHome(options.output));
  const migration = buildLegacyImportPayload(options);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(migration.payload, null, 2)}\n`, "utf8");

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        inputPath: migration.inputPath,
        outputPath,
        fileCount: migration.fileCount,
        recordCount: migration.recordCount,
        byType: migration.byType,
      },
      null,
      2,
    )}\n`,
  );

  if (options.verbose) {
    migration.records.slice(0, 8).forEach((item, idx) => {
      process.stdout.write(
        `${idx + 1}. [${item.type}] ${item.title} | session=${item.sessionId} | source=${path.basename(item.sourcePath)}\n`,
      );
    });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${String(error && error.message ? error.message : error)}\n`);
    process.exit(1);
  }
}

module.exports = {
  buildLegacyImportPayload,
};
