/**
 * Core watchlist logic.
 *
 * 2026-05-13: `add`, `remove`, `clear`, `get` refactored to use TV's REST API
 * (see src/core/_rest.js). The old UI-automation code is retained as
 * `addViaUI` / `removeViaUI` for cases where the renderer is mid-state and
 * REST is unreachable (e.g., logged-out cookies). `createList` still uses the
 * UI flow because TV's `/create/` REST endpoint hasn't been discovered yet.
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';
import { waitForChartReady } from '../wait.js';
import * as rest from './_rest.js';

export async function get({ listId } = {}) {
  // Prefer REST: returns the full list including unrendered (virtualized) symbols.
  try {
    const id = listId || await rest.activeListId();
    const data = await rest.getList(id);
    return {
      success: true,
      list_id: data.id,
      list_name: data.name,
      count: data.symbols.length,
      source: 'rest',
      symbols: data.symbols.map(s => s.startsWith('###')
        ? { symbol: s, type: 'section', last: null, change: null, change_percent: null }
        : { symbol: s, last: null, change: null, change_percent: null }),
    };
  } catch (e) {
    // Fall through to DOM scrape (legacy behaviour).
  }
  return getViaDOM();
}

async function getViaDOM() {
  // Legacy DOM scrape — only sees rendered (visible) rows, not the full list.
  const symbols = await evaluate(`
    (function() {
      // Method 1: Try the watchlist widget's internal data
      try {
        var rightArea = document.querySelector('[class*="layout__area--right"]');
        if (!rightArea || rightArea.offsetWidth < 50) return { symbols: [], source: 'panel_closed' };
      } catch(e) {}

      // Method 2: Read data-symbol-full attributes from watchlist rows
      var results = [];
      var seen = {};
      var container = document.querySelector('[class*="layout__area--right"]');
      if (!container) return { symbols: [], source: 'no_container' };

      // Find all elements with symbol data attributes
      var symbolEls = container.querySelectorAll('[data-symbol-full]');
      for (var i = 0; i < symbolEls.length; i++) {
        var sym = symbolEls[i].getAttribute('data-symbol-full');
        if (!sym || seen[sym]) continue;
        seen[sym] = true;

        // Find the row and extract price data
        var row = symbolEls[i].closest('[class*="row"]') || symbolEls[i].parentElement;
        var cells = row ? row.querySelectorAll('[class*="cell"], [class*="column"]') : [];
        var nums = [];
        for (var j = 0; j < cells.length; j++) {
          var t = cells[j].textContent.trim();
          if (t && /^[\\-+]?[\\d,]+\\.?\\d*%?$/.test(t.replace(/[\\s,]/g, ''))) nums.push(t);
        }
        results.push({ symbol: sym, last: nums[0] || null, change: nums[1] || null, change_percent: nums[2] || null });
      }

      if (results.length > 0) return { symbols: results, source: 'data_attributes' };

      // Method 3: Scan for ticker-like text in the right panel
      var items = container.querySelectorAll('[class*="symbolName"], [class*="tickerName"], [class*="symbol-"]');
      for (var k = 0; k < items.length; k++) {
        var text = items[k].textContent.trim();
        if (text && /^[A-Z][A-Z0-9.:!]{0,20}$/.test(text) && !seen[text]) {
          seen[text] = true;
          results.push({ symbol: text, last: null, change: null, change_percent: null });
        }
      }

      return { symbols: results, source: results.length > 0 ? 'text_scan' : 'empty' };
    })()
  `);

  return {
    success: true,
    count: symbols?.symbols?.length || 0,
    source: symbols?.source || 'unknown',
    symbols: symbols?.symbols || [],
  };
}

export async function add({ symbol, listId } = {}) {
  if (!symbol || typeof symbol !== 'string') throw new Error('add: symbol required');
  // REST path — fast, no UI dependence.
  try {
    const id = listId || await rest.activeListId();
    // REST is strict on symbol format. Resolve bare tickers via search.
    const resolved = symbol.includes(':') ? symbol : (await rest.resolveSymbol(symbol)) || symbol;
    await rest.append(id, [resolved]);
    return { success: true, symbol: resolved, list_id: id, action: 'added', via: 'rest' };
  } catch (restErr) {
    // Fall through to UI flow only if REST clearly failed (network / 4xx / no list).
    if (process.env.TV_MCP_NO_UI_FALLBACK === '1') throw restErr;
    return addViaUI({ symbol });
  }
}

async function addViaUI({ symbol }) {
  // Use keyboard shortcut to open symbol search in watchlist, type symbol, press Enter
  const c = await getClient();

  // First ensure watchlist panel is open
  const panelState = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[aria-label*="Watchlist"]');
      if (!btn) return { error: 'Watchlist button not found' };
      var isActive = btn.getAttribute('aria-pressed') === 'true'
        || btn.classList.toString().indexOf('Active') !== -1
        || btn.classList.toString().indexOf('active') !== -1;
      if (!isActive) { btn.click(); return { opened: true }; }
      return { opened: false };
    })()
  `);

  if (panelState?.error) throw new Error(panelState.error);
  if (panelState?.opened) await new Promise(r => setTimeout(r, 500));

  // Click the "Add symbol" button (various selectors)
  const addClicked = await evaluate(`
    (function() {
      var selectors = [
        '[data-name="add-symbol-button"]',
        '[aria-label="Add symbol"]',
        '[aria-label*="Add symbol"]',
        'button[class*="addSymbol"]',
      ];
      for (var s = 0; s < selectors.length; s++) {
        var btn = document.querySelector(selectors[s]);
        if (btn && btn.offsetParent !== null) { btn.click(); return { found: true, selector: selectors[s] }; }
      }
      // Fallback: find + button in right panel
      var container = document.querySelector('[class*="layout__area--right"]');
      if (container) {
        var buttons = container.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
          var ariaLabel = buttons[i].getAttribute('aria-label') || '';
          if (/add.*symbol/i.test(ariaLabel) || buttons[i].textContent.trim() === '+') {
            buttons[i].click();
            return { found: true, method: 'fallback' };
          }
        }
      }
      return { found: false };
    })()
  `);

  if (!addClicked?.found) throw new Error('Add symbol button not found in watchlist panel');
  await new Promise(r => setTimeout(r, 300));

  // Type the symbol into the search input
  await c.Input.insertText({ text: symbol });
  await new Promise(r => setTimeout(r, 500));

  // Press Enter to select the first result
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  await new Promise(r => setTimeout(r, 300));

  // Press Escape to close search
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });

  return { success: true, symbol, action: 'added', via: 'ui' };
}

export async function remove({ symbol, listId } = {}) {
  if (!symbol || typeof symbol !== 'string') throw new Error('remove: symbol required');
  // REST path — handles full list incl. unrendered rows.
  try {
    const id = listId || await rest.activeListId();
    // REST is strict; try canonical form first, then bare, then fully-resolved.
    const variants = [];
    if (symbol.includes(':')) variants.push(symbol);
    else {
      const r = await rest.resolveSymbol(symbol);
      if (r) variants.push(r);
      variants.push(symbol);
    }
    // Read current list to find which variant matches.
    const data = await rest.getList(id);
    const match = variants.find(v => data.symbols.includes(v))
      || data.symbols.find(s => s.split(':').pop() === symbol.split(':').pop());
    if (!match) throw new Error(`Symbol "${symbol}" not found in list ${id}`);
    await rest.removeSymbols(id, [match]);
    return { success: true, symbol: match, list_id: id, action: 'removed', via: 'rest' };
  } catch (restErr) {
    if (process.env.TV_MCP_NO_UI_FALLBACK === '1') throw restErr;
    return removeViaUI({ symbol });
  }
}

async function removeViaUI({ symbol }) {
  const c = await getClient();

  // Ensure watchlist panel is open
  const panelState = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[aria-label*="Watchlist"]');
      if (!btn) return { error: 'Watchlist button not found' };
      var isActive = btn.getAttribute('aria-pressed') === 'true'
        || btn.classList.toString().indexOf('Active') !== -1
        || btn.classList.toString().indexOf('active') !== -1;
      if (!isActive) { btn.click(); return { opened: true }; }
      return { opened: false };
    })()
  `);
  if (panelState?.error) throw new Error(panelState.error);
  if (panelState?.opened) await new Promise(r => setTimeout(r, 500));

  // Find the row matching the symbol; tolerate prefix differences (BATS:AAPL, NASDAQ:AAPL, AAPL)
  const found = await evaluate(`
    (function() {
      var target = ${JSON.stringify(symbol)};
      var bare = target.split(':').pop();
      var rows = document.querySelectorAll('[data-symbol-full]');
      var match = null;
      for (var i = 0; i < rows.length; i++) {
        var sym = rows[i].getAttribute('data-symbol-full') || '';
        if (sym === target || sym.split(':').pop() === bare) { match = rows[i]; break; }
      }
      if (!match) return { found: false };
      match.scrollIntoView({ block: 'center' });
      var rect = match.getBoundingClientRect();
      return {
        found: true,
        symbol_resolved: match.getAttribute('data-symbol-full'),
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    })()
  `);
  if (!found?.found) throw new Error(`Symbol "${symbol}" not found in watchlist`);

  // Right-click the row to open the context menu
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: found.x, y: found.y });
  await new Promise(r => setTimeout(r, 100));
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: found.x, y: found.y, button: 'right', clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: found.x, y: found.y, button: 'right', clickCount: 1 });
  await new Promise(r => setTimeout(r, 450));

  // Click the "Remove" menu item
  const clicked = await evaluate(`
    (function() {
      var menuRoots = document.querySelectorAll('[class*="menuWrap"], [class*="menu-"], [role="menu"], [class*="ui-Menu"]');
      var candidates = [];
      menuRoots.forEach(function(menu) {
        menu.querySelectorAll('[role="menuitem"], button, span, div, a').forEach(function(el) {
          var t = (el.textContent || '').trim();
          if (/^Remove(\\s*from list)?$|^Delete$/i.test(t) && el.offsetParent !== null) candidates.push(el);
        });
      });
      if (candidates.length === 0) {
        var all = document.querySelectorAll('span, div, button, a');
        for (var i = 0; i < all.length; i++) {
          var t = (all[i].textContent || '').trim();
          if (/^Remove$/i.test(t) && all[i].offsetParent !== null) {
            candidates.push(all[i]);
            if (candidates.length > 3) break;
          }
        }
      }
      if (candidates.length === 0) return { clicked: false };
      candidates[0].click();
      return { clicked: true, text: candidates[0].textContent.trim() };
    })()
  `);

  // Always escape any lingering menu
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  if (!clicked?.clicked) throw new Error('Remove menu item not found after right-click');

  return { success: true, symbol: found.symbol_resolved, action: 'removed', menu_text: clicked.text, via: 'ui' };
}

// --- Cross-list set ops (Phase 5) ---

async function resolveLists(refs) {
  // refs: array of strings (names) or numbers (ids)
  return Promise.all(refs.map(async (ref) => {
    const data = typeof ref === 'number' ? await rest.findById(ref) : await rest.findByName(ref);
    if (!data) throw new Error(`Watchlist not found: ${ref}`);
    return {
      id: data.id,
      name: data.name,
      symbols: data.symbols.filter(s => typeof s === 'string' && !s.startsWith('###')),
    };
  }));
}

export async function setOp({ op, lists, strip_exchange } = {}) {
  if (!Array.isArray(lists) || lists.length < 1) throw new Error('setOp: lists array required');
  const resolved = await resolveLists(lists);
  // Normalize: optional exchange-prefix stripping for cross-source comparisons
  const norm = strip_exchange
    ? (s) => s.includes(':') ? s.split(':').pop() : s
    : (s) => s;
  const normMap = new Map(); // norm -> original (first seen)
  for (const l of resolved) {
    for (const s of l.symbols) {
      const k = norm(s);
      if (!normMap.has(k)) normMap.set(k, s);
    }
  }
  let resultNorm;
  switch (op) {
    case 'merge': {
      const seen = new Set();
      resultNorm = [];
      for (const l of resolved) {
        for (const s of l.symbols) {
          const k = norm(s);
          if (!seen.has(k)) { seen.add(k); resultNorm.push(k); }
        }
      }
      break;
    }
    case 'intersect': {
      if (resolved.length < 2) throw new Error('intersect: needs >= 2 lists');
      const sets = resolved.map(l => new Set(l.symbols.map(norm)));
      resultNorm = [...sets[0]].filter(s => sets.slice(1).every(set => set.has(s)));
      break;
    }
    case 'subtract': {
      if (resolved.length !== 2) throw new Error('subtract: needs exactly 2 lists (A - B)');
      const exclude = new Set(resolved[1].symbols.map(norm));
      resultNorm = resolved[0].symbols.map(norm).filter(s => !exclude.has(s));
      break;
    }
    default: throw new Error(`Unknown op: ${op}`);
  }
  const symbols = resultNorm.map(k => normMap.get(k) || k);
  return {
    success: true,
    op,
    source_lists: resolved.map(l => ({ id: l.id, name: l.name, count: l.symbols.length })),
    result_count: symbols.length,
    symbols,
  };
}

// --- Section ops (Phase 5) ---

const INV_PLUS = '⁤';

function normalizeSectionName(name) {
  // Strip any leading ### and U+2064; we add them back consistently.
  return String(name).replace(/^###[⁤\s]*/, '').trim();
}

