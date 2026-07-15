#!/usr/bin/env node
// Push scripts/current.pine → TradingView editor, then compile
import CDP from 'chrome-remote-interface';
import { readFileSync } from 'fs';

const srcPath = new URL('../scripts/current.pine', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const src = readFileSync(srcPath, 'utf-8');

const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find(t => t.url?.includes('tradingview.com'));
if (!t) { console.error('No TradingView target'); process.exit(1); }
const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
await c.Runtime.enable();

// Inject source. There can be multiple .monaco-editor.pine-editor-monaco
// elements in the DOM (e.g. a stale hidden instance from a previous panel
// state) — only one has the react fiber env attached, so scan all of them
// instead of assuming the first querySelector match is live.
const escaped = JSON.stringify(src);
const set = (await c.Runtime.evaluate({
  expression: `(function(){var els=document.querySelectorAll(".monaco-editor.pine-editor-monaco");for(var idx=0;idx<els.length;idx++){var el=els[idx];var fk;var cur=el;for(var i=0;i<20;i++){if(!cur)break;fk=Object.keys(cur).find(function(k){return k.startsWith("__reactFiber$")});if(fk)break;cur=cur.parentElement}if(!fk)continue;var fiber=cur[fk];for(var d=0;d<15;d++){if(!fiber)break;if(fiber.memoizedProps&&fiber.memoizedProps.value&&fiber.memoizedProps.value.monacoEnv){var env=fiber.memoizedProps.value.monacoEnv;if(env.editor&&typeof env.editor.getEditors==="function"){var eds=env.editor.getEditors();if(eds.length>0){eds[0].setValue(${escaped});return true}}}fiber=fiber.return}}return false})()`,
  returnByValue: true,
})).result?.value;

if (!set) { console.error('Could not inject into Pine editor'); await c.close(); process.exit(1); }
console.log(`Pushed ${src.split('\n').length} lines → Pine editor`);

// Click compile button
const clicked = (await c.Runtime.evaluate({
  expression: '(function(){var btns=document.querySelectorAll("button");for(var i=0;i<btns.length;i++){var t=btns[i].textContent.trim();if(/save and add to chart/i.test(t)){btns[i].click();return t}if(/^(Add to chart|Update on chart)/i.test(t)){btns[i].click();return t}}for(var i=0;i<btns.length;i++){if(btns[i].className.indexOf("saveButton")!==-1&&btns[i].offsetParent!==null){btns[i].click();return "Pine Save"}}return null})()',
  returnByValue: true,
})).result?.value;

console.log('Compile:', clicked || 'keyboard fallback');
if (!clicked) {
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
}

// Wait then check errors
await new Promise(r => setTimeout(r, 3000));
const errors = (await c.Runtime.evaluate({
  expression: '(function(){var els=document.querySelectorAll(".monaco-editor.pine-editor-monaco");for(var idx=0;idx<els.length;idx++){var el=els[idx];var fk;var cur=el;for(var i=0;i<20;i++){if(!cur)break;fk=Object.keys(cur).find(function(k){return k.startsWith("__reactFiber$")});if(fk)break;cur=cur.parentElement}if(!fk)continue;var fiber=cur[fk];for(var d=0;d<15;d++){if(!fiber)break;if(fiber.memoizedProps&&fiber.memoizedProps.value&&fiber.memoizedProps.value.monacoEnv){var env=fiber.memoizedProps.value.monacoEnv;if(env.editor&&typeof env.editor.getEditors==="function"){var eds=env.editor.getEditors();if(eds.length>0){var model=eds[0].getModel();var markers=env.editor.getModelMarkers({resource:model.uri});return markers.map(function(m){return{line:m.startLineNumber,msg:m.message}})}}}fiber=fiber.return}}return[]})()',
  returnByValue: true,
})).result?.value || [];

if (errors.length === 0) {
  console.log('✅ Compiled clean — 0 errors');
} else {
  console.log(`❌ ${errors.length} errors:`);
  errors.forEach(e => console.log(`  Line ${e.line}: ${e.msg}`));
}

await c.close();
