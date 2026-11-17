#!/usr/bin/env node
/**
 * Lists user-visible English strings (JSX text, text attributes, human-looking string/template literals) so the
 * Thai dictionary can be checked for coverage. Template literals become patterns: ${number-ish} → {n}, else {s}.
 *   node scripts/i18n-extract.mjs [--json out.json] [--missing]
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const walk = (d, out = []) => { for (const n of readdirSync(d)) { const p = join(d, n); if (/node_modules|dist|\.next|__tests__/.test(p)) continue; statSync(p).isDirectory() ? walk(p, out) : /\.(tsx?|ts)$/.test(n) && !/\.d\.ts$|\.test\./.test(n) && out.push(p); } return out; };
const files = [
  ...walk(join(root, 'apps/workbench-web')).filter(f => /\.tsx$/.test(f)),
  ...walk(join(root, 'packages/ui/src')),
  ...walk(join(root, 'modules')).filter(f => /\/src\//.test(f)),
  ...walk(join(root, 'apps/workbench-api/src')),
  join(root, 'packages/shared/src/index.ts'),
];
const SKIP_ATTR = /^(className|href|key|id|role|type|name|value|tone|icon|src|rel|target|method|htmlFor|download|autoComplete|kind|variant|lang|d|viewBox|fill|stroke|style|slug|route|group|sourceModule|severity|state|status|aria-controls|aria-current|aria-activedescendant|data-.*)$/;
const SKIP_CALL = /^(get|post|call|fetch|require|import|push|replace|setItem|getItem|querySelector|querySelectorAll|startsWith|endsWith|includes|test|match|split|join|exec|spawn|execFile|existsSync|join|resolve|dataDir|emit|publish|on|addEventListener|setProperty|createElement|localeCompare|padStart|toLocaleString|toLocaleDateString|toLocaleTimeString|JsonFile|prepare|run|all|log|debug|info|warn|error)$/;
const numeric = (e) => /(\bfb|fmt\w*|nf|gbNum|since|ago|daysAgo|when|toFixed|Math\.|length|count|bytes|Bytes|size|Size|days|Days|hours|minutes|percent|pct|pid|port|index|n\b|i \+ 1|seconds|ms|toLocale|total|free|used|\.(files|scanned|entries|cpu|memory))/.test(e);
const human = (s) => /[A-Za-z]{2,}/.test(s) && !/^(https?:|\/|\.|#|--?\w)/.test(s) && !/^[a-z0-9_.:-]+$/.test(s) && !/\{\{|\\[nt]|^[A-Z0-9_]+$|^[\w.-]+\.(json|ts|tsx|js|md|sqlite|log|csv)$/.test(s) && !/^(GET|POST|PUT|DELETE) /.test(s) && s.length <= 400;

const found = new Map(); // text -> { files: Set, kind }
const add = (text, file, kind) => {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || !human(t)) return;
  const e = found.get(t) ?? { files: new Set(), kind };
  e.files.add(relative(root, file).split('/').slice(0, 4).join('/'));
  found.set(t, e);
};
for (const file of files) {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const isJsxFile = file.endsWith('.tsx');
  const skipped = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isJsxAttribute(p) && SKIP_ATTR.test(p.name.getText())) return true;
      if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isTypeNode(p) || ts.isLiteralTypeNode?.(p)) return true;
      if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
        const callee = p.expression.getText().split('.').pop();
        if (SKIP_CALL.test(callee ?? '')) return true;
      }
      if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
      if (ts.isPropertyAssignment(p) && p.initializer !== node && p.name === node) return true;
      if (ts.isPropertyAssignment(p) && /^(id|slug|route|icon|key|kind|group|type|rule|runtime|category|code|path|command|source|regenerate|clean|sourceModule|action)$/.test(p.name.getText())) return true;
      if (ts.isCaseClause(p) || ts.isBinaryExpression(p) && /===|!==|==|!=/.test(p.operatorToken.getText())) return true;
      if (ts.isRegularExpressionLiteral?.(p)) return true;
      if (ts.isBlock(p) || ts.isSourceFile(p)) break;
    }
    return false;
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) add(node.getText(), file, 'jsx');
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) { if (!skipped(node) && (isJsxFile || /\s/.test(node.text))) add(node.text, file, 'str'); }
    else if (ts.isTemplateExpression(node)) {
      if (!skipped(node)) {
        let s = node.head.text;
        for (const span of node.templateSpans) s += (numeric(span.expression.getText()) ? '{n}' : '{s}') + span.literal.text;
        if (/[A-Za-z]{2,}.*[A-Za-z]{2,}|[A-Za-z]{3,}/.test(s.replace(/\{[ns]\}/g, ''))) add(s, file, 'tpl');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
}
const args = process.argv.slice(2);
let entries = [...found.entries()].map(([text, e]) => ({ text, kind: e.kind, files: [...e.files] }));
if (args.includes('--missing')) {
  const dict = await import(join(root, 'packages/i18n/src/th/index.ts')).catch(() => null);
  void dict;
}
const by = {};
for (const e of entries) for (const f of e.files) by[f] = (by[f] ?? 0) + 1;
console.log(`strings: ${entries.length}`); console.log(by);
const out = args[args.indexOf('--json') + 1];
if (args.includes('--json') && out) writeFileSync(out, JSON.stringify(entries, null, 1));