function formatSectionHeader(name) {
  const stripped = normalizeSectionName(name);
  return `###${INV_PLUS}${stripped}`;
}

async function findListOrThrow({ name, listId }) {
  let target;
  if (listId) target = await rest.findById(listId);
  else if (name) target = await rest.findByName(name);
  else throw new Error('name or listId required');
  if (!target) throw new Error(`Watchlist not found: ${name || listId}`);
  return target;
}

function findSectionInList(symbols, sectionName) {
  const target = normalizeSectionName(sectionName);
  return symbols.find(s => typeof s === 'string' && s.startsWith('###') &&
    normalizeSectionName(s) === target);
}

export async function sectionAdd({ name, listId, sectionName, beforeSymbol, atEnd } = {}) {
  if (!sectionName) throw new Error('sectionAdd: sectionName required');
  const target = await findListOrThrow({ name, listId });
  if (findSectionInList(target.symbols, sectionName)) {
    return { success: false, error: `Section "${sectionName}" already exists`, list_id: target.id };
  }
  const header = formatSectionHeader(sectionName);
  // /append/ first
  await rest.append(target.id, [header]);
  // Compute desired order: insert header before beforeSymbol (or at end if atEnd)
  let newOrder;
  if (atEnd || !beforeSymbol) {
    newOrder = [...target.symbols, header];
  } else {
    const idx = target.symbols.indexOf(beforeSymbol)
      || target.symbols.findIndex(s => s.split(':').pop() === beforeSymbol.split(':').pop());
    if (idx < 0) throw new Error(`beforeSymbol "${beforeSymbol}" not found in list`);
    newOrder = [...target.symbols.slice(0, idx), header, ...target.symbols.slice(idx)];
  }
  // /replace/ to position it
  await rest.replaceOrder(target.id, newOrder);
  return { success: true, list_id: target.id, list_name: target.name, header, position: atEnd || !beforeSymbol ? 'end' : `before ${beforeSymbol}` };
}

