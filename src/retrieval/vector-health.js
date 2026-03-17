"use strict";

function clampProbe(value) {
  return Math.max(0, Math.min(4, Math.floor(Number(value) || 0)));
}

function evaluateVectorHealth({ vectorInfo, vectorStats }) {
  const backend = vectorInfo && vectorInfo.backend ? String(vectorInfo.backend) : "disabled";
  const mode = vectorInfo && vectorInfo.mode ? String(vectorInfo.mode) : "disabled";

  if (backend !== "ann-local") {
    return {
      backend,
      mode,
      level: "not_applicable",
      score: null,
      tuning: {
        action: "none",
        currentProbePerBand: null,
        recommendedProbePerBand: null,
        reason: "当前不是 ann-local 后端。",
      },
      warnings: [],
      suggestions: [],
      metrics: {},
    };
  }

  const indexedRecords = Math.max(0, Number(vectorStats && vectorStats.indexedRecords) || 0);
  const bucketRows = Math.max(0, Number(vectorStats && vectorStats.bucketRows) || 0);
  const uniqueBuckets = Math.max(0, Number(vectorStats && vectorStats.uniqueBuckets) || 0);
  const avgBucketsPerRecord = Math.max(0, Number(vectorStats && vectorStats.avgBucketsPerRecord) || 0);
  const probePerBand = Math.max(0, Number(vectorStats && vectorStats.probePerBand) || 0);
  const approxQueryBuckets = Math.max(0, Number(vectorStats && vectorStats.approxQueryBuckets) || 0);
  const hottestBuckets = Array.isArray(vectorStats && vectorStats.hottestBuckets)
    ? vectorStats.hottestBuckets
    : [];
  const hottestBucket = hottestBuckets.length > 0 ? hottestBuckets[0] : null;
  const hottestBucketLoad = Math.max(0, Number(hottestBucket && hottestBucket.recordCount) || 0);
  const hottestBucketRatio = indexedRecords > 0 ? Number((hottestBucketLoad / indexedRecords).toFixed(4)) : 0;
  const bucketCoverage = indexedRecords > 0 ? Number((uniqueBuckets / indexedRecords).toFixed(4)) : 0;

  if (indexedRecords === 0) {
    return {
      backend,
      mode,
      level: "empty",
      score: null,
      tuning: {
        action: "observe",
        currentProbePerBand: probePerBand,
        recommendedProbePerBand: probePerBand,
        reason: "当前索引为空，先完成建索引再决定是否调 probe。",
      },
      warnings: ["当前还没有建立任何 ann-local 索引记录。"],
      suggestions: ["先执行一次写入或 `openclaw mhm index-rebuild`，再观察桶分布。"],
      metrics: {
        indexedRecords,
        bucketRows,
        uniqueBuckets,
        avgBucketsPerRecord,
        probePerBand,
        approxQueryBuckets,
        hottestBucketRatio,
        bucketCoverage,
      },
    };
  }

  const warnings = [];
  const suggestions = [];
  let penalty = 0;

  if (hottestBucketRatio >= 0.6) {
    warnings.push("热点桶过热，单桶覆盖了过多记录，召回会偏斜。");
    suggestions.push("优先提高分桶离散度，必要时增加 band 策略或调整哈希规则。");
    penalty += 45;
  } else if (hottestBucketRatio >= 0.35) {
    warnings.push("热点桶偏热，桶分布开始不均衡。");
    suggestions.push("继续观察热点桶；如果命中偏斜，考虑调高 probe 或优化分桶。");
    penalty += 20;
  }

  if (bucketCoverage < 1.5) {
    warnings.push("唯一桶数量偏少，桶覆盖度不足。");
    suggestions.push("这通常意味着分桶过于集中，后续应考虑增加离散度。");
    penalty += 20;
  } else if (bucketCoverage < 2) {
    warnings.push("桶覆盖度一般，继续增长时需要关注分桶扩散。");
    penalty += 10;
  }

  if (avgBucketsPerRecord < 4) {
    warnings.push("每条记录落桶过少，召回可能偏窄。");
    suggestions.push("可考虑提高分桶数量或增加多探针深度。");
    penalty += 10;
  } else if (avgBucketsPerRecord > 10) {
    warnings.push("每条记录落桶偏多，查询候选可能膨胀。");
    suggestions.push("如果查询延迟上升，考虑收紧分桶或降低探针深度。");
    penalty += 8;
  }

  if (approxQueryBuckets > Math.max(12, uniqueBuckets * 0.35)) {
    warnings.push("单次查询探测桶数量偏多，后续数据增长时成本会升高。");
    suggestions.push("可以适当降低 `probePerBand`，或先观察真实命中率再调整。");
    penalty += 10;
  }

  if (probePerBand === 0) {
    warnings.push("当前关闭了多探针，召回率可能偏保守。");
    suggestions.push("如果有漏召回，优先把 `probePerBand` 调到 1。");
    penalty += 6;
  } else if (probePerBand >= 3) {
    warnings.push("多探针偏高，召回率提升的同时会增加候选规模。");
    suggestions.push("只有在确认漏召回明显时再继续维持高 probe。");
    penalty += 6;
  }

  const score = Math.max(0, 100 - penalty);
  let level = "healthy";
  if (score < 60) {
    level = "critical";
  } else if (score < 85 || warnings.length > 0) {
    level = "warn";
  }

  let recommendedProbePerBand = probePerBand;
  let action = "keep";
  let reason = "当前 probe 配置可继续维持。";

  if (hottestBucketRatio >= 0.6 && probePerBand > 0) {
    recommendedProbePerBand = clampProbe(probePerBand - 1);
    action = recommendedProbePerBand < probePerBand ? "decrease" : "keep";
    reason = "热点桶过热，先收紧 probe，避免候选继续膨胀。";
  } else if (approxQueryBuckets > Math.max(12, uniqueBuckets * 0.35) && probePerBand > 0) {
    recommendedProbePerBand = clampProbe(probePerBand - 1);
    action = recommendedProbePerBand < probePerBand ? "decrease" : "keep";
    reason = "单次查询探桶偏多，先降低 probe 控制候选规模。";
  } else if (probePerBand === 0 && score >= 70) {
    recommendedProbePerBand = 1;
    action = "increase";
    reason = "当前分桶还算健康，但关闭多探针会偏保守，建议至少升到 1。";
  } else if (score >= 90 && hottestBucketRatio < 0.2 && probePerBand < 2) {
    recommendedProbePerBand = clampProbe(probePerBand + 1);
    action = recommendedProbePerBand > probePerBand ? "increase" : "keep";
    reason = "当前分桶较均衡，可小幅提高 probe 换取更高召回率。";
  }

  return {
    backend,
    mode,
    level,
    score,
    tuning: {
      action,
      currentProbePerBand: probePerBand,
      recommendedProbePerBand,
      reason,
    },
    warnings,
    suggestions,
    metrics: {
      indexedRecords,
      bucketRows,
      uniqueBuckets,
      avgBucketsPerRecord,
      probePerBand,
      approxQueryBuckets,
      hottestBucket: hottestBucket
        ? {
            bucketKey: hottestBucket.bucketKey,
            recordCount: hottestBucketLoad,
          }
        : null,
      hottestBucketRatio,
      bucketCoverage,
    },
  };
}

module.exports = {
  clampProbe,
  evaluateVectorHealth,
};
