/* A bounded, conservative interpreter for the analyzer's static simulation IR. */
(function (root) {
  'use strict';

  function simulate(nodes, id, values, receiver) {
    const limit = 10000, traceLimit = 400, stringLimit = 1024 * 1024;
    let steps = 0, traceTruncated = false;
    const trace = [];
    const unknown = (why) => { throw new Error('Результат неизвестен: ' + why); };
    const tick = () => { if (++steps > limit) unknown('превышен лимит шагов симуляции.'); };
    const record = (id, event, detail) => {
      if (trace.length < traceLimit) trace.push({ id, event, detail }); else traceTruncated = true;
    };
    const describe = (v) => JSON.stringify(typeof v === 'string' && v.length > 180 ? v.slice(0, 180) + '…' : v);
    const checkedInt = (v) => {
      if (!Number.isSafeInteger(v) || v < -2147483648 || v > 2147483647) unknown('целочисленное переполнение или деление на ноль.');
      return v === 0 ? 0 : v;
    };
    const validString = (v) => {
      for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = v.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        } else if (c >= 0xdc00 && c <= 0xdfff) return false;
      }
      return true;
    };
    const validate = (v, type, label) => {
      const ok = type === 'string' ? typeof v === 'string' && v.length <= stringLimit && validString(v) : type === 'bool' ? typeof v === 'boolean' :
        type === 'int' && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
      if (!ok) throw new Error(`Для ${label} требуется ${type}.`);
      return v;
    };
    function copyReceiver(value, spec) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Receiver должен быть JSON-объектом.');
      const fields = spec.fields || [];
      if (Object.keys(value).some((k) => !fields.some((f) => f.name === k)) || fields.some((f) => !Object.hasOwn(value, f.name))) {
        throw new Error('Укажите все поля receiver без дополнительных полей.');
      }
      const copy = Object.create(null);
      for (const f of fields) copy[f.name] = validate(value[f.name], f.type, 'поля ' + f.name);
      return copy;
    }
    function binary(op, a, b) {
      if (typeof a !== typeof b) unknown('несовместимые типы.');
      if (op === '==') return a === b;
      if (op === '!=') return a !== b;
      if (typeof a === 'boolean') {
        if (op === '&&') return a && b;
        if (op === '||') return a || b;
      }
      if (typeof a === 'string' && op === '+') {
        if (a.length + b.length > stringLimit) unknown('превышен размер строки.');
        return a + b;
      }
      if (typeof a === 'number') {
        switch (op) {
          case '+': return checkedInt(a + b);
          case '-': return checkedInt(a - b);
          case '*': return checkedInt(a * b);
          case '/': return checkedInt(Math.trunc(a / b));
          case '%': return checkedInt(a % b);
          case '<': return a < b;
          case '<=': return a <= b;
          case '>': return a > b;
          case '>=': return a >= b;
        }
      }
      unknown('операция вне поддерживаемого подмножества.');
    }
    function invoke(fnID, args, receiverValue, depth, nested) {
      tick();
      if (depth >= 32) unknown('превышена глубина вызовов.');
      const node = nodes.get(fnID), sim = node && node.simulation;
      if (!sim || !sim.supported || !Number.isInteger(sim.resultCount) || (sim.body !== undefined && !Array.isArray(sim.body))) unknown('вызов или сигнатура вне поддерживаемого подмножества.');
      if (args.length !== sim.params.length) unknown('неверное число аргументов.');
      const env = Object.create(null);
      for (let i = 0; i < args.length; i++) {
        const p = sim.params[i];
        env[p.id] = validate(args[i], p.type, p.name);
      }
      let localReceiver;
      if (sim.receiver) {
        // Pointer methods share the caller's modeled object; value methods get a copy.
        const checked = copyReceiver(receiverValue, sim.receiver);
        localReceiver = nested && sim.receiver.pointer ? receiverValue : checked;
        env[sim.receiver.id] = localReceiver;
      } else if (receiverValue !== undefined) unknown('неожиданный receiver.');
      record(fnID, 'call');

      // Go does not specify the relative order of ordinary reads and calls in
      // an expression list. Do not guess if a method could change a read field.
      function guardOrder(exprs) {
        let field = false, method = false;
        function inspect(e) {
          if (!e) return;
          if (e.kind === 'field') field = true;
          if (e.kind === 'call' && e.receiver) method = true;
          if (e.receiver) inspect(e.receiver);
          for (const a of e.args || []) inspect(a);
        }
        for (const e of exprs || []) inspect(e);
        if (field && method) unknown('порядок чтения поля и вызова метода не определён.');
      }
      function hasMethodCall(e) {
        return !!e && ((e.kind === 'call' && !!e.receiver) || hasMethodCall(e.receiver) || (e.args || []).some(hasMethodCall));
      }

      function evalExpr(e, allowVoid = false) {
        tick();
        if (!e || typeof e !== 'object') unknown('неподдерживаемое выражение.');
        if (e.kind === 'literal') {
          if (typeof e.value === 'number') return checkedInt(e.value);
          if (typeof e.value === 'boolean') return e.value;
          if (typeof e.value === 'string' && e.value.length <= stringLimit && validString(e.value)) return e.value;
          unknown('неподдерживаемая константа.');
        }
        if (e.kind === 'param') {
          if (!Object.hasOwn(env, e.name)) unknown('значение переменной недоступно.');
          return env[e.name];
        }
        if (e.kind === 'field') {
          const obj = evalExpr(e.args && e.args[0]);
          if (!obj || typeof obj !== 'object' || !Object.hasOwn(obj, e.name)) unknown('поле receiver недоступно.');
          return obj[e.name];
        }
        if (e.kind === 'unary') {
          const a = evalExpr(e.args[0]);
          if (e.op === '!' && typeof a === 'boolean') return !a;
          if (e.op === '-' && typeof a === 'number') return checkedInt(-a);
          if (e.op === '+' && typeof a === 'number') return checkedInt(a);
          unknown('унарная операция не поддерживается.');
        }
        if (e.kind === 'binary') {
          const a = evalExpr(e.args[0]);
          if (e.op === '&&' && a === false) return false;
          if (e.op === '||' && a === true) return true;
          if ((e.args || []).length > 1) guardOrder(e.args);
          return binary(e.op, a, evalExpr(e.args[1]));
        }
        if (e.kind === 'call') {
          // Go evaluates the receiver before the arguments.
          const r = e.receiver ? evalExpr(e.receiver) : undefined;
          const called = nodes.get(e.name)?.simulation;
          if (e.receiver && called?.receiver && !called.receiver.pointer && (e.args || []).some(hasMethodCall)) {
            unknown('порядок копирования receiver и вызова метода не определён.');
          }
          if ((e.args || []).length > 1) guardOrder(e.args);
          const callArgs = (e.args || []).map((arg) => evalExpr(arg));
          const out = invoke(e.name, callArgs, r, depth + 1, true);
          if (allowVoid && out.values.length === 0) return undefined;
          if (out.values.length === 1) return out.values[0];
          unknown('использование нескольких результатов вызова не поддерживается.');
        }
        unknown('неподдерживаемое выражение.');
      }
      function targetRef(target) {
        if (target && target.kind === 'param') return { obj: env, key: target.name };
        if (target && target.kind === 'field') {
          const obj = evalExpr(target.args && target.args[0]);
          if (!obj || typeof obj !== 'object' || !Object.hasOwn(obj, target.name)) unknown('поле receiver недоступно.');
          return { obj, key: target.name };
        }
        unknown('присваивание не поддерживается.');
      }
      function targetName(target) {
        if (target.kind === 'field') return targetName(target.args[0]) + '.' + target.name;
        return (target.name || '?').replace(/@\d+$/, '');
      }
      function block(stmts) {
        for (const stmt of stmts || []) {
          const flow = statement(stmt);
          if (flow) return flow;
        }
        return null;
      }
      function statement(s) {
        tick();
        if (!s) unknown('неподдерживаемый оператор.');
        switch (s.kind) {
          case 'unknown': unknown('достигнут неподдерживаемый оператор.'); break;
          case 'return': if ((s.args || []).length > 1) guardOrder(s.args); return { kind: 'return', values: (s.args || []).map((x) => evalExpr(x)) };
          case 'break': case 'continue': return { kind: s.kind };
          case 'block': return block(s.body);
          case 'expr': for (const e of s.args || []) evalExpr(e, true); return null;
          case 'assign': {
            const refs = (s.targets || []).map(targetRef);
            if ((s.args || []).length > 1) guardOrder(s.args);
            const vals = (s.args || []).map((e) => evalExpr(e));
            if (refs.length !== vals.length) unknown('присваивание нескольких результатов не поддерживается.');
            if (s.op !== '=' && s.op !== ':=') {
              if (refs.length !== 1 || !Object.hasOwn(refs[0].obj, refs[0].key)) unknown('составное присваивание не поддерживается.');
              vals[0] = binary(s.op, refs[0].obj[refs[0].key], vals[0]);
            }
            for (let i = 0; i < refs.length; i++) refs[i].obj[refs[i].key] = vals[i];
            if (trace.length < traceLimit) record(fnID, 'assign', (s.targets || []).map((t, i) => targetName(t) + ' = ' + describe(vals[i])).join(', '));
            else traceTruncated = true;
            return null;
          }
          case 'if': {
            if (s.init) { const flow = statement(s.init); if (flow) return flow; }
            const condition = evalExpr(s.cond);
            if (typeof condition !== 'boolean') unknown('условие не является bool.');
            record(fnID, 'branch', 'if: ' + (condition ? 'да' : 'нет'));
            return block(condition ? s.body : s.else);
          }
          case 'for': {
            if (s.init) { const flow = statement(s.init); if (flow) return flow; }
            while (true) {
              tick();
              const condition = s.cond ? evalExpr(s.cond) : true;
              if (typeof condition !== 'boolean') unknown('условие цикла не является bool.');
              record(fnID, 'loop', 'for: ' + (condition ? 'следующий шаг' : 'выход'));
              if (!condition) break;
              const flow = block(s.body);
              if (flow && flow.kind === 'return') return flow;
              if (flow && flow.kind === 'break') break;
              if (flow && flow.kind !== 'continue') unknown('неподдерживаемое управление циклом.');
              if (s.post) { const postFlow = statement(s.post); if (postFlow) unknown('неподдерживаемый оператор цикла.'); }
            }
            return null;
          }
          default: unknown('неподдерживаемый оператор.');
        }
      }
      const flow = block(sim.body);
      if (flow && flow.kind !== 'return') unknown('неподдерживаемое управление потоком.');
      const returned = flow ? flow.values : [];
      if (returned.length !== sim.resultCount) unknown('результат функции недоступен.');
      record(fnID, 'return', '[' + returned.map(describe).join(', ') + ']');
      return { values: returned, receiver: localReceiver };
    }
    const out = invoke(id, values, receiver, 0, false);
    return { values: out.values, receiver: out.receiver, trace, traceTruncated };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { simulate };
  else root.BP_SIMULATOR = { simulate };
})(typeof globalThis === 'undefined' ? this : globalThis);