export async function sectionRemove({ name, listId, sectionName } = {}) {
  if (!sectionName) throw new Error('sectionRemove: sectionName required');
  const target = await findListOrThrow({ name, listId });
  const match = findSectionInList(target.symbols, sectionName);
  if (!match) return { success: false, error: `Section "${sectionName}" not found`, list_id: target.id };
  await rest.removeSymbols(target.id, [match]);
  return { success: true, list_id: target.id, list_name: target.name, removed: match };
}

export async function sectionRename({ name, listId, fromName, toName } = {}) {
  if (!fromName || !toName) throw new Error('sectionRename: fromName + toName required');
  const target = await findListOrThrow({ name, listId });
  const match = findSectionInList(target.symbols, fromName);
  if (!match) throw new Error(`Section "${fromName}" not found`);
  const newHeader = formatSectionHeader(toName);
  if (findSectionInList(target.symbols, toName)) {
    throw new Error(`Section "${toName}" already exists — cannot rename`);
  }
  // remove old, append new, replace to put new in old's position
  const idx = target.symbols.indexOf(match);
  await rest.removeSymbols(target.id, [match]);
  await rest.append(target.id, [newHeader]);
  const newOrder = [...target.symbols.slice(0, idx), newHeader, ...target.symbols.slice(idx + 1)];
  await rest.replaceOrder(target.id, newOrder);
  return { success: true, list_id: target.id, list_name: target.name, from: match, to: newHeader };
}

// --- File ↔ TV sync (Phase 2) ---

function parseListFile(text) {
  // One symbol or ###SECTION header per non-empty line. Comments (// or #) ignored.
  return text.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('//') && !(l.startsWith('#') && !l.startsWith('###')));
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

