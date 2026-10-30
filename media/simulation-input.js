/* Input examples and scope selection for the simulation panel. */
(function (root) {
  'use strict';
  function scopeFile(state) {
    if (state.mode === 'file' && state.fileScope) return state.fileScope;
    const id = state.focus && state.focus.id;
    return id && id.startsWith('file:') ? id.slice(5) : null;
  }
  function candidates(nodes, file) {
    return nodes.filter((n) => (n.kind === 'func' || n.kind === 'method') && (!file || n.file === file))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  function example(shape, type) {
    const kind = shape ? shape.kind : type;
    switch (kind) {
      case 'bool': return true;
      case 'string': return 'пример';
      case 'int': return 1;
      case 'float': return 1.5;
      case 'pointer': return example(shape.elem);
      case 'struct': {
        const obj = Object.create(null);
        for (const field of shape.fields || []) obj[field.name] = example(field.shape, field.type);
        return obj;
      }
      case 'slice': return [example(shape.elem)];
      case 'array': {
        const length = shape.length || 0;
        return length <= 10 ? Array.from({ length }, () => example(shape.elem)) : null;
      }
      case 'map': {
        const obj = Object.create(null);
        if (shape.key?.kind === 'string') obj['ключ'] = example(shape.elem);
        else if (shape.key?.kind === 'int') obj['1'] = example(shape.elem);
        return obj;
      }
      default: return null;
    }
  }
  function inputExample(fields) {
    const obj = Object.create(null);
    for (const field of fields || []) obj[field.name] = example(field.shape, field.type);
    return obj;
  }
  const api = { scopeFile, candidates, example, inputExample };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BP_SIM_INPUT = api;
})(typeof globalThis === 'undefined' ? this : globalThis);
