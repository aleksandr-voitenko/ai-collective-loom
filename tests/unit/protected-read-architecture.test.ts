import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';

const clientModule = (value: string) =>
  /(^|\/)(participation-client|browser-transport)(?:\.[cm]?[jt]s)?$/.test(value);
const transportModule = (value: string) => /(^|\/)browser-transport(?:\.[cm]?[jt]s)?$/.test(value);
function violationsIn(name: string, text: string) {
  const violations: string[] = [],
    source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const report = (node: ts.Node, message: string) =>
    violations.push(
      `${name}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${message}`,
    );
  function visit(node: ts.Node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      clientModule(node.moduleSpecifier.text)
    ) {
      if (transportModule(node.moduleSpecifier.text) && name !== 'webauthn.ts')
        report(
          node,
          'Internal transport imports belong to the compatibility facade and WebAuthn ceremony.',
        );
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings))
        report(node, 'Use explicit client operations, not a transport namespace.');
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (
            imported === 'request' ||
            (imported === 'transportRequest' && name !== 'AuthorizationBoundary.tsx')
          )
            report(node, 'Protected transport belongs to AuthorizationBoundary.');
        }
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      clientModule(node.moduleSpecifier.text)
    )
      if (!(
        name === 'participation-client.ts' &&
        transportModule(node.moduleSpecifier.text) &&
        node.exportClause &&
        ts.isNamedExports(node.exportClause)
      ))
        report(node, 'Do not re-export the internal transport.');
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const called = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : ts.isElementAccessExpression(expression) &&
              ts.isStringLiteral(expression.argumentExpression)
            ? expression.argumentExpression.text
            : '';
      if (called === 'fetch' && !['browser-transport.ts', 'api.ts'].includes(name))
        report(node, 'Use a boundary read or an explicit session/command operation.');
      if (expression.kind === ts.SyntaxKind.ImportKeyword || called === 'require') {
        const module = node.arguments[0];
        if (
          !module ||
          !ts.isStringLiteral(module) ||
          module.text.includes('participation-client') ||
          module.text.includes('browser-transport')
        )
          report(node, 'Dynamic imports must not provide an alternate request transport.');
      }
    }
    if (
      ts.isNewExpression(node) &&
      ['XMLHttpRequest', 'WebSocket', 'EventSource'].includes(node.expression.getText(source))
    )
      report(node, 'Network clients require an explicit authorization review.');
    ts.forEachChild(node, visit);
  }
  visit(source);
  return violations;
}

// Production imports are the enforcement boundary: no component may get the
// unconstrained transport, even through an alias, namespace or re-export.
test('protected reads cannot bypass the boundary through a transport import or direct network call', async () => {
  const root = fileURLToPath(new URL('../../src/web/', import.meta.url)),
    violations: string[] = [];
  for (const name of await readdir(root, { recursive: true })) {
    if (!/\.tsx?$/.test(name)) continue;
    violations.push(...violationsIn(name, await readFile(join(root, name), 'utf8')));
  }
  assert.deepEqual(violations, []);
});

test('both client entry modules reject alternate transport imports and re-exports', () => {
  for (const module of ['participation-client', 'browser-transport'])
    for (const source of [
      `import {transportRequest as read} from './${module}.js';`,
      `import * as client from './${module}.js';`,
      `export {transportRequest as read} from './${module}.js';`,
      `export * from './${module}.js';`,
      `import('./${module}.js');`,
      `require('./${module}.js');`,
    ])
      assert.ok(violationsIn('Component.tsx', source).length, source);
  assert.ok(
    violationsIn('Component.tsx', "import {sessionRequest} from './browser-transport.js';").length,
  );
  assert.ok(
    violationsIn('webauthn.ts', "import {transportRequest} from './browser-transport.js';").length,
  );
  assert.ok(violationsIn('participation-client.ts', 'fetch(path);').length);
  assert.deepEqual(
    violationsIn(
      'AuthorizationBoundary.tsx',
      "import {transportRequest} from './participation-client.js';",
    ),
    [],
  );
  assert.deepEqual(
    violationsIn('webauthn.ts', "import {sessionRequest} from './browser-transport.js';"),
    [],
  );
  assert.deepEqual(
    violationsIn(
      'participation-client.ts',
      "export {transportRequest,sessionRequest} from './browser-transport.js';",
    ),
    [],
  );
});