export async function exportList({ name, listId, outPath } = {}) {
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');
  let target;
  if (listId) target = await rest.findById(listId);
  else if (name) target = await rest.findByName(name);
  else throw new Error('exportList: name or listId required');
  if (!target) throw new Error(`No watchlist found for ${name || listId}`);
  const date = new Date().toISOString().slice(0, 10);
  const defaultDir = path.join(os.homedir(), 'Downloads', 'watchlists');
  fs.mkdirSync(defaultDir, { recursive: true });
  const file = outPath || path.join(defaultDir, `${slugify(target.name)}-${date}.txt`);
  fs.writeFileSync(file, target.symbols.join('\n') + '\n');
  return {
    success: true,
    list_id: target.id,
    list_name: target.name,
    symbol_count: target.symbols.length,
    section_count: target.symbols.filter(s => s.startsWith('###')).length,
    file,
  };
}

export async function exportAll({ outDir } = {}) {
  // Bulk-dump every named watchlist to .txt in one go. Default destination
  // is the vault so backups inherit Syncthing replication + Obsidian
  // browsing. Returns a manifest of files written.
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');
  const date = new Date().toISOString().slice(0, 10);
  const defaultDir = path.join(os.homedir(), 'virtuoso-vault', '04-Trading', 'Watchlists', date);
  const targetDir = outDir || defaultDir;
  fs.mkdirSync(targetDir, { recursive: true });

  const all = await rest.listAll();
  const manifest = [];
  for (const list of all) {
    try {
      const safeName = slugify(list.name) || `list-${list.id}`;
      const file = path.join(targetDir, `${safeName}.txt`);
      fs.writeFileSync(file, list.symbols.join('\n') + '\n');
      manifest.push({
        id: list.id,
        name: list.name,
        symbol_count: list.symbols.length,
        section_count: list.symbols.filter(s => s.startsWith('###')).length,
        active: !!list.active,
        modified: list.modified,
        file,
      });
    } catch (e) {
      manifest.push({ id: list.id, name: list.name, error: e.message });
    }
  }
  // Write an index.md alongside for quick browsing in Obsidian
  const indexLines = [
    `---`, `title: Watchlist Backup ${date}`, `created: ${date}`, `tags: [auspex, watchlists, backup]`, `---`,
    ``, `# Watchlist Backup — ${date}`, ``,
    `> Exported ${manifest.length} watchlists from TradingView Desktop via REST. Source of truth: TV account; this folder is a snapshot for disaster recovery + audit trail. Re-run \`tv watchlist export-all\` to refresh.`, ``,
    `| List | Symbols | Sections | Modified |`,
    `|---|---|---|---|`,
  ];
  for (const m of manifest) {
    if (m.error) {
      indexLines.push(`| ${m.name} | – | – | ❌ ${m.error} |`);
    } else {
      const link = path.basename(m.file);
      indexLines.push(`| [[${date}/${link.replace('.txt','')}\\|${m.name}]]${m.active ? ' ⭐' : ''} | ${m.symbol_count} | ${m.section_count} | ${m.modified?.slice(0,10) || '–'} |`);
    }
  }
  const indexFile = path.join(targetDir, 'index.md');
  fs.writeFileSync(indexFile, indexLines.join('\n') + '\n');

  return {
    success: manifest.every(m => !m.error),
    list_count: all.length,
    out_dir: targetDir,
    total_symbols: manifest.reduce((s, m) => s + (m.symbol_count || 0), 0),
    manifest,
    index_file: indexFile,
  };
}

export async function uploadList({ filePath, newName } = {}) {
  if (!filePath) throw new Error('uploadList: filePath required');
  const fs = await import('fs');
  const path = await import('path');
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const symbols = parseListFile(fs.readFileSync(filePath, 'utf8'));
  if (symbols.length === 0) throw new Error('File contains no symbols');
  const name = newName || path.basename(filePath).replace(/\.[^.]+$/, '');
  // Step 1: create blank list via UI flow
  await createList({ name });
  // Step 2: find the new list's id (listAll, match by name + newest)
  const all = await rest.listAll();
  const matches = all.filter(l => l.name === name).sort((a, b) => new Date(b.created) - new Date(a.created));
  if (matches.length === 0) throw new Error(`Created list "${name}" not found in listAll`);
  const newList = matches[0];
  // Step 3: bulk-append all symbols
  await rest.append(newList.id, symbols);
  return {
    success: true,
    list_id: newList.id,
    list_name: name,
    symbol_count: symbols.length,
    section_count: symbols.filter(s => s.startsWith('###')).length,
    file: filePath,
  };
}

function diffSymbols(wanted, current) {
  const wantedSet = new Set(wanted);
  const currentSet = new Set(current);
  return {
    to_add: wanted.filter(s => !currentSet.has(s)),
    to_remove: current.filter(s => !wantedSet.has(s)),
    reorder_needed: (() => {
      const after = current.filter(s => wantedSet.has(s)).concat(wanted.filter(s => !currentSet.has(s)));
      return JSON.stringify(after) !== JSON.stringify(wanted);
    })(),
  };
}

export async function diffList({ filePath, name, listId } = {}) {
  if (!filePath) throw new Error('diffList: filePath required');
  const fs = await import('fs');
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const wanted = parseListFile(fs.readFileSync(filePath, 'utf8'));
  let target;
  if (listId) target = await rest.findById(listId);
  else if (name) target = await rest.findByName(name);
  else throw new Error('diffList: name or listId required');
  if (!target) throw new Error(`No watchlist found for ${name || listId}`);
  const diff = diffSymbols(wanted, target.symbols);
  return {
    success: true,
    list_id: target.id,
    list_name: target.name,
    file: filePath,
    local_count: wanted.length,
    remote_count: target.symbols.length,
    to_add: diff.to_add,
    to_remove: diff.to_remove,
    reorder_needed: diff.reorder_needed,
    in_sync: diff.to_add.length === 0 && diff.to_remove.length === 0 && !diff.reorder_needed,
  };
}

