import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { ENGLISH } from '../../../shared/src/translations/en';
import { normalizeMessage } from '@orrery/shared';

const root=fileURLToPath(new URL('../../../',import.meta.url));
function files(directory:string):string[]{
 return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(directory,entry.name)):/\.tsx?$/.test(entry.name)&&!entry.name.includes('.test.')?[join(directory,entry.name)]:[]);
}
const templateKey=(node:ts.TemplateLiteral)=>ts.isNoSubstitutionTemplateLiteral(node)?node.text:node.head.text+node.templateSpans.map((span,index)=>`{${index}}${span.literal.text}`).join('');

test('English catalog covers presentation strings, server metric titles and collected property names',()=>{
 const missing:string[]=[];
 const check=(key:string,path:string)=>{if(/[가-힣]/.test(key)&&!Object.hasOwn(ENGLISH,normalizeMessage(key)))missing.push(`${path.slice(root.length)}: ${key}`)};
 for(const path of [...files(join(root,'web/src')),...files(join(root,'desktop/src')),...files(join(root,'server/src'))]){
  const source=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);
  const name=(node:ts.PropertyName)=>ts.isIdentifier(node)||ts.isStringLiteralLike(node)?node.text:'';
  const inProps=(node:ts.Node):boolean=>!!node.parent&&(ts.isPropertyAssignment(node.parent)&&name(node.parent.name)==='props'||inProps(node.parent));
  function visit(node:ts.Node){
   if(ts.isCallExpression(node)&&/^(uiText|desktopText|this\.text)$/.test(node.expression.getText(source))){
    const value=node.arguments[0];if(value&&ts.isStringLiteralLike(value))check(value.text,path);
   }
   if(ts.isTaggedTemplateExpression(node)&&/^(uiText|desktopText|this\.text)$/.test(node.tag.getText(source)))check(templateKey(node.template),path);
   if(ts.isPropertyAssignment(node)&&path.includes('/server/src/')){
    if(inProps(node))check(name(node.name),path);
    if(name(node.name)==='label'&&ts.isStringLiteralLike(node.initializer))check(node.initializer.text,path);
   }
   ts.forEachChild(node,visit);
  }
  visit(source);
 }
 assert.deepEqual(missing,[],'Add complete English labels instead of relying on generic message matching.');
});
