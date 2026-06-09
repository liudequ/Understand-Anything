#!/usr/bin/env node
/**
 * validate-against-scan.mjs
 *
 * Anti-hallucination gate for the Understand Anything pipeline.
 *
 * Reads the assembled knowledge graph and the Phase 1 scan result,
 * then removes every file-level node whose `filePath` does not appear
 * in the scan inventory.  Function/class children of removed files,
 * dangling edges, and orphaned layer/tour references are also cleaned.
 *
 * Usage:
 *   node validate-against-scan.mjs <graph.json> <scan.json> [output.json]
 *
 * If output.json is omitted, the graph is written back to graph.json (in-place).
 *
 * Exit codes:
 *   0  — success (ghosts may or may not have been found)
 *   1  — missing input or malformed JSON
 */

import fs from 'node:fs';

const [graphPath, scanPath, outputPathArg] = process.argv.slice(2);
const outputPath = outputPathArg || graphPath;

if (!graphPath || !scanPath) {
  process.stderr.write(
    'Usage: node validate-against-scan.mjs <graph.json> <scan.json> [output.json]\n'
  );
  process.exit(1);
}

// ── 1. Read inputs ────────────────────────────────────────────────────
let graph, scan;
try {
  graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  scan = JSON.parse(fs.readFileSync(scanPath, 'utf8'));
} catch (err) {
  process.stderr.write(`validate-against-scan: failed to read input — ${err.message}\n`);
  process.exit(1);
}

const scanPaths = new Set(
  (scan.files || []).map(f => f.path).filter(Boolean)
);

// Handle old-format scans that have a flat array
const scanFiles = scan.files || scan;
if (Array.isArray(scanFiles) && !scan.paths) {
  scanFiles.forEach(entry => {
    if (typeof entry === 'string') scanPaths.add(entry);
    else if (entry && entry.path) scanPaths.add(entry.path);
  });
}

const nodes = graph.nodes || [];
const edges = graph.edges || [];

// ── 2. Find ghost file-paths ──────────────────────────────────────────
const ghostFilePaths = new Set();
const seenIds = new Set();

for (const n of nodes) {
  if (!n.id) continue;
  const fp = n.filePath;
  if (!fp) continue;

  // Only file-level node types carry authoritative filePath
  const fileLevel = new Set([
    'file', 'config', 'document', 'service', 'pipeline',
    'table', 'schema', 'resource', 'endpoint',
  ]);
  if (!fileLevel.has(n.type)) continue;

  if (!scanPaths.has(fp)) {
    ghostFilePaths.add(fp);
  }
}

// ── 3. Collect all node IDs to remove ─────────────────────────────────
//    - file-level ghosts
//    - any function/class/document/schema child whose filePath is ghost
const removeIds = new Set();

for (const n of nodes) {
  if (!n.id) continue;
  const fp = n.filePath || '';
  if (ghostFilePaths.has(fp)) {
    removeIds.add(n.id);
  }
}

// ── 4. Filter ─────────────────────────────────────────────────────────
const keptNodes = nodes.filter(n => !removeIds.has(n.id));
const keptIds = new Set(keptNodes.map(n => n.id));

const keptEdges = edges.filter(
  e => keptIds.has(e.source) && keptIds.has(e.target)
);

const removedNodes = nodes.length - keptNodes.length;
const removedEdges = edges.length - keptEdges.length;

// ── 5. Clean layers ───────────────────────────────────────────────────
if (Array.isArray(graph.layers)) {
  for (const layer of graph.layers) {
    if (Array.isArray(layer.nodeIds)) {
      layer.nodeIds = layer.nodeIds.filter(id => keptIds.has(id));
    }
  }
}

// ── 6. Clean tour ─────────────────────────────────────────────────────
if (Array.isArray(graph.tour)) {
  for (const step of graph.tour) {
    if (Array.isArray(step.nodeIds)) {
      step.nodeIds = step.nodeIds.filter(id => keptIds.has(id));
    }
  }
}

// ── 7. Write ──────────────────────────────────────────────────────────
graph.nodes = keptNodes;
graph.edges = keptEdges;

fs.writeFileSync(outputPath, JSON.stringify(graph, null, 2), 'utf8');

if (removedNodes > 0) {
  const uniqueFiles = ghostFilePaths.size;
  console.log(
    `Ghost node gate: removed ${removedNodes} node(s) ` +
    `(${uniqueFiles} unique file path(s)) and ${removedEdges} edge(s) ` +
    `referencing files absent from Phase 1 scan inventory.`
  );
} else {
  console.log(`Ghost node gate: 0 ghosts found — graph is clean.`);
}

process.exit(0);