export async function syncList({ filePath, name, listId } = {}) {
  if (!filePath) throw new Error('syncList: filePath required');
  const fs = await import('fs');
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const wanted = parseListFile(fs.readFileSync(filePath, 'utf8'));
  let target;
  if (listId) target = await rest.findById(listId);
  else if (name) target = await rest.findByName(name);
  else throw new Error('syncList: name or listId required');
  if (!target) throw new Error(`No watchlist found for ${name || listId}`);
  const diff = diffSymbols(wanted, target.symbols);
  const applied = [];
  if (diff.to_add.length > 0) {
    await rest.append(target.id, diff.to_add);
    applied.push(`append:${diff.to_add.length}`);
  }
  if (diff.to_remove.length > 0) {
    await rest.removeSymbols(target.id, diff.to_remove);
    applied.push(`remove:${diff.to_remove.length}`);
  }
  if (diff.reorder_needed) {
    await rest.replaceOrder(target.id, wanted);
    applied.push('reorder');
  }
  return {
    success: true,
    list_id: target.id,
    list_name: target.name,
    file: filePath,
    applied,
    added: diff.to_add,
    removed: diff.to_remove,
    reordered: diff.reorder_needed,
    in_sync: applied.length === 0,
  };
}

export async function listAll() {
  const all = await rest.listAll();
  return {
    success: true,
    count: all.length,
    lists: all.map(l => ({
      id: l.id,
      name: l.name,
      symbol_count: l.symbols.length,
      section_count: l.symbols.filter(s => typeof s === 'string' && s.startsWith('###')).length,
      active: !!l.active,
      shared: !!l.shared,
      modified: l.modified,
      created: l.created,
    })),
  };
}

export async function deleteAlertsBatch({ alert_ids } = {}) {
  if (!Array.isArray(alert_ids) || alert_ids.length === 0) {
    throw new Error('deleteAlertsBatch: alert_ids array required');
  }
  const resp = await rest.deleteAlerts(alert_ids);
  return { success: resp && resp.s === 'ok', deleted_count: alert_ids.length, alert_ids, response: resp };
}

// --- Bulk alerts (Phase 3) ---

export async function bulkAlert({
  name, listId,
  threshold, delta_pct,
  condition_type = 'cross',
  resolution = '1',
  message_template = '{symbol} {condition} {threshold}',
  notification = { popup: true, mobile_push: true, email: false },
  max_alerts = 50,
  dry_run = false,
} = {}) {
  if (typeof threshold !== 'number' && typeof delta_pct !== 'number') {
    throw new Error('bulkAlert: either `threshold` (absolute) or `delta_pct` (% from current price) required');
  }
  const target = await findListOrThrow({ name, listId });
  const symbols = target.symbols.filter(s => !s.startsWith('###')).slice(0, max_alerts);
  if (symbols.length === 0) return { success: false, error: 'No symbols in list' };

  const results = { created: [], failed: [] };
  for (const sym of symbols) {
    try {
      // Compute per-symbol threshold
      let perSymbolThreshold = threshold;
      if (typeof delta_pct === 'number') {
        // Get current price via quote_get-equivalent (read last bar close from chart)
        // Cheaper than switching chart: use TV's symbol_search to get a current quote
        const quote = await evaluateAsync(`
          (async () => {
            // Fetch a quote from TV's symbol info endpoint
            const r = await fetch('https://symbol-search.tradingview.com/symbol_search/?text=' + encodeURIComponent(${JSON.stringify(sym.includes(':') ? sym.split(':').pop() : sym)}) + '&exchange=' + ${JSON.stringify(sym.includes(':') ? sym.split(':')[0] : '')} + '&hl=1&lang=en&type=&domain=production', { credentials: 'include' });
            const arr = await r.json();
            return Array.isArray(arr) && arr[0] ? arr[0] : null;
          })()
        `);
        if (!quote || !quote.last_price) {
          results.failed.push({ symbol: sym, error: `Could not fetch current price for delta_pct calculation` });
          continue;
        }
        perSymbolThreshold = Number(quote.last_price) * (1 + delta_pct / 100);
        perSymbolThreshold = Math.round(perSymbolThreshold * 100) / 100; // 2dp
      }
      const conditionWord = condition_type === 'cross' ? 'Crossing'
        : condition_type === 'greater_than' ? '>'
        : condition_type === 'less_than' ? '<'
        : condition_type;
      const msg = message_template
        .replace('{symbol}', sym.includes(':') ? sym.split(':').pop() : sym)
        .replace('{condition}', conditionWord)
        .replace('{threshold}', String(perSymbolThreshold));
      if (dry_run) {
        results.created.push({ symbol: sym, threshold: perSymbolThreshold, message: msg, dry_run: true });
        continue;
      }
      const resp = await rest.createAlert({
        symbol: sym,
        threshold: perSymbolThreshold,
        message: msg,
        resolution,
        conditionType: condition_type,
        notification,
      });
      if (resp && resp.s === 'ok' && resp.r && resp.r.alert_id) {
        results.created.push({ symbol: sym, threshold: perSymbolThreshold, message: msg, alert_id: resp.r.alert_id });
      } else {
        results.failed.push({ symbol: sym, error: (resp && resp.errmsg) || 'unknown error', response: resp });
      }
      // Pace ~200ms between calls to avoid CDP overload
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      results.failed.push({ symbol: sym, error: e.message });
    }
  }
  return {
    success: results.failed.length === 0,
    list_name: target.name,
    list_id: target.id,
    mode: typeof delta_pct === 'number' ? `delta_pct:${delta_pct}%` : `absolute:${threshold}`,
    condition_type, resolution,
    created_count: results.created.length,
    failed_count: results.failed.length,
    created: results.created,
    failed: results.failed.slice(0, 10),
    dry_run,
  };
}

