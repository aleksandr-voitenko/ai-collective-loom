import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

function runtimeImports(text: string): string[] {
  const source = ts.createSourceFile('module.ts', text, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (!clause || !clause.isTypeOnly && (clause.name || !bindings || ts.isNamespaceImport(bindings)
        || bindings.elements.length === 0 || bindings.elements.some(element => !element.isTypeOnly))) {
        imports.push(node.moduleSpecifier.text);
      }
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      if (!clause || ts.isNamespaceExport(clause) || clause.elements.length === 0 || clause.elements.some(element => !element.isTypeOnly)) {
        imports.push(node.moduleSpecifier.text);
      }
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      const argument = node.arguments[0];
      assert.ok(argument && ts.isStringLiteral(argument), 'Server module dependencies must be statically inspectable');
      imports.push(argument.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return imports;
}

test('runtime dependency analysis excludes type-only imports and exports', () => {
  assert.deepEqual(runtimeImports(`
    import type { A } from './type-a.js';
    import { type B } from './type-b.js';
    export type { C } from './type-c.js';
    export { type D } from './type-d.js';
    import './side-effect.js';
    import Default from './default.js';
    import * as Namespace from './namespace.js';
    import { type E, value as alias } from './mixed.js';
    export { type F, value } from './export.js';
    export * from './all.js';
    export * as Namespace from './export-namespace.js';
    const lazy = import('./lazy.js');
    const common = require('./common.js');
  `), ['./side-effect.js', './default.js', './namespace.js', './mixed.js', './export.js', './all.js',
    './export-namespace.js', './lazy.js', './common.js']);
});

test('server runtime dependencies are acyclic and publication guards/storage do not load use cases', async () => {
  const root = fileURLToPath(new URL('../../src/server/', import.meta.url));
  const names = (await readdir(root, { recursive: true })).filter(name => /\.tsx?$/.test(name)).sort();
  const modules = new Set(names);
  const graph = new Map<string, string[]>();
  for (const name of names) {
    const dependencies = runtimeImports(await readFile(join(root, name), 'utf8')).filter(value => value.startsWith('.'))
      .map(value => normalize(join(dirname(name), value)).replace(/\.js$/, '.ts'))
      .filter(value => !value.startsWith('..'));
    for (const dependency of dependencies) assert.ok(modules.has(dependency), `${name}: unresolved ${dependency}`);
    graph.set(name, dependencies);
  }
  const visited = new Set<string>();
  const active: string[] = [];
  const cycles: string[] = [];
  function visit(name: string) {
    const index = active.indexOf(name);
    if (index !== -1) { cycles.push([...active.slice(index), name].join(' -> ')); return; }
    if (visited.has(name)) return;
    visited.add(name);
    active.push(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency);
    active.pop();
  }
  for (const name of names) visit(name);
  assert.deepEqual(cycles, [], 'Runtime import cycles couple initialization and operation boundaries');

  // These leaves may share authority, contracts and fixed SQL writers, but must
  // never regain a runtime dependency on the orchestration they support.
  const leaves = names.filter(name => name === 'modules/publication/guards.ts'
    || name === 'modules/publication/errors.ts' || name.startsWith('db/')
    || /^modules\/publication\/.*-storage\.ts$/.test(name));
  for (const leaf of leaves) {
    const pending = [leaf], reached = new Set<string>();
    while (pending.length) {
      const name = pending.pop()!;
      if (reached.has(name)) continue;
      reached.add(name);
      assert.ok(!name.startsWith('http/') && !/^modules\/(?!publication\/)/.test(name)
        && name !== 'modules/publication/publication.ts', `${leaf} loads a use case through ${name}`);
      pending.push(...graph.get(name) ?? []);
    }
  }
});
