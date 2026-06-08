#!/usr/bin/env node
/**
 * compare-fingerprints.mjs
 *
 * Compare the current project state against `.understand-anything/fingerprints.json`
 * and produce the structural change artifacts needed for manual incremental
 * updates in non-Git projects (SVN / no VCS). Git projects may also use this
 * script as a fallback when commit-based diffing is unavailable.
 *
 * Usage:
 *   node compare-fingerprints.mjs <input.json>
 *
 * Input JSON:
 *   {
 *     projectRoot: string,
 *     analysisRef?: string,
 *     gitCommitHash?: string
 *   }
 *
 * Output files:
 *   - .understand-anything/tmp/changed-files.txt
 *   - .understand-anything/tmp/change-analysis.json
 *   - .understand-anything/tmp/update-decision.json
 */

import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { listProjectFiles } from './scan-project.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(__dirname, '../..');
const require = createRequire(resolve(pluginRoot, 'package.json'));

let core;
try {
  core = await import(pathToFileURL(require.resolve('@understand-anything/core')).href);
} catch {
  core = await import(pathToFileURL(resolve(pluginRoot, 'packages/core/dist/index.js')).href);
}

const {
  TreeSitterPlugin,
  PluginRegistry,
  builtinLanguageConfigs,
  registerAllParsers,
  loadFingerprints,
  analyzeChanges,
  classifyUpdate,
} = core;

function ensureDirectory(projectRoot) {
  if (!existsSync(projectRoot)) {
    throw new Error(`projectRoot does not exist: ${projectRoot}`);
  }
  const st = statSync(projectRoot);
  if (!st.isDirectory()) {
    throw new Error(`projectRoot is not a directory: ${projectRoot}`);
  }

  const uaDir = join(projectRoot, '.understand-anything');
  const tmpDir = join(uaDir, 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  return { uaDir, tmpDir };
}

function writeOutputs(projectRoot, changeAnalysis, updateDecision) {
  const { tmpDir } = ensureDirectory(projectRoot);

  const changedFiles = Array.from(new Set([
    ...changeAnalysis.newFiles,
    ...changeAnalysis.deletedFiles,
    ...changeAnalysis.structurallyChangedFiles,
  ])).sort((a, b) => a.localeCompare(b));

  const changedFilesPath = join(tmpDir, 'changed-files.txt');
  const changeAnalysisPath = join(tmpDir, 'change-analysis.json');
  const updateDecisionPath = join(tmpDir, 'update-decision.json');

  writeFileSync(
    changedFilesPath,
    changedFiles.length > 0 ? `${changedFiles.join('\n')}\n` : '',
    'utf-8',
  );
  writeFileSync(changeAnalysisPath, JSON.stringify(changeAnalysis, null, 2), 'utf-8');
  writeFileSync(updateDecisionPath, JSON.stringify(updateDecision, null, 2), 'utf-8');

  return { changedFilesPath, changeAnalysisPath, updateDecisionPath, changedFiles };
}

async function main() {
  const [, , inputPath] = process.argv;
  if (!inputPath) {
    process.stderr.write('Usage: node compare-fingerprints.mjs <input.json>\n');
    process.exit(1);
  }

  const input = JSON.parse(readFileSync(inputPath, 'utf-8'));
  const projectRoot = input.projectRoot;
  const analysisRef = typeof input.analysisRef === 'string'
    ? input.analysisRef
    : (typeof input.gitCommitHash === 'string' ? input.gitCommitHash : 'unknown');

  if (!projectRoot) {
    throw new Error('Invalid input: requires { projectRoot: string }');
  }

  ensureDirectory(projectRoot);

  const existingStore = loadFingerprints(projectRoot);
  if (!existingStore) {
    const changeAnalysis = {
      fileChanges: [],
      newFiles: [],
      deletedFiles: [],
      structurallyChangedFiles: [],
      cosmeticOnlyFiles: [],
      unchangedFiles: [],
      analysisRef,
      reason: 'Missing or unreadable fingerprints baseline',
    };
    const updateDecision = {
      action: 'FULL_UPDATE',
      filesToReanalyze: [],
      rerunArchitecture: true,
      rerunTour: true,
      reason: 'Missing or unreadable fingerprints baseline — full rebuild required',
      analysisRef,
    };
    writeOutputs(projectRoot, changeAnalysis, updateDecision);
    process.stdout.write('Decision: FULL_UPDATE (missing baseline)\n');
    return;
  }

  const { files: currentFiles } = listProjectFiles(projectRoot);
  const baselineFiles = Object.keys(existingStore.files);
  const candidateFiles = Array.from(new Set([...currentFiles, ...baselineFiles]))
    .sort((a, b) => a.localeCompare(b));

  const tsConfigs = builtinLanguageConfigs.filter((c) => c.treeSitter);
  const tsPlugin = new TreeSitterPlugin(tsConfigs);
  await tsPlugin.init();

  const registry = new PluginRegistry();
  registry.register(tsPlugin);
  registerAllParsers(registry);

  const rawAnalysis = analyzeChanges(projectRoot, candidateFiles, existingStore, registry);
  const updateDecision = {
    ...classifyUpdate(rawAnalysis, baselineFiles.length, baselineFiles),
    analysisRef,
  };
  const changeAnalysis = {
    ...rawAnalysis,
    analysisRef,
    baselineFileCount: baselineFiles.length,
    currentFileCount: currentFiles.length,
    candidateFileCount: candidateFiles.length,
  };

  const { changedFiles } = writeOutputs(projectRoot, changeAnalysis, updateDecision);
  process.stdout.write(
    `Decision: ${updateDecision.action} (${changedFiles.length} structural change file(s))\n`,
  );
}

try {
  await main();
} catch (err) {
  process.stderr.write(`compare-fingerprints.mjs failed: ${err.message}\n${err.stack}\n`);
  process.exit(1);
}