// --- Pine-aware screener (Phase 4) ---

// Module-level serialization gate. Concurrent screen() calls crash CDP
// (parallel chart.setSymbol() calls clobber each other and the renderer
// EPIPEs). All screen() invocations chain through this Promise so only
// one runs at a time across the whole process.
let _screenChain = Promise.resolve();
let _screenInFlight = false;

function evalCondition({ op, value, actual }) {
  // Numeric coercion — TV stores values as strings
  const n = parseFloat(String(actual).replace(/[%,$\s]/g, ''));
  if (Number.isNaN(n)) return { matched: false, reason: 'non-numeric value', actual };
  switch (op) {
    case '<':  return { matched: n <  value, actual: n };
    case '<=': return { matched: n <= value, actual: n };
    case '>':  return { matched: n >  value, actual: n };
    case '>=': return { matched: n >= value, actual: n };
    case '==': return { matched: n === value, actual: n };
    case '!=': return { matched: n !== value, actual: n };
    case 'between': {
      const [lo, hi] = Array.isArray(value) ? value : [null, null];
      return { matched: lo !== null && hi !== null && n >= lo && n <= hi, actual: n };
    }
    default: throw new Error(`Unknown op: ${op}`);
  }
}

export async function screen(args = {}) {
  // Serialize: only one screen() may execute at a time across the process.
  // Subsequent callers await the prior chain, then take their turn.
  const prevChain = _screenChain;
  let release;
  _screenChain = new Promise(r => { release = r; });
  try {
    if (_screenInFlight) {
      // Caller will wait their turn. Annotate response so caller knows.
      await prevChain;
    }
    _screenInFlight = true;
    return await _screen_impl(args);
  } finally {
    _screenInFlight = false;
    release();
  }
}

