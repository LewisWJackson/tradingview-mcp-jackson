#!/usr/bin/env node
// Pull current Pine Script source from TradingView editor → scripts/current.pine
import CDP from 'chrome-remote-interface';
import { writeFileSync } from 'fs';

const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find(t => t.url?.includes('tradingview.com'));
if (!t) { console.error('No TradingView target'); process.exit(1); }
const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
await c.Runtime.enable();

const src = (await c.Runtime.evaluate({
  expression: '(function(){var els=document.querySelectorAll(".monaco-editor.pine-editor-monaco");for(var idx=0;idx<els.length;idx++){var el=els[idx];var fk;var cur=el;for(var i=0;i<20;i++){if(!cur)break;fk=Object.keys(cur).find(function(k){return k.startsWith("__reactFiber$")});if(fk)break;cur=cur.parentElement}if(!fk)continue;var fiber=cur[fk];for(var d=0;d<15;d++){if(!fiber)break;if(fiber.memoizedProps&&fiber.memoizedProps.value&&fiber.memoizedProps.value.monacoEnv){var env=fiber.memoizedProps.value.monacoEnv;if(env.editor&&typeof env.editor.getEditors==="function"){var eds=env.editor.getEditors();if(eds.length>0)return eds[0].getValue()}}fiber=fiber.return}}return null})()',
  returnByValue: true,
})).result?.value;

if (!src) { console.error('Could not read Pine editor'); await c.close(); process.exit(1); }

const outPath = new URL('../scripts/current.pine', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
writeFileSync(outPath, src);
console.log(`Pulled ${src.split('\n').length} lines → scripts/current.pine`);
await c.close();
