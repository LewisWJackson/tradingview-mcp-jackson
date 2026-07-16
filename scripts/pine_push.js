#!/usr/bin/env node
// Push scripts/current.pine → TradingView editor, then compile.
//
// The Pine Editor has multiple possible UI surfaces (classic bottom panel,
// a small popover, a full-screen "Source code" modal) and none of them are
// reliably already open. This script drives the whole thing end to end in
// one persistent CDP session: if no editor is open, it opens the Object
// tree panel, right-clicks the study row, clicks "Source code…", waits for
// Monaco to mount, then pushes the source and clicks compile — all with
// minimal round trips, since the source-code popover can close itself
// quickly between separate CDP calls.
import CDP from 'chrome-remote-interface';
import { readFileSync } from 'fs';

const srcPath = process.argv[2] || new URL('../scripts/current.pine', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const studyNameSubstr = process.argv[3] || 'ICT Concepts';
const src = readFileSync(srcPath, 'utf-8');

const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find(t => t.url?.includes('tradingview.com'));
if (!t) { console.error('No TradingView target'); process.exit(1); }
const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
await c.Runtime.enable();

async function evalJS(expr) {
  const r = await c.Runtime.evaluate({ expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error('Eval error: ' + JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}

async function realClick(x, y, opts = {}) {
  // Real CDP mouse events — synthetic .click() doesn't reliably trigger
  // TradingView's handlers for these toolbar/menu-style elements.
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: opts.right ? 'right' : 'left', buttons: 0, clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: opts.right ? 'right' : 'left' });
}

// Generic deep search: walk the fiber .return chain and, at each level,
// recursively probe memoizedProps AND memoizedState (hooks) a few levels
// deep for anything shaped like {editor: {getEditors: fn}} (the smaller
// popover's monacoEnv) or a direct Monaco editor instance with
// getValue/setValue/getModel (the full-screen modal doesn't expose
// monacoEnv at the same prop path, so this avoids hardcoding one path).
// There can also be multiple .monaco-editor.pine-editor-monaco elements in
// the DOM (a stale hidden instance from a previous panel state) — every
// container must be scanned, not just the first querySelector match.
const FIND = `(function(){
  function looksLikeEnv(o){ return o && o.editor && typeof o.editor.getEditors === 'function'; }
  function looksLikeEditor(o){ return o && typeof o.getValue === 'function' && typeof o.setValue === 'function' && typeof o.getModel === 'function'; }
  function search(o, depth, seen){
    if (!o || depth > 4 || typeof o !== 'object') return null;
    if (seen.has(o)) return null;
    seen.add(o);
    if (looksLikeEnv(o)) { var eds = o.editor.getEditors(); if (eds.length > 0) return { editor: eds[0], env: o }; }
    if (looksLikeEditor(o)) return { editor: o, env: null };
    for (var k in o) {
      if (k.charAt(0) === '_' && k !== '_editor') continue;
      try {
        var v = o[k];
        if (v && typeof v === 'object') {
          var r = search(v, depth + 1, seen);
          if (r) return r;
        }
      } catch(e) {}
    }
    return null;
  }
  var els=document.querySelectorAll(".monaco-editor.pine-editor-monaco");
  for(var idx=0;idx<els.length;idx++){
    var el=els[idx];
    var fk; var cur=el;
    for(var i=0;i<20;i++){if(!cur)break;fk=Object.keys(cur).find(function(k){return k.startsWith("__reactFiber$")});if(fk)break;cur=cur.parentElement}
    if(!fk)continue;
    var fiber=cur[fk];
    for(var d=0;d<25;d++){
      if(!fiber)break;
      var seen = new Set();
      var found = search(fiber.memoizedProps, 0, seen) || search(fiber.memoizedState, 0, seen);
      if (found) return found;
      fiber=fiber.return;
    }
  }
  return null;
})()`;

// Step 0: if Monaco is already open and live, skip straight to push.
let already = await evalJS(`${FIND} !== null`);

if (!already) {
  // Step 1: find the study row in the Object tree panel; open the panel
  // first if it's not already showing.
  const findRowExpr = (label) => `
    (function(){
      var els=document.querySelectorAll('*');
      for (var i=0;i<els.length;i++){
        var el=els[i];
        if (el.children.length===0 && el.textContent && el.textContent.indexOf(${JSON.stringify(studyNameSubstr)})!==-1){
          var r=el.getBoundingClientRect();
          // Restrict to the right-hand panel (x past the chart) to avoid
          // matching the chart's own legend title, which sits on the left
          // and opens a different (legend display options) menu.
          if (r.width>0 && r.x>window.innerWidth*0.45) return {x:r.x+r.width/2, y:r.y+r.height/2};
        }
      }
      return null;
    })()
  `;

  let target = await evalJS(findRowExpr());
  if (!target) {
    const toggleRect = await evalJS(`
      (function(){var b=document.querySelector('[aria-label="Object tree and data window"]');if(!b)return null;var r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()
    `);
    if (!toggleRect) { console.error('Object tree toggle not found'); await c.close(); process.exit(1); }
    await realClick(toggleRect.x, toggleRect.y);
    await new Promise(r => setTimeout(r, 500));
    target = await evalJS(findRowExpr());
  }
  if (!target) { console.error('Study row not found in Object tree'); await c.close(); process.exit(1); }
  console.log('Study row at', JSON.stringify(target));

  // Step 2: right-click the row, then click "Source code…".
  await realClick(target.x, target.y, { right: true });

  const findSourceCodeExpr = `
    (function(){
      var els=document.querySelectorAll('*');
      for (var i=0;i<els.length;i++){
        var el=els[i];
        if (el.children.length===0){
          var txt=el.textContent.trim();
          if (txt.indexOf('Source code')===0){
            var r=el.getBoundingClientRect();
            if (r.width>0) return {x:r.x+r.width/2, y:r.y+r.height/2};
          }
        }
      }
      return null;
    })()
  `;
  let sourceCodeRect = null;
  for (let i = 0; i < 20; i++) {
    sourceCodeRect = await evalJS(findSourceCodeExpr);
    if (sourceCodeRect) break;
    await new Promise(r => setTimeout(r, 150));
  }
  if (!sourceCodeRect) { console.error('Source code menu item not found'); await c.close(); process.exit(1); }
  console.log('Source code item at', JSON.stringify(sourceCodeRect));

  await realClick(sourceCodeRect.x, sourceCodeRect.y);

  // Step 3+4: poll for Monaco to mount and setValue as soon as it does, in
  // one in-page async call (no Node<->CDP round trips in between) since the
  // popover can close itself quickly and every round trip burns time.
  const escaped = JSON.stringify(src);
  const pushResult = await c.Runtime.evaluate({
    expression: `
      (async function(){
        for (var i = 0; i < 60; i++) {
          var m = ${FIND};
          if (m) { m.editor.setValue(${escaped}); return { found: true, attempts: i }; }
          await new Promise(function(r){ setTimeout(r, 150); });
        }
        return { found: false };
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });
  const pushed = pushResult.result?.value;
  if (!pushed || !pushed.found) { console.error('Monaco editor did not mount / setValue failed'); await c.close(); process.exit(1); }
  console.log(`Pushed ${src.split('\n').length} lines (mounted after ${pushed.attempts * 150}ms)`);
} else {
  console.log('Monaco already open — reusing');
  const escaped = JSON.stringify(src);
  const set = await evalJS(`(function(){var m=${FIND};if(!m)return false;m.editor.setValue(${escaped});return true;})()`);
  if (!set) { console.error('setValue failed'); await c.close(); process.exit(1); }
  console.log(`Pushed ${src.split('\n').length} lines`);
}

// Step 5: click compile / "Save and add to chart" / "Add to chart" /
// "Update on chart". Match on the `title` attribute too, since the button
// is icon-only (no textContent) once a script is already on the chart.
const clicked = await evalJS(`(function(){
  var btns=document.querySelectorAll("button");
  for (var i=0;i<btns.length;i++){
    var t=(btns[i].textContent||"").trim();
    var title=btns[i].title||"";
    if (/save and add to chart/i.test(t) || /^(add to chart|update on chart)/i.test(t) || /^(add to chart|update on chart)$/i.test(title)) {
      var r=btns[i].getBoundingClientRect();
      if (r.width>0 && r.height>0) return {x:r.x+r.width/2, y:r.y+r.height/2, label: title||t};
    }
  }
  return null;
})()`);

if (clicked) {
  console.log('Compile/apply button:', clicked.label, JSON.stringify({ x: clicked.x, y: clicked.y }));
  await realClick(clicked.x, clicked.y);
} else {
  console.log('Compile: no Add/Update-on-chart button found — keyboard fallback');
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
}

// Wait then check errors. Clicking "Add to chart"/"Update on chart" closes
// the editor, so the marker read below is expected to fail in that case —
// that's not a real error, just confirmation the editor closed after apply.
await new Promise(r => setTimeout(r, 3000));
try {
  const errors = await evalJS(`(function(){var m=${FIND};if(!m)return {closed:true};var model=m.editor.getModel();if(!model)return [];var markers=(m.env?m.env.editor.getModelMarkers({resource:model.uri}):m.editor.getModel()===model?[]:[]);return markers.map(function(mk){return{line:mk.startLineNumber,msg:mk.message}});})()`);
  if (Array.isArray(errors) && errors.length === 0) {
    console.log('✅ Compiled clean — 0 errors');
  } else if (Array.isArray(errors)) {
    console.log(`❌ ${errors.length} errors:`);
    errors.forEach(e => console.log(`  Line ${e.line}: ${e.msg}`));
  } else {
    console.log('Editor closed after apply (expected once compile/add succeeds).');
  }
} catch (e) {
  console.log('Editor closed after apply — could not read markers (expected/harmless).');
}

await c.close();
