#!/usr/bin/env node
// 단체별 폴더를 스캔해 체크리스트 대비 누락 서류를 찾는다.
// 사용법: node scan-docs.mjs --root "<사업 폴더>" [--checklist <경로>] [--json <출력경로>] [--stage "정산"] [--flat]

import fs from 'node:fs';
import path from 'node:path';

const IGNORED_NAMES = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);
const IGNORED_DIRS = new Set(['.git', 'node_modules', '__macosx']);

function parseArgs(argv) {
  const args = { root: '', checklist: '', json: '', stage: '', flat: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--flat') {
      args.flat = true;
    } else if (key.startsWith('--')) {
      args[key.slice(2)] = argv[i + 1] ?? '';
      i += 1;
    }
  }
  return args;
}

// 파일명 비교용 정규화: 공백·괄호·기호를 지우고 소문자로 통일한다.
function normalize(text) {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s_\-().[\]{}'"·,~!@#$%^&*+=|\\/:;?<>]/g, '');
}

function parseChecklist(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const items = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 4) continue;
    if (/^-{2,}|^:?-+:?$/.test(cells[0])) continue; // 구분선
    if (cells[0] === '단계' || cells[1] === '서류명') continue; // 헤더
    const [stage, name, requiredRaw, keywordRaw] = cells;
    if (!stage || !name) continue;

    const keywords = [];
    const extensions = [];
    for (const token of keywordRaw.split(',').map((k) => k.trim()).filter(Boolean)) {
      if (token.toLowerCase().startsWith('ext:')) {
        extensions.push(token.slice(4).trim().toLowerCase().replace(/^\./, ''));
      } else {
        keywords.push(token);
      }
    }
    items.push({
      stage,
      name,
      required: !requiredRaw.includes('선택'),
      keywords,
      extensions,
    });
  }
  if (items.length === 0) {
    throw new Error(`체크리스트에서 항목을 찾지 못했습니다: ${filePath}`);
  }
  return items;
}

function collectFiles(dir, baseDir = dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.') || name.startsWith('~$')) continue;
    const full = path.join(dir, name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(name.toLowerCase())) continue;
      collectFiles(full, baseDir, out);
    } else if (entry.isFile()) {
      if (IGNORED_NAMES.has(name.toLowerCase())) continue;
      const relative = path.relative(baseDir, full).split(path.sep).join('/');
      out.push({
        name,
        relative,
        extension: path.extname(name).slice(1).toLowerCase(),
        // 경로 전체를 매칭 대상으로 삼아 "정산/영수증.pdf"처럼 폴더로 구분한 경우도 잡는다.
        normalized: normalize(relative),
      });
    }
  }
  return out;
}

function matchItem(item, files) {
  const matches = [];
  for (const file of files) {
    const byKeyword = item.keywords.some((kw) => file.normalized.includes(normalize(kw)));
    const byExtension = item.extensions.includes(file.extension);
    if (byKeyword || byExtension) matches.push(file.relative);
  }
  return matches;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const skillDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

  if (!args.root) {
    console.error('오류: --root "<사업 폴더 경로>" 를 지정하세요.');
    process.exit(1);
  }
  const root = path.resolve(args.root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`오류: 폴더를 찾을 수 없습니다: ${root}`);
    process.exit(1);
  }

  const checklistPath = args.checklist
    ? path.resolve(args.checklist)
    : path.join(skillDir, 'references', 'checklist.md');
  if (!fs.existsSync(checklistPath)) {
    console.error(`오류: 체크리스트 파일이 없습니다: ${checklistPath}`);
    process.exit(1);
  }

  let items = parseChecklist(checklistPath);
  if (args.stage) {
    const wanted = normalize(args.stage);
    const filtered = items.filter((it) => normalize(it.stage).includes(wanted));
    if (filtered.length === 0) {
      const stages = [...new Set(items.map((it) => it.stage))].join(', ');
      console.error(`오류: "${args.stage}" 단계를 찾지 못했습니다. 사용 가능한 단계: ${stages}`);
      process.exit(1);
    }
    items = filtered;
  }

  // 단체 목록: 기본은 root의 하위 폴더 하나 = 단체 하나.
  let groups;
  if (args.flat) {
    groups = [{ name: path.basename(root), dir: root }];
  } else {
    groups = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name.toLowerCase()))
      .map((e) => ({ name: e.name, dir: path.join(root, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    if (groups.length === 0) {
      groups = [{ name: path.basename(root), dir: root }];
    }
  }

  const results = groups.map((group) => {
    const files = collectFiles(group.dir);
    const checks = items.map((item) => {
      const matches = matchItem(item, files);
      return {
        stage: item.stage,
        name: item.name,
        required: item.required,
        status: matches.length > 0 ? 'found' : 'missing',
        matches,
      };
    });
    const requiredChecks = checks.filter((c) => c.required);
    const requiredFound = requiredChecks.filter((c) => c.status === 'found').length;
    return {
      group: group.name,
      fileCount: files.length,
      requiredTotal: requiredChecks.length,
      requiredFound,
      missingRequired: requiredChecks.filter((c) => c.status === 'missing').map((c) => c.name),
      missingOptional: checks.filter((c) => !c.required && c.status === 'missing').map((c) => c.name),
      checks,
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    root,
    checklist: checklistPath,
    stageFilter: args.stage || null,
    stages: [...new Set(items.map((it) => it.stage))],
    items: items.map((it) => ({ stage: it.stage, name: it.name, required: it.required })),
    groups: results,
  };

  if (args.json) {
    const outPath = path.resolve(args.json);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  }

  // 콘솔 요약
  const complete = results.filter((r) => r.missingRequired.length === 0).length;
  console.log(`스캔 폴더: ${root}`);
  console.log(`체크리스트: ${checklistPath}${args.stage ? ` (단계: ${args.stage})` : ''}`);
  console.log(`단체 ${results.length}곳 / 필수서류 완비 ${complete}곳 / 누락 있음 ${results.length - complete}곳`);
  console.log('');
  for (const r of results) {
    const rate = r.requiredTotal === 0 ? 100 : Math.round((r.requiredFound / r.requiredTotal) * 100);
    const mark = r.missingRequired.length === 0 ? '[완비]' : '[누락]';
    console.log(`${mark} ${r.group} — 필수 ${r.requiredFound}/${r.requiredTotal} (${rate}%), 파일 ${r.fileCount}건`);
    if (r.missingRequired.length > 0) {
      console.log(`   누락(필수): ${r.missingRequired.join(', ')}`);
    }
    if (r.missingOptional.length > 0) {
      console.log(`   미제출(선택): ${r.missingOptional.join(', ')}`);
    }
  }
  if (args.json) {
    console.log('');
    console.log(`JSON 저장: ${path.resolve(args.json)}`);
  }
}

main();
