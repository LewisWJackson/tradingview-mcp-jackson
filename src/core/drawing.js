/**
 * Core drawing logic.
 */
import { evaluate, evaluateWrite, withWriteLock, getChartApi } from '../connection.js';

export async function drawShape({ shape, point, point2, overrides: overridesRaw, text }) {
  const overrides = overridesRaw ? (typeof overridesRaw === 'string' ? JSON.parse(overridesRaw) : overridesRaw) : {};
  const apiPath = await getChartApi();
  const overridesStr = JSON.stringify(overrides || {});
  const textStr = text ? JSON.stringify(text) : '""';

  // Multi-step write — before/after snapshot must be in the same
  // critical section so concurrent draws don't corrupt the newId diff.
  return withWriteLock(async (evalInside) => {
    const before = await evalInside(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);

    if (point2) {
      await evalInside(`
        ${apiPath}.createMultipointShape(
          [{ time: ${point.time}, price: ${point.price} }, { time: ${point2.time}, price: ${point2.price} }],
          { shape: '${shape}', overrides: ${overridesStr}, text: ${textStr} }
        )
      `);
    } else {
      await evalInside(`
        ${apiPath}.createShape(
          { time: ${point.time}, price: ${point.price} },
          { shape: '${shape}', overrides: ${overridesStr}, text: ${textStr} }
        )
      `);
    }

    await new Promise(r => setTimeout(r, 200));
    const after = await evalInside(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);
    const newId = (after || []).find(id => !(before || []).includes(id)) || null;
    return { success: true, shape, entity_id: newId };
  });
}

export async function listDrawings() {
  const apiPath = await getChartApi();
  const shapes = await evaluate(`
    (function() {
      var api = ${apiPath};
      var all = api.getAllShapes();
      return all.map(function(s) { return { id: s.id, name: s.name }; });
    })()
  `);
  return { success: true, count: shapes?.length || 0, shapes: shapes || [] };
}

export async function getProperties({ entity_id }) {
  const apiPath = await getChartApi();
  const result = await evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = '${entity_id}';
      var props = { entity_id: eid };
      var shape = api.getShapeById(eid);
      if (!shape) return { error: 'Shape not found: ' + eid };
      var methods = [];
      try { for (var key in shape) { if (typeof shape[key] === 'function') methods.push(key); } props.available_methods = methods; } catch(e) {}
      try { var pts = shape.getPoints(); if (pts) props.points = pts; } catch(e) { props.points_error = e.message; }
      try { var ovr = shape.getProperties(); if (ovr) props.properties = ovr; } catch(e) {
        try { var ovr2 = shape.properties(); if (ovr2) props.properties = ovr2; } catch(e2) { props.properties_error = e2.message; }
      }
      try { props.visible = shape.isVisible(); } catch(e) {}
      try { props.locked = shape.isLocked(); } catch(e) {}
      try { props.selectable = shape.isSelectionEnabled(); } catch(e) {}
      try {
        var all = api.getAllShapes();
        for (var i = 0; i < all.length; i++) { if (all[i].id === eid) { props.name = all[i].name; break; } }
      } catch(e) {}
      return props;
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, ...result };
}

export async function removeOne({ entity_id }) {
  const apiPath = await getChartApi();
  const result = await evaluateWrite(`
    (function() {
      var api = ${apiPath};
      var eid = '${entity_id}';
      var before = api.getAllShapes();
      var found = false;
      for (var i = 0; i < before.length; i++) { if (before[i].id === eid) { found = true; break; } }
      if (!found) return { removed: false, error: 'Shape not found: ' + eid, available: before.map(function(s) { return s.id; }) };
      api.removeEntity(eid);
      var after = api.getAllShapes();
      var stillExists = false;
      for (var j = 0; j < after.length; j++) { if (after[j].id === eid) { stillExists = true; break; } }
      return { removed: !stillExists, entity_id: eid, remaining_shapes: after.length };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, entity_id: result?.entity_id, removed: result?.removed, remaining_shapes: result?.remaining_shapes };
}

export async function clearAll() {
  const apiPath = await getChartApi();
  await evaluateWrite(`${apiPath}.removeAllShapes()`);
  return { success: true, action: 'all_shapes_removed' };
}
