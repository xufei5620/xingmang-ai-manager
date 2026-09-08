'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve('.');
function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(full) : /\.(?:tsx?|jsx?)$/.test(entry.name) ? [full] : [];
  });
}
const inputs = filesUnder(path.join(root, 'src'));
const program = ts.createProgram(inputs, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX, allowJs: true, skipLibCheck: true, strict: true });
const checker = program.getTypeChecker();
function runtimeBoundary(entry) {
  const visited = new Set(), imports = [], unresolvedDynamic = [];
  function visit(file) {
    const normalized = path.resolve(file);
    if (visited.has(normalized)) return;
    visited.add(normalized);
    const source = program.getSourceFile(normalized) ?? (fs.existsSync(normalized) ? ts.createSourceFile(normalized, fs.readFileSync(normalized, 'utf8'), ts.ScriptTarget.Latest, true) : null);
    if (!source) return;
    const follow = (specifier, node) => {
      if (!specifier.startsWith('.')) { if (specifier.startsWith('node:') || ['fs', 'path', 'child_process', 'electron'].includes(specifier)) imports.push({ from: path.relative(root, normalized), specifier, forbiddenNode: true }); return; }
      const resolution = ts.resolveModuleName(specifier, normalized, program.getCompilerOptions(), ts.sys).resolvedModule?.resolvedFileName;
      const resolved = resolution ? path.resolve(resolution) : null;
      if (!resolved || resolved.endsWith('.d.ts') || !resolved.startsWith(root + path.sep)) return;
      imports.push({ from: path.relative(root, normalized).replaceAll('\\', '/'), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, specifier, resolved: path.relative(root, resolved).replaceAll('\\', '/') });
      visit(resolved);
    };
    const walk = node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const allTypeSpecifiers = bindings && ts.isNamedImports(bindings) && !clause.name && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly);
        if (!clause?.isTypeOnly && !allTypeSpecifiers) follow(node.moduleSpecifier.text, node);
      }
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const allTypes = node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every(item => item.isTypeOnly);
        if (!allTypes) follow(node.moduleSpecifier.text, node);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments[0] && ts.isStringLiteral(node.arguments[0])) follow(node.arguments[0].text, node);
        else unresolvedDynamic.push({ file: path.relative(root, normalized), expression: node.getText() });
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  visit(entry);
  return { entry: path.relative(root, entry).replaceAll('\\', '/'), localRuntimeModules: [...visited].map(file => path.relative(root, file).replaceAll('\\', '/')).sort(), imports, forbiddenLegacyImports: imports.filter(item => item.resolved?.startsWith('src/') && !item.resolved.startsWith('src/renderer-v2/')), forbiddenNodeImports: imports.filter(item => item.forbiddenNode), unresolvedDynamic };
}
const MAX_VARIANTS = 150;
function scalarValues(node, seen = new Set()) {
  if (!node || seen.has(node) || seen.size > 14) return null;
  const nextSeen = new Set(seen).add(node);
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return [node.text];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return scalarValues(node.expression, nextSeen);
  if (ts.isConditionalExpression(node)) {
    const left = scalarValues(node.whenTrue, nextSeen), right = scalarValues(node.whenFalse, nextSeen);
    return left && right ? [...new Set([...left, ...right])] : null;
  }
  if (ts.isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node);
    const declaration = symbol?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const values = scalarValues(declaration.initializer, nextSeen); if (values) return values;
    }
  }
  const type = checker.getTypeAtLocation(node);
  const types = type.isUnion() ? type.types : [type];
  if (types.length <= MAX_VARIANTS && types.every(value => value.isStringLiteral() || value.isNumberLiteral())) return types.map(value => String(value.value));
  return null;
}
function expand(node) {
  if (!node) return [];
  const scalar = scalarValues(node); if (scalar) return scalar;
  if (ts.isTemplateExpression(node)) {
    let values = [node.head.text];
    for (const span of node.templateSpans) {
      const bits = scalarValues(span.expression) ?? ['$' + '{' + span.expression.getText() + '}'];
      if (values.length * bits.length > MAX_VARIANTS) return [node.getText().slice(1, -1)];
      values = values.flatMap(prefix => bits.map(value => prefix + value + span.literal.text));
    }
    return values;
  }
  if (ts.isConditionalExpression(node)) return [...new Set([...expand(node.whenTrue), ...expand(node.whenFalse)])];
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = expand(node.left), right = expand(node.right);
    if (left.length * right.length <= MAX_VARIANTS) return left.flatMap(a => right.map(b => a + b));
  }
  return ['$' + '{' + node.getText() + '}'];
}
const occurrences = [];
for (const input of inputs) {
  const source = program.getSourceFile(input); if (!source) continue;
  const file = path.relative(root, input).replaceAll('\\', '/');
  const renderer = file.startsWith('src/renderer-v2/') ? 'v2' : 'legacy';
  const scope = /(?:test|spec|fixture|gallery|ComponentGallery)/i.test(path.basename(file)) || /\/testing\//.test(file) ? 'test-or-preview' : 'product';
  const add = (node, expression, syntax, attribute) => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    occurrences.push({ file, line: position.line + 1, column: position.character + 1, renderer, scope, syntax, attribute, expression: expression?.getText(source) ?? null, patterns: expand(expression) });
  };
  const visit = node => {
    if (ts.isJsxAttribute(node) && ['data-testid', 'testId'].includes(node.name.getText(source))) {
      const initializer = node.initializer;
      add(node, initializer && ts.isJsxExpression(initializer) ? initializer.expression : initializer, 'jsx-attribute', node.name.getText(source));
    }
    if (ts.isPropertyAssignment(node) && ['data-testid', 'testId'].includes(node.name.getText(source).replace(/^['"]|['"]$/g, ''))) add(node, node.initializer, 'object-property', node.name.getText(source));
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'setAttribute' && node.arguments[0] && scalarValues(node.arguments[0])?.includes('data-testid')) add(node, node.arguments[1], 'setAttribute', 'data-testid');
    ts.forEachChild(node, visit);
  };
  visit(source);
}
function inventory(renderer) {
  const rows = occurrences.filter(row => row.renderer === renderer && row.scope === 'product');
  const patterns = new Map();
  for (const row of rows) for (const value of row.patterns) {
    if (!patterns.has(value)) patterns.set(value, { pattern: value, kind: value.includes('$' + '{') ? /^\$\{[\s\S]+\}$/.test(value) ? 'forwarded-or-unresolved' : 'dynamic-template' : 'literal', locations: [] });
    patterns.get(value).locations.push({ file: row.file, line: row.line, column: row.column, syntax: row.syntax });
  }
  return { sourceFiles: inputs.filter(file => (file.includes(path.sep + 'renderer-v2' + path.sep) ? 'v2' : 'legacy') === renderer).length, productOccurrences: rows.length, patterns: [...patterns.values()].sort((a, b) => a.pattern.localeCompare(b.pattern)) };
}
const legacy = inventory('legacy'), v2 = inventory('v2');
const current = new Map(v2.patterns.map(row => [row.pattern, row]));
const unmatched = legacy.patterns.filter(row => row.kind !== 'forwarded-or-unresolved' && !current.has(row.pattern));
const escapeRegex = value => value.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
function templateMatches(pattern, literal) {
  if (!pattern.includes('$' + '{') || pattern.startsWith('$' + '{')) return false;
  const parts = pattern.split(/(\$\{[^}]*\})/g);
  return new RegExp('^' + parts.map(part => part.startsWith('$' + '{') ? '.+' : escapeRegex(part)).join('') + '$').test(literal);
}
const dynamicCandidates = unmatched.map(row => ({ ...row, candidates: v2.patterns.filter(other => templateMatches(other.pattern, row.pattern)) })).filter(row => row.candidates.length);
const missing = unmatched.filter(row => !dynamicCandidates.some(candidate => candidate.pattern === row.pattern));
const report = { generatedAt: new Date().toISOString(), method: 'TypeScript AST: JSX attributes, object properties, setAttribute; checker expands literal unions and templates. Dynamic expressions remain symbolic. Exact matches and compatible dynamic candidates are separate; forwarding props never claim coverage.', counts: { files: inputs.length, occurrences: occurrences.length, legacyProductOccurrences: legacy.productOccurrences, legacyPatterns: legacy.patterns.length, v2ProductOccurrences: v2.productOccurrences, v2Patterns: v2.patterns.length, missingExactPatterns: unmatched.length, compatibleDynamicCandidates: dynamicCandidates.length, missingPatterns: missing.length }, runtimeBoundary: runtimeBoundary(path.join(root, 'src/renderer-v2/main.tsx')), legacy, v2, missing, dynamicCandidates, occurrences };
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs/renderer-v2-existing-testids.txt'), JSON.stringify({ method: report.method, counts: report.counts, legacy }, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(root, 'docs/renderer-v2-testid-inventory.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
const markdown = ['# V2 旧 testId 缺失清单', '', '由 TypeScript AST 生成。缺失表示旧模式未在新版出现；不等同功能缺失。泛型透传与不可解析表达式不会自动算作覆盖。存在固定前缀动态模板的项目独立列为候选，需结合运行时检查。', '', '| 未匹配旧模式 | 类型 | 首个旧位置 |', '|---|---|---|', ...missing.map(row => '| ' + row.pattern.replaceAll('|', '\\|') + ' | ' + row.kind + ' | ' + row.locations[0].file + ':' + row.locations[0].line + ' |'), '', '| 有动态匹配候选的旧模式 | 新模板 | 新位置 |', '|---|---|---|', ...dynamicCandidates.map(row => '| ' + row.pattern + ' | ' + row.candidates.map(candidate => candidate.pattern).join(', ') + ' | ' + row.candidates[0].locations[0].file + ':' + row.candidates[0].locations[0].line + ' |')].join('\n');
fs.writeFileSync(path.join(root, 'docs/renderer-v2-missing-testids.md'), markdown + '\n', 'utf8');
console.log(JSON.stringify(report.counts));
if (missing.length || report.runtimeBoundary.forbiddenLegacyImports.length || report.runtimeBoundary.forbiddenNodeImports.length || report.runtimeBoundary.unresolvedDynamic.length) process.exitCode = 1;
