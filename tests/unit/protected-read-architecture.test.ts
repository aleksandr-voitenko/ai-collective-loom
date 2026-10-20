import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import ts from 'typescript';

// Production imports are the enforcement boundary: no component may get the
// unconstrained transport, even through an alias, namespace or re-export.
test('protected reads cannot bypass the boundary through a transport import or direct network call',async()=>{
 const root=fileURLToPath(new URL('../../src/web/',import.meta.url)),violations:string[]=[];
 const clientModule=(value:string)=>/(^|\/)participation-client(?:\.[cm]?[jt]s)?$/.test(value);
 for(const name of await readdir(root,{recursive:true})){
  if(!/\.tsx?$/.test(name))continue;
  const source=ts.createSourceFile(name,await readFile(join(root,name),'utf8'),ts.ScriptTarget.Latest,true);
  const report=(node:ts.Node,message:string)=>violations.push(`${name}:${source.getLineAndCharacterOfPosition(node.getStart()).line+1}: ${message}`);
  function visit(node:ts.Node){
   if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&clientModule(node.moduleSpecifier.text)){
    const bindings=node.importClause?.namedBindings;
    if(bindings&&ts.isNamespaceImport(bindings))report(node,'Use explicit client operations, not a transport namespace.');
    if(bindings&&ts.isNamedImports(bindings))for(const element of bindings.elements){
     const imported=(element.propertyName??element.name).text;
     if(imported==='request'||imported==='transportRequest'&&name!=='AuthorizationBoundary.tsx')report(node,'Protected transport belongs to AuthorizationBoundary.');
    }
   }
   if(ts.isExportDeclaration(node)&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)&&clientModule(node.moduleSpecifier.text))
    report(node,'Do not re-export the internal transport.');
   if(ts.isCallExpression(node)){
    const expression=node.expression;
    const called=ts.isIdentifier(expression)?expression.text:ts.isPropertyAccessExpression(expression)?expression.name.text:
     ts.isElementAccessExpression(expression)&&ts.isStringLiteral(expression.argumentExpression)?expression.argumentExpression.text:'';
    if(called==='fetch'&&!['participation-client.ts','api.ts'].includes(name))report(node,'Use a boundary read or an explicit session/command operation.');
    if(expression.kind===ts.SyntaxKind.ImportKeyword||called==='require'){
     const module=node.arguments[0];
     if(!module||!ts.isStringLiteral(module)||module.text.includes('participation-client'))
      report(node,'Dynamic imports must not provide an alternate request transport.');
    }
   }
   if(ts.isNewExpression(node)&&['XMLHttpRequest','WebSocket','EventSource'].includes(node.expression.getText(source)))
    report(node,'Network clients require an explicit authorization review.');
   ts.forEachChild(node,visit);
  }
  visit(source);
 }
 assert.deepEqual(violations,[]);
});
