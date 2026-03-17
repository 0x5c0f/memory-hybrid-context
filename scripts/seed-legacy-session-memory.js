#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/seed-legacy-session-memory.js [options]",
      "",
      "Options:",
      "  --output-dir <path>      Output directory for legacy markdown",
      "                           default: ~/.openclaw/workspace/memory-legacy-seed",
      "  --days <n>               Number of day files, default: 2",
      "  --records-per-day <n>    Sections per file, default: 4",
      "  --prefix <text>          Marker prefix, default: LEGACY-SEED",
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

function parseArgs(argv) {
  const out = {
    outputDir: "~/.openclaw/workspace/memory-legacy-seed",
    days: 2,
    recordsPerDay: 4,
    prefix: "LEGACY-SEED",
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--output-dir" && argv[i + 1]) {
      out.outputDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--days" && argv[i + 1]) {
      out.days = Math.max(1, Math.min(30, Math.floor(Number(argv[i + 1]) || 2)));
      i += 1;
      continue;
    }
    if (arg === "--records-per-day" && argv[i + 1]) {
      out.recordsPerDay = Math.max(1, Math.min(20, Math.floor(Number(argv[i + 1]) || 4)));
      i += 1;
      continue;
    }
    if (arg === "--prefix" && argv[i + 1]) {
      out.prefix = normalizeText(argv[i + 1]) || "LEGACY-SEED";
      i += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  return out;
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatTime(date) {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${formatDate(date)} ${hh}:${mm} GMT+8`;
}

function pickTemplates(marker) {
  return [
    {
      userQuestion: `请记住本次迁移联调标签是 ${marker}-TAG。`,
      event: `用户确认联调标签为 ${marker}-TAG。`,
      operation: "记录了联调标签，用于后续召回测试。",
      finding: [`标签文本包含唯一标识 ${marker}-TAG。`, "可用于前端自然语言回忆验证。"],
      answer: `已记住联调标签 ${marker}-TAG。`,
    },
    {
      userQuestion: "我们后续默认使用哪种 embedding 检索模式？",
      event: `决策更新：默认采用 openai-compatible embedding（标识 ${marker}-DECISION）。`,
      operation: "同步了 embedding 基线策略到迁移测试记录。",
      finding: ["优先保证语义检索质量。", "保留 fallbackToHash 作为可用性兜底。"],
      answer: "后续默认使用 openai-compatible embedding。",
    },
    {
      userQuestion: "当前联调数据库路径是哪个？",
      event: `实体信息确认：数据库路径 /home/cxd/.openclaw/memory-hybrid/main.sqlite（${marker}-DB）。`,
      operation: "核对了 SQLite 主库路径。",
      finding: ["路径用于回归测试。", "可用于实体类记忆召回。"],
      answer: "数据库路径是 /home/cxd/.openclaw/memory-hybrid/main.sqlite。",
    },
    {
      userQuestion: "下周需要做什么联调动作？",
      event: `待办事项：下周二执行一次 recall 质量巡检（${marker}-TODO）。`,
      operation: "创建了联调待办项并标记检查窗口。",
      finding: ["待办项用于 TTL 与治理链路测试。"],
      answer: "已记录下周二 recall 巡检任务。",
    },
    {
      userQuestion: "回答风格偏好能记住吗？",
      event: `用户偏好更新：先给结论，再给步骤（${marker}-PREF）。`,
      operation: "写入了偏好类记忆候选。",
      finding: ["后续可通过问答验证 preference 召回。"],
      answer: "已记住你的回答风格偏好。",
    },
    {
      userQuestion: "这个项目主记忆插件是什么？",
      event: `项目实体：主记忆插件为 memory-hybrid-context（${marker}-PLUGIN）。`,
      operation: "记录了当前插件标识用于回忆测试。",
      finding: ["后续可用“主记忆插件是什么”进行命中验证。"],
      answer: "当前主记忆插件是 memory-hybrid-context。",
    },
  ];
}

function shuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function sectionTitle(index) {
  const cn = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  if (index >= 0 && index < cn.length) {
    return `第${cn[index]}次对话`;
  }
  return `第${index + 1}次对话`;
}

function buildSection(entry, ts, index) {
  const lines = [
    `## ${sectionTitle(index)}`,
    `- **时间**: ${formatTime(ts)}`,
    `- **用户问题**: "${entry.userQuestion}"`,
    `- **事件**: ${entry.event}`,
    `- **操作**: ${entry.operation}`,
    "- **发现**:",
  ];
  for (const item of entry.finding) {
    lines.push(`  - ${item}`);
  }
  lines.push(`- **助手回答**: ${entry.answer}`);
  lines.push("");
  return lines.join("\n");
}

function buildDayFile(date, entries) {
  const lines = [`# ${formatDate(date)}`, ""];
  entries.forEach((entry, idx) => {
    const ts = new Date(date.getTime() + (idx + 1) * 13 * 60 * 1000);
    lines.push(buildSection(entry, ts, idx));
  });
  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const outputDir = path.resolve(expandHome(options.outputDir));
  fs.mkdirSync(outputDir, { recursive: true });

  const marker = `${options.prefix}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const templates = pickTemplates(marker);
  const generatedFiles = [];
  const allMarkers = [
    `${marker}-TAG`,
    `${marker}-DECISION`,
    `${marker}-DB`,
    `${marker}-TODO`,
    `${marker}-PREF`,
    `${marker}-PLUGIN`,
  ];

  for (let dayOffset = 0; dayOffset < options.days; dayOffset += 1) {
    const date = new Date(Date.now() - dayOffset * 24 * 60 * 60 * 1000);
    const dayTemplates = shuffle(templates).slice(0, options.recordsPerDay);
    const content = buildDayFile(date, dayTemplates);
    const filePath = path.join(outputDir, `${formatDate(date)}.md`);
    fs.writeFileSync(filePath, content, "utf8");
    generatedFiles.push(filePath);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        outputDir,
        fileCount: generatedFiles.length,
        files: generatedFiles,
        markerPrefix: marker,
        recallHints: allMarkers,
      },
      null,
      2,
    )}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
}

