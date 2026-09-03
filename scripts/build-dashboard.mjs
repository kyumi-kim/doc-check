#!/usr/bin/env node
// 스캔 결과(JSON)를 현황판 템플릿에 넣어 완성된 HTML을 만든다.
// 사용법: node build-dashboard.mjs --report <report.json> --out <현황판.html>

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1] ?? '';
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const skillDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
);

if (!args.report || !args.out) {
  console.error('사용법: node build-dashboard.mjs --report <report.json> --out <현황판.html>');
  process.exit(1);
}

const reportPath = path.resolve(args.report);
if (!fs.existsSync(reportPath)) {
  console.error(`오류: 스캔 결과 파일이 없습니다: ${reportPath}`);
  process.exit(1);
}

const templatePath = args.template
  ? path.resolve(args.template)
  : path.join(skillDir, 'assets', 'dashboard-template.html');
if (!fs.existsSync(templatePath)) {
  console.error(`오류: 템플릿이 없습니다: ${templatePath}`);
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
const template = fs.readFileSync(templatePath, 'utf-8');

const placeholder = '/*__REPORT_DATA__*/ null';
if (!template.includes(placeholder)) {
  console.error('오류: 템플릿에서 데이터 자리표시자를 찾지 못했습니다.');
  process.exit(1);
}

// </script> 가 데이터 안에 있으면 스크립트가 조기 종료되므로 막는다.
const json = JSON.stringify(report).replace(/<\//g, '<\\/');
let html = template.replace(placeholder, json);

// 갤러리·탭에서 사업을 구분할 수 있게 제목을 점검 폴더 이름으로 바꾼다.
const folderName = report.root.split(/[\\/]/).filter(Boolean).pop() || '커뮤니티 사업';
html = html.replace('<title>서류 제출 현황판</title>', `<title>${folderName} 서류 현황</title>`);

const outPath = path.resolve(args.out);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html, 'utf-8');

const missing = report.groups.reduce((sum, g) => sum + g.missingRequired.length, 0);
console.log(`현황판 생성: ${outPath}`);
console.log(`단체 ${report.groups.length}곳 · 받아야 할 필수 서류 ${missing}건`);
