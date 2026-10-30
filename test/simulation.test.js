const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { simulate } = require('../media/simulation');
const simInput = require('../media/simulation-input');

const root = path.join(__dirname, 'fixtures', 'simulation');
const binary = process.env.GO_BLUEPRINT_ANALYZER;
const output = binary
  ? execFileSync(binary, ['-dir', root], { encoding: 'utf8' })
  : execFileSync('go', ['run', '-mod=vendor', '.', '-dir', root], {
    cwd: path.join(__dirname, '..', 'analyzer'), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  });
const graph = JSON.parse(output);
assert.deepEqual(graph.errors || [], [], 'fixture must load without analyzer errors');
const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
const run = (name, args = [], receiver) => simulate(nodes, 'example.com/simulation.' + name, args, receiver);
const counter = () => ({ Value: 10, Active: true, Label: 'test' });

test('branches use the provided input and ignore unsupported untaken code', () => {
  assert.deepEqual(run('Branch', [false]).values, [4]);
  assert.throws(() => run('Branch', [true]), /неподдерживаем/);
});

test('loops, break and continue update pointer receiver and show the calculated calls', () => {
  const input = counter();
  const result = run('Counter.Work', [6], input);
  assert.deepEqual(result.values, [14]);
  assert.equal(result.receiver.Value, 14);
  assert.equal(input.Value, 10, 'input JSON is not mutated');
  assert.equal(result.trace.filter((e) => e.event === 'call' && e.id.endsWith('.Add')).length, 3);
  assert.ok(result.trace.some((e) => e.event === 'branch' && e.detail === 'if: да'));
  assert.ok(result.trace.some((e) => e.event === 'loop'));
  assert.ok(result.trace.some((e) => e.event === 'assign' && e.detail.includes('c.Value')));
});

test('value receivers are copied, including when they call pointer methods', () => {
  const input = counter();
  const result = run('Counter.WorkOnCopy', [3], input);
  assert.deepEqual(result.values, [13]);
  assert.equal(result.receiver.Value, 13);
  assert.equal(input.Value, 10);
  assert.equal(run('Counter.Copy', [2], input).receiver.Value, 12);
});

test('compound assignments reflect side effects on the left side', () => {
  const result = run('Counter.Compound', [], counter());
  assert.deepEqual(result.values, [6]);
  assert.equal(result.receiver.Value, 6);
});

test('does not guess unspecified ordering of field reads and method calls', () => {
  assert.throws(() => run('Counter.Conflicting', [], counter()), /порядок чтения/);
  assert.throws(() => run('Counter.ConflictingReturns', [], counter()), /порядок чтения/);
  assert.throws(() => run('Counter.ConflictingReceiver', [], counter()), /порядок копирования/);
});

test('simultaneous assignment and shadowed variables follow Go scope', () => {
  assert.deepEqual(run('Swap', [2, 3]).values, [32]);
  assert.deepEqual(run('Shadow', [2]).values, [2]);
});

test('recursive functions run within a bound; unbounded loops stop', () => {
  assert.deepEqual(run('Empty').values, []);
  assert.deepEqual(run('Factorial', [5]).values, [120]);
  assert.throws(() => run('Infinite'), /лимит шагов/);
  assert.throws(() => run('Factorial', [40]), /глубина|переполнение/);
});

test('input validation rejects missing fields and unmodelled integers', () => {
  assert.throws(() => run('Counter.Add', [2], { Value: 1 }), /все поля/);
  assert.throws(() => run('Swap', [2147483648, 1]), /требуется int/);
});

test('file scope limits the list of starting functions and methods', () => {
  const state = { mode: 'file', fileScope: 'example.go', focus: { id: 'example.com/simulation.OtherFile' } };
  const file = simInput.scopeFile(state);
  const visible = simInput.candidates(graph.nodes, file);
  assert.ok(visible.some((n) => n.name === 'Add'));
  assert.ok(!visible.some((n) => n.name === 'OtherFile'));
  assert.equal(simInput.scopeFile({ mode: 'full', focus: { id: 'file:other.go' } }), 'other.go');
  assert.deepEqual(simInput.candidates(graph.nodes, 'other.go').map((n) => n.name), ['OtherFile']);
  assert.ok(simInput.candidates(graph.nodes, null).some((n) => n.name === 'OtherFile'));
  assert.deepEqual(simInput.candidates(graph.nodes, 'empty.go'), []);
});

test('examples reflect nested Go parameter and receiver types without enabling unsupported simulations', () => {
  const complex = nodes.get('example.com/simulation.Complex').simulation;
  assert.equal(complex.supported, false);
  const example = JSON.parse(JSON.stringify(simInput.inputExample(complex.params)));
  assert.deepEqual(example, {
    req: { Name: 'пример', Address: { City: 'пример', Zip: 1 }, Tags: ['пример'], Scores: { 'ключ': 1 } },
    count: 1, enabled: true,
  });
  const receiver = nodes.get('example.com/simulation.NestedReceiver.Complex').simulation;
  assert.equal(receiver.supported, false);
  assert.deepEqual(JSON.parse(JSON.stringify(simInput.inputExample(receiver.receiver.fields))), { Request: example.req });
  assert.deepEqual(JSON.parse(JSON.stringify(simInput.inputExample(nodes.get('example.com/simulation.Counter.Add').simulation.receiver.fields))),
    { Value: 1, Active: true, Label: 'пример' });
  const recursive = nodes.get('example.com/simulation.RecursiveInput').simulation;
  assert.deepEqual(JSON.parse(JSON.stringify(simInput.inputExample(recursive.params))),
    { tree: { Value: 1, Left: null }, values: [1, 1] });
});