async function _screen_impl({ name, listId, study, field, op, value, timeframe, max_symbols = 50, per_symbol_timeout_ms = 5000, force_when_hidden = false } = {}) {
  if (!study || !field || !op || value === undefined) {
    throw new Error('screen: study + field + op + value required (e.g., study="Relative Strength Index", field="RSI", op="<", value=30)');
  }

  // Visibility check: when TV window is hidden (user switched apps), the
  // renderer throttles and dataWindowView returns stale values across symbol
  // switches — observed 2026-05-14 on 45-symbol screen, all 45 returned
  // identical RSI. Refuse to run unless caller passes force_when_hidden.
  const vis = await evaluate(`
    ({ hidden: document.hidden, state: document.visibilityState })
  `);
  if (vis && vis.hidden && !force_when_hidden) {
    return {
      success: false,
      error: 'TV window is hidden (visibilityState=' + vis.state + '). Renderer throttling will return stale indicator values. Bring TradingView to the foreground and retry, or pass force_when_hidden=true to override (risks stale results).',
      tradingview_visibility: vis,
    };
  }
  const target = await findListOrThrow({ name, listId });
  const symbols = target.symbols.filter(s => !s.startsWith('###')).slice(0, max_symbols);
  if (symbols.length === 0) return { success: false, error: 'No symbols in list (after stripping section headers)' };

  // Save current chart state to restore at end
  const originalState = await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      return { symbol: chart.symbol(), timeframe: chart.resolution() };
    })()
  `);

  const results = { matched: [], unmatched: [], errors: [] };
  const studyMatch = (n) => (n || '').toLowerCase().includes(study.toLowerCase());

  // Track stale values: if 3+ consecutive symbols return the same value,
  // TV likely went hidden mid-run — bail with a clear error rather than
  // returning misleading uniform results.
  let lastValue = null;
  let stableStreak = 0;
  const STALE_STREAK_LIMIT = 3;

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    try {
      // Set symbol — TV's setSymbol takes (symbol, opts), not a callback API
      await evaluate(`
        (function() {
          window.TradingViewApi._activeChartWidgetWV.value().setSymbol(${JSON.stringify(sym)}, {});
        })()
      `);
      // Poll chart.symbol() until it changes — direct API signal beats DOM scraping
      {
        const bare = sym.includes(':') ? sym.split(':').pop() : sym;
        const deadline = Date.now() + per_symbol_timeout_ms;
        while (Date.now() < deadline) {
          const current = await evaluate(`window.TradingViewApi._activeChartWidgetWV.value().symbol()`);
          if (current && (current === sym || current.split(':').pop() === bare)) break;
          await new Promise(r => setTimeout(r, 200));
        }
      }
      // Set timeframe if requested
      if (timeframe) {
        await evaluate(`
          (function() {
            window.TradingViewApi._activeChartWidgetWV.value().setResolution(${JSON.stringify(timeframe)}, {});
          })()
        `);
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          const cur = await evaluate(`window.TradingViewApi._activeChartWidgetWV.value().resolution()`);
          if (cur === timeframe) break;
          await new Promise(r => setTimeout(r, 150));
        }
      }
      // Extra settle for indicators to recompute on the new bar series
      await new Promise(r => setTimeout(r, 600));
      // Poll for study to appear + have non-null values
      const deadline = Date.now() + per_symbol_timeout_ms;
      let study_values = null;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 250));
        const probe = await evaluate(`
          (function() {
            var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
            var sources = chart.model().model().dataSources();
            for (var si = 0; si < sources.length; si++) {
              var s = sources[si];
              if (!s.metaInfo) continue;
              try {
                var meta = s.metaInfo();
                var name = meta.description || meta.shortDescription || '';
                if (!name.toLowerCase().includes(${JSON.stringify(study.toLowerCase())})) continue;
                var dwv = s.dataWindowView();
                if (!dwv) continue;
                var items = dwv.items();
                if (!items) continue;
                var values = {};
                for (var i = 0; i < items.length; i++) {
                  var item = items[i];
                  if (item._value && item._value !== '∅' && item._title) values[item._title] = item._value;
                }
                if (Object.keys(values).length > 0) return { name: name, values: values };
              } catch(e) {}
            }
            return null;
          })()
        `);
        if (probe && probe.values && (probe.values[field] !== undefined)) { study_values = probe; break; }
      }
      if (!study_values) {
        results.errors.push({ symbol: sym, error: `Study "${study}" not found or field "${field}" missing within ${per_symbol_timeout_ms}ms` });
        continue;
      }
      const actualRaw = study_values.values[field];
      const result = evalCondition({ op, value, actual: actualRaw });
      // Stale-streak detection
      if (lastValue !== null && result.actual === lastValue) {
        stableStreak++;
        if (stableStreak >= STALE_STREAK_LIMIT) {
          // Re-check visibility — most likely TV went hidden
          const visNow = await evaluate(`({ hidden: document.hidden, state: document.visibilityState })`).catch(() => null);
          results.errors.push({
            symbol: sym,
            error: `Aborted: ${STALE_STREAK_LIMIT} consecutive symbols returned identical ${field}=${result.actual}. ` +
              (visNow && visNow.hidden ? `TV window went hidden (state=${visNow.state}).` : 'Cause unknown — possibly CDP overload.'),
          });
          break;
        }
      } else {
        stableStreak = 0;
        lastValue = result.actual;
      }
      if (result.matched) {
        results.matched.push({ symbol: sym, [field]: result.actual, study: study_values.name });
      } else {
        results.unmatched.push({ symbol: sym, [field]: result.actual ?? actualRaw });
      }
    } catch (e) {
      results.errors.push({ symbol: sym, error: e.message });
    }
  }

  // Restore original chart
  try {
    if (originalState && originalState.symbol) {
      await evaluate(`
        (function() {
          window.TradingViewApi._activeChartWidgetWV.value().setSymbol(${JSON.stringify(originalState.symbol)}, {});
        })()
      `);
      if (originalState.timeframe) {
        await evaluate(`
          (function() {
            window.TradingViewApi._activeChartWidgetWV.value().setResolution(${JSON.stringify(originalState.timeframe)}, {});
          })()
        `);
      }
    }
  } catch (_) {}

  return {
    success: true,
    list_name: target.name,
    list_id: target.id,
    condition: { study, field, op, value },
    timeframe: timeframe || 'current',
    scanned: symbols.length,
    matched_count: results.matched.length,
    matched: results.matched.sort((a, b) => (a[field] ?? 0) - (b[field] ?? 0)),
    unmatched_count: results.unmatched.length,
    error_count: results.errors.length,
    errors: results.errors.slice(0, 10),
    restored_symbol: originalState?.symbol,
  };
}

export async function deleteList({ name, listId, confirm } = {}) {
  if (!confirm) throw new Error('deleteList: pass confirm=true to delete (destructive)');
  const target = await findListOrThrow({ name, listId });
  await rest.deleteList(target.id);
  return { success: true, deleted_id: target.id, deleted_name: target.name };
}

export async function switchTo({ name, listId } = {}) {
  let id = listId;
  let resolved_name = null;
  if (!id) {
    if (!name) throw new Error('switchTo: name or listId required');
    const match = await rest.findByName(name);
    if (!match) throw new Error(`No watchlist named "${name}" found`);
    id = match.id;
    resolved_name = match.name;
  }
  await rest.setActive(id);
  return { success: true, list_id: id, name: resolved_name, action: 'switched' };
}

export async function createList({ name, symbols } = {}) {
  if (!name || typeof name !== 'string') {
    throw new Error('createList requires a non-empty `name` string');
  }
  const trimmedName = name.trim();
  if (trimmedName.length === 0) throw new Error('Watchlist name cannot be empty');

  const c = await getClient();

  // 1. Ensure watchlist panel is open
  const panelState = await evaluate(`
    (function() {
      var toggle = document.querySelector('[aria-label="Watchlist, details, and news"]')
        || document.querySelector('[aria-label*="Watchlist"]');
      if (!toggle) return { error: 'Watchlist toggle button not found in right sidebar' };
      var widget = document.querySelector('[data-test-id-widget-type="watchlist"]');
      var visible = widget && widget.offsetParent !== null;
      if (!visible) { toggle.click(); return { opened: true }; }
      return { opened: false };
    })()
  `);
  if (panelState?.error) throw new Error(panelState.error);
  if (panelState?.opened) await new Promise(r => setTimeout(r, 500));

  // 2. Click the watchlists-button to open the lists dropdown
  const dropdownOpened = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="watchlists-button"]');
      if (!btn) return { error: 'watchlists-button not found' };
      btn.click();
      return { clicked: true };
    })()
  `);
  if (dropdownOpened?.error) throw new Error(dropdownOpened.error);

  // Poll for the menu to render (up to ~1.5s)
  let menuReady = false;
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 200));
    const probe = await evaluate(`
      (function() {
        var menu = document.querySelector('[class*="menuBox"]');
        return menu && menu.offsetParent !== null && /Create new list/i.test(menu.textContent || '');
      })()
    `);
    if (probe === true) { menuReady = true; break; }
  }
  if (!menuReady) throw new Error('lists menu did not open within 1.5s');

  // 3. Click the "Create new list…" menu item
  const created = await evaluate(`
    (function() {
      var menu = document.querySelector('[class*="menuBox"]');
      if (!menu || !menu.offsetParent) return { error: 'lists menu disappeared' };
      var items = menu.querySelectorAll('*');
      for (var i = 0; i < items.length; i++) {
        if (items[i].children.length !== 0) continue;
        var t = (items[i].textContent || '').trim();
        if (/^Create new list[\\.…]*$/i.test(t) && items[i].offsetParent !== null) {
          var node = items[i];
          while (node && node !== menu) {
            if (node.getAttribute && (node.getAttribute('role') === 'menuitem' || node.getAttribute('data-name'))) break;
            node = node.parentElement;
          }
          (node && node !== menu ? node : items[i]).click();
          return { found: true, text: t };
        }
      }
      return { error: 'Create new list menu item not found' };
    })()
  `);
  if (created?.error) {
    // Close menu before bubbling
    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    throw new Error(created.error);
  }
  await new Promise(r => setTimeout(r, 500));

  // 4. The inline input is auto-focused. Verify focus, type name, press Enter.
  const focusCheck = await evaluate(`
    (function() {
      var ae = document.activeElement;
      if (!ae || (ae.tagName !== 'INPUT' && ae.tagName !== 'TEXTAREA' && ae.getAttribute('contenteditable') !== 'true')) {
        return { error: 'New-list input did not receive focus' };
      }
      // Clear any pre-filled placeholder content
      try { if ('value' in ae) ae.value = ''; } catch(e) {}
      return { ok: true };
    })()
  `);
  if (focusCheck?.error) {
    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    throw new Error(focusCheck.error);
  }

  await c.Input.insertText({ text: trimmedName });
  await new Promise(r => setTimeout(r, 200));
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await new Promise(r => setTimeout(r, 600));

  // 5. Verify the active list header now shows the new name
  const verify = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="watchlists-button"]');
      var title = btn ? btn.querySelector('[class*="titleRow"]') : null;
      return { active_name: title ? title.textContent.trim() : (btn ? btn.textContent.trim() : null) };
    })()
  `);
  const created_ok = verify?.active_name === trimmedName;

  // 6. Optionally add initial symbols
  const addedSymbols = [];
  const failedSymbols = [];
  if (Array.isArray(symbols) && symbols.length > 0) {
    for (const sym of symbols) {
      try {
        await add({ symbol: sym });
        addedSymbols.push(sym);
        await new Promise(r => setTimeout(r, 350));
      } catch (e) {
        failedSymbols.push({ symbol: sym, error: e.message });
      }
    }
  }

  return {
    success: created_ok,
    name: trimmedName,
    active_name: verify?.active_name,
    verified: created_ok,
    added_symbols: addedSymbols,
    failed_symbols: failedSymbols,
  };
}

export async function clear({ listId } = {}) {
  // REST path: single POST to /remove/ with the full symbol list.
  try {
    const id = listId || await rest.activeListId();
    const data = await rest.getList(id);
    const targets = data.symbols;
    if (targets.length === 0) {
      return { success: true, removed_count: 0, list_id: id, message: 'Watchlist already empty', via: 'rest' };
    }
    await rest.removeSymbols(id, targets);
    return { success: true, removed_count: targets.length, list_id: id, removed: targets, via: 'rest' };
  } catch (restErr) {
    if (process.env.TV_MCP_NO_UI_FALLBACK === '1') throw restErr;
    // Legacy UI fallback — N right-clicks. Slow but works without cookies.
    const current = await getViaDOM();
    const targets = (current.symbols || []).map(s => s.symbol).filter(Boolean);
    if (targets.length === 0) return { success: true, removed_count: 0, message: 'Watchlist already empty (UI fallback)', via: 'ui' };
    const removed = [], failed = [];
    for (const sym of targets) {
      try {
        await removeViaUI({ symbol: sym });
        removed.push(sym);
        await new Promise(r => setTimeout(r, 250));
      } catch (e) { failed.push({ symbol: sym, error: e.message }); }
    }
    return { success: failed.length === 0, removed_count: removed.length, removed, failed, via: 'ui' };
  }
}

export async function syncFromRules({ rulesPath } = {}) {
  // Read rules.json, diff with current TV watchlist, apply additions/removals.
  const fs = await import('fs');
  const path = await import('path');
  const url = await import('url');
  const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
  const defaultRules = path.resolve(__dirname, '..', '..', 'rules.json');
  const rp = rulesPath || defaultRules;
  let rules;
  try {
    rules = JSON.parse(fs.readFileSync(rp, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to read rules.json at ${rp}: ${e.message}`);
  }
  const desired = Array.isArray(rules.watchlist) ? rules.watchlist : [];
  if (desired.length === 0) {
    return { success: false, error: 'rules.watchlist is empty or missing' };
  }
  const current = await get();
  const currentBare = (current.symbols || []).map(s => (s.symbol || '').split(':').pop()).filter(Boolean);
  const desiredBare = desired.map(s => String(s).split(':').pop());

  const toAdd = desired.filter((s, i) => !currentBare.includes(desiredBare[i]));
  const toRemove = (current.symbols || [])
    .map(s => s.symbol)
    .filter(s => s && !desiredBare.includes(s.split(':').pop()));

  const added = [];
  const addFailed = [];
  for (const sym of toAdd) {
    try {
      await add({ symbol: sym });
      added.push(sym);
      await new Promise(r => setTimeout(r, 350));
    } catch (e) {
      addFailed.push({ symbol: sym, error: e.message });
    }
  }

  const removed = [];
  const removeFailed = [];
  for (const sym of toRemove) {
    try {
      await remove({ symbol: sym });
      removed.push(sym);
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      removeFailed.push({ symbol: sym, error: e.message });
    }
  }

  return {
    success: addFailed.length === 0 && removeFailed.length === 0,
    rules_path: rp,
    desired_count: desired.length,
    current_before: currentBare.length,
    added,
    removed,
    addFailed,
    removeFailed,
  };
}
