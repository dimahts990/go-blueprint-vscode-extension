/* Go Blueprint — toolbar hints: Russian descriptions with small SVG schematics. */
(function () {
  'use strict';

  const FILL = { struct: '#1d5aa6', interface: '#23824a', type: '#6f45a8', func: '#a8561a', service: '#0e7c86', message: '#9a3a76' };
  const ICON = { struct: 'S', interface: 'I', type: 'T', func: 'ƒ', service: 'G', message: 'P' };
  const C = { calls: '#e9e9e9', ref: '#9aa4ad', implements: '#47d17c', embeds: '#4ea4ff', uses: '#f2b84b', dispatch: '#d07de8', grpc: '#3fd5e6' };
  const HH = 15, RH = 11; // header / row height

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // A mini card. rows: [{ t, c, dim, it }] — returns svg and pin coordinates.
  function card(x, y, w, kind, title, rows = [], o = {}) {
    const h = HH + (rows.length ? rows.length * RH + 6 : 0);
    let s = `<g transform="translate(${x},${y})"${o.dim ? ' opacity=".35"' : ''}>`;
    s += `<rect width="${w}" height="${h}" rx="4" fill="#141416" stroke="${o.ring || '#000'}" stroke-width="${o.ring ? 1.6 : 1}"/>`;
    s += `<path d="M4 0h${w - 8}a4 4 0 0 1 4 4v${HH - 4}h-${w}v-${HH - 4}a4 4 0 0 1 4-4z" fill="${FILL[kind]}"/>`;
    s += `<text x="6" y="10.6" class="ti">${ICON[kind]}</text><text x="16" y="10.6" class="tt">${esc(title)}</text>`;
    rows.forEach((r, i) => {
      const ry = HH + 4 + i * RH + 7;
      s += `<text x="7" y="${ry}" class="tr${r.it ? ' it' : ''}" fill="${r.c || (r.dim ? '#8a8a8a' : '#d6d6d6')}">${esc(r.t)}</text>`;
    });
    s += '</g>';
    const rowY = (i) => y + HH + 4 + i * RH + 4.5;
    return { s, x, y, w, h, hy: y + HH / 2, rowY, l: x, r: x + w };
  }

  function wire(x1, y1, x2, y2, color, dash, o = {}) {
    const dx = Math.max(18, Math.abs(x2 - x1) * 0.45);
    const d = o.loop
      ? `M${x1},${y1} C${x1 + 22},${y1} ${x1 + 22},${y2} ${x2},${y2}`
      : `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    const head = o.loop
      ? `${x2 + 5},${y2 - 3} ${x2},${y2} ${x2 + 5},${y2 + 3}`
      : `${x2 - 5},${y2 - 3} ${x2},${y2} ${x2 - 5},${y2 + 3}`;
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"${dash ? ` stroke-dasharray="${dash}"` : ''} class="${o.anim ? 'anim' : ''}"/>` +
      `<polygon points="${head}" fill="${color}"/>`;
  }

  const label = (x, y, t, c = '#8c8c8c', anchor = 'middle') => `<text x="${x}" y="${y}" class="tl" fill="${c}" text-anchor="${anchor}">${esc(t)}</text>`;
  const svg = (body) => `<svg viewBox="0 0 240 96" width="240" height="96" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;

  const T = {};

  // ---------------------------------------------------------------- wire kinds

  T.calls = {
    title: 'calls — вызовы',
    text: 'Функция или метод вызывает другую функцию/метод. Провод идёт от строки вызывающего (правый пин ▶) к строке вызываемого (левый пин). Чем толще провод — тем больше мест вызова. Двойной клик по проводу открывает место вызова.',
    svg() {
      const a = card(8, 30, 74, 'func', 'Run', [{ t: '(ctx) error' }]);
      const b = card(140, 12, 92, 'struct', 'Store', [{ t: 'Get(id)' }, { t: 'Set(id, v)' }]);
      return svg(a.s + b.s + wire(a.r, a.hy, b.l, b.rowY(0), C.calls, '6 4', { anim: true }) + label(112, 88, 'Run() вызывает Store.Get()'));
    },
  };

  T.ref = {
    title: 'func refs — ссылки на функции',
    text: 'Функция используется как значение, а не вызывается сразу: передаётся колбэком, запускается через go s.run, сохраняется в поле или map. Показывает «кто может вызвать это позже».',
    svg() {
      const a = card(8, 26, 80, 'func', 'main', [{ t: 'go s.run' }]);
      const b = card(146, 26, 86, 'struct', 'Server', [{ t: 'run()' }]);
      return svg(a.s + b.s + wire(a.r, a.rowY(0), b.l, b.rowY(0), C.ref, '2 4') + label(117, 88, 'функция передана как значение'));
    },
  };

  T.implements = {
    title: 'implements — реализует интерфейс',
    text: 'Тип реализует интерфейс: у него есть все методы интерфейса (в Go это происходит неявно, без ключевого слова). Зелёный пунктир идёт от заголовка типа к заголовку интерфейса.',
    svg() {
      const a = card(8, 22, 86, 'struct', 'FileStore', [{ t: 'Read()' }, { t: 'Close()' }]);
      const b = card(146, 26, 86, 'interface', 'Reader', [{ t: 'Read()' }]);
      return svg(a.s + b.s + wire(a.r, a.hy, b.l, b.hy, C.implements, '7 4') + label(120, 88, 'FileStore реализует Reader'));
    },
  };

  T.embeds = {
    title: 'embeds — встраивание',
    text: 'Тип встраивает другой тип без имени поля (struct embedding или встраивание интерфейса) и получает его методы как свои. Синий провод идёт от строки встроенного поля.',
    svg() {
      const a = card(8, 22, 92, 'struct', 'Server', [{ t: 'Logger', c: '#7cbcff' }, { t: 'addr string', dim: true }]);
      const b = card(150, 26, 82, 'struct', 'Logger', [{ t: 'Info(msg)' }]);
      return svg(a.s + b.s + wire(a.r, a.rowY(0), b.l, b.hy, C.embeds) + label(120, 88, 'Server получает Logger.Info()'));
    },
  };

  T.uses = {
    title: 'field types — типы полей',
    text: 'Поле структуры имеет тип другой структуры, интерфейса или именованного типа модуля (в том числе внутри *T, []T, map[K]T, chan T). Жёлтый провод идёт от строки поля к типу — так видно, из чего состоит структура и от чего она зависит.',
    svg() {
      const a = card(8, 22, 98, 'struct', 'Poller', [{ t: 'store  *Store', c: '#e6b45a' }, { t: 'delay  Duration', dim: true }]);
      const b = card(152, 26, 80, 'struct', 'Store', [{ t: 'Get(id)' }]);
      return svg(a.s + b.s + wire(a.r, a.rowY(0), b.l, b.hy, C.uses) + label(120, 88, 'поле Poller.store имеет тип *Store'));
    },
  };

  T.dispatch = {
    title: 'iface → impl — какой код выполнится',
    text: 'От метода интерфейса к методам всех типов, которые его реализуют. Отвечает на вопрос «что реально выполнится при вызове через интерфейс». По умолчанию выключено — проводов бывает много.',
    svg() {
      const a = card(8, 26, 84, 'interface', 'Reader', [{ t: 'Read()' }]);
      const b = card(148, 6, 84, 'struct', 'FileStore', [{ t: 'Read()' }]);
      const c = card(148, 52, 84, 'struct', 'MemStore', [{ t: 'Read()' }]);
      return svg(a.s + b.s + c.s + wire(a.r, a.rowY(0), b.l, b.rowY(0), C.dispatch, '5 4') + wire(a.r, a.rowY(0), c.l, c.rowY(0), C.dispatch, '5 4'));
    },
  };

  T.grpc = {
    title: 'gRPC / proto — слой протокола',
    text: 'Обработчик → RPC (serves) → сообщения запроса (пунктир) и ответа или стрима. Вложенные сообщения связаны от строки поля, точками — функции, которые собирают сообщение (toProto). G — сервис, P — protobuf-сообщение; ⓘ и двойной клик открывают .proto.',
    svg() {
      const a = card(4, 26, 72, 'struct', 'serverAPI', [{ t: 'StreamX()' }]);
      const b = card(86, 26, 72, 'service', 'WinchSvc', [{ t: 'StreamX ⇒' }]);
      const c = card(168, 8, 68, 'message', 'XRequest', [{ t: '1 id int64' }]);
      const d = card(168, 50, 68, 'message', 'XStream', [{ t: '1 speed' }]);
      return svg(a.s + b.s + c.s + d.s + wire(a.r, a.rowY(0), b.l, b.rowY(0), C.grpc) +
        wire(b.r, b.rowY(0), c.l, c.hy, C.grpc, '6 4') + wire(b.r, b.rowY(0), d.l, d.hy, C.grpc));
    },
  };

  // ---------------------------------------------------------------- view toggles

  T['t-fields'] = {
    title: 'fields — поля структур',
    text: 'Показывать поля структур (имя и тип). Если выключить — карточки компактнее, а провода «field types» идут от заголовка карточки, а не от строки поля.',
    svg() {
      const a = card(10, 12, 100, 'struct', 'Poller', [{ t: 'store *Store', c: '#e6b45a' }, { t: 'delay Duration', c: '#e6b45a' }, { t: 'Run(ctx)' }, { t: 'Stop()' }]);
      const b = card(132, 12, 100, 'struct', 'Poller', [{ t: 'Run(ctx)' }, { t: 'Stop()' }]);
      return svg(a.s + b.s + label(60, 90, 'вкл') + label(182, 90, 'выкл'));
    },
  };

  T['t-private'] = {
    title: 'private — неэкспортируемые',
    text: 'Показывать неэкспортируемые (с маленькой буквы) типы, функции, методы и поля. Выключите, чтобы оставить только публичный API пакетов.',
    svg() {
      const a = card(10, 12, 100, 'struct', 'Store', [{ t: 'Get(id)' }, { t: 'set(id, v)', dim: true }, { t: 'mu RWMutex', dim: true }]);
      const b = card(132, 12, 100, 'struct', 'Store', [{ t: 'Get(id)' }]);
      return svg(a.s + b.s + label(60, 90, 'вкл') + label(182, 90, 'выкл'));
    },
  };

  T['t-docs'] = {
    title: 'docs — doc-комментарии',
    text: 'Первая строка doc-комментария под заголовком карточки. Полный комментарий всегда есть в подсказке при наведении и в блоке ⓘ.',
    svg() {
      const a = card(56, 14, 128, 'func', 'Seed', [{ t: 'Seed заполняет БД…', c: '#7d7d7d', it: true }, { t: '(ctx, db) error' }]);
      return svg(a.s);
    },
  };

  T['t-compact'] = {
    title: 'compact — только заголовки',
    text: 'Карточки сворачиваются до заголовков: на экран помещается больше блоков, провода идут от заголовков. Удобно для общего обзора архитектуры.',
    svg() {
      const a = card(10, 12, 100, 'struct', 'Poller', [{ t: 'Run(ctx)' }, { t: 'Stop()' }, { t: 'poll()' }]);
      const b = card(132, 12, 100, 'struct', 'Poller');
      const c = card(132, 34, 100, 'func', 'New');
      const d = card(132, 56, 100, 'interface', 'Source');
      return svg(a.s + b.s + c.s + d.s + label(60, 90, 'обычно') + label(182, 90, 'compact'));
    },
  };

  T['t-group'] = {
    title: 'packages — группировка по пакетам',
    text: 'Карточки собираются в рамки по пакетам, рамку можно таскать за заголовок вместе со всем содержимым. Если выключить — один общий граф без рамок, имя пакета пишется в заголовке карточки.',
    svg() {
      const a = card(30, 34, 78, 'struct', 'Poller');
      const b = card(126, 34, 78, 'struct', 'Store');
      return svg(`<rect x="16" y="8" width="204" height="62" rx="5" fill="rgba(220,80,80,.08)" stroke="rgba(220,80,80,.45)"/>` +
        `<rect x="16" y="8" width="204" height="16" rx="5" fill="rgba(220,80,80,.3)"/>` + label(22, 19.5, 'internal/poller', '#fff', 'start') +
        a.s + b.s + wire(a.r, a.hy, b.l, b.hy, C.calls));
    },
  };

  T['t-lenya'] = {
    title: 'режим Леня — сверху вниз',
    text: 'Граф раскладывается сверху вниз: вызывающий код сверху, вызываемый — ниже, пакеты тоже идут сверху вниз. Провода выходят снизу карточки и входят сверху. Повторное нажатие (или клавиша L) — обратно слева направо.',
    svg() {
      const a = card(78, 4, 84, 'func', 'main');
      const b = card(20, 38, 84, 'struct', 'Poller');
      const c = card(136, 38, 84, 'struct', 'Server');
      const d = card(78, 72, 84, 'struct', 'Store');
      const v = (x1, y1, x2, y2, col) => {
        const dy = Math.max(8, (y2 - y1) * 0.5);
        return `<path d="M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}" fill="none" stroke="${col}" stroke-width="1.6"/>` +
          `<polygon points="${x2 - 3},${y2 - 5} ${x2},${y2} ${x2 + 3},${y2 - 5}" fill="${col}"/>`;
      };
      return svg(a.s + b.s + c.s + d.s + v(105, a.y + a.h, 62, b.y, C.calls) + v(135, a.y + a.h, 178, c.y, C.calls) +
        v(62, b.y + b.h, 105, d.y, C.uses) + v(178, c.y + c.h, 135, d.y, C.calls));
    },
  };

  T['t-sidebar'] = {
    title: 'Боковая панель',
    text: 'Показать или скрыть панель с пакетами и настройками gRPC / proto. Ширину панели можно менять, потянув за её правый край (двойной клик по краю — сбросить), размер шрифта — кнопками A− / A+.',
    svg() {
      return svg(`<rect x="8" y="8" width="62" height="80" rx="3" fill="#1a1a1a" stroke="#333"/>` +
        [0, 1, 2, 3, 4].map((i) => `<rect x="14" y="${18 + i * 13}" width="${30 + (i % 3) * 8}" height="5" rx="2" fill="#555"/>`).join('') +
        `<rect x="70" y="8" width="5" height="80" fill="#f0a030" opacity=".7"/><text x="72.5" y="52" class="tl" fill="#000" text-anchor="middle">⋮</text>` +
        card(96, 22, 64, 'struct', 'Store').s + card(168, 50, 64, 'func', 'New').s);
    },
  };

  // ---------------------------------------------------------------- focus and actions

  T.dir = {
    title: 'Направление фокуса',
    text: 'Режим фокуса (ПКМ → Focus, Enter на выделенном) показывает только соседей выбранного символа. «both» — в обе стороны, «callees» — что он вызывает и использует, «callers» — кто вызывает его.',
    svg() {
      const a = card(8, 6, 60, 'func', 'main', [], { dim: false });
      const b = card(8, 58, 60, 'func', 'serve');
      const f = card(92, 32, 60, 'struct', 'Poller', [], { ring: '#f0a030' });
      const c = card(176, 6, 58, 'struct', 'Store');
      const d = card(176, 58, 58, 'func', 'trace');
      return svg(a.s + b.s + f.s + c.s + d.s + wire(a.r, a.hy, f.l, f.hy, C.calls) + wire(b.r, b.hy, f.l, f.hy, C.calls) +
        wire(f.r, f.hy, c.l, c.hy, C.calls) + wire(f.r, f.hy, d.l, d.hy, C.calls) + label(38, 94, '← callers') + label(205, 94, 'callees →'));
    },
  };

  T.depth = {
    title: 'Глубина фокуса',
    text: 'Сколько шагов по связям от выбранного символа показывать в режиме фокуса. 1 — только прямые соседи; 2–3 — цепочки вызовов; большие значения могут вернуть почти весь граф.',
    svg() {
      const f = card(8, 36, 56, 'func', 'X', [], { ring: '#f0a030' });
      const a = card(92, 36, 56, 'func', 'A');
      const b = card(176, 36, 56, 'func', 'B', [], { dim: true });
      return svg(f.s + a.s + b.s + wire(f.r, f.hy, a.l, a.hy, C.calls) + wire(a.r, a.hy, b.l, b.hy, C.calls, '3 3') +
        label(78, 30, 'depth 1') + label(162, 30, 'depth 2'));
    },
  };

  T.back = { title: 'Назад', text: 'Вернуться к предыдущему фокусу (Backspace).' };
  T.unfocus = { title: 'Выйти из фокуса', text: 'Показать весь граф с учётом фильтра пакетов (Esc).' };
  T.fit = { title: 'Вписать', text: 'Вписать все видимые карточки в окно (клавиша F).' };
  T.relayout = { title: 'Авто-раскладка', text: 'Заново расставить карточки автоматически. Ручные перемещения карточек сбрасываются.' };
  T.refresh = { title: 'Обновить', text: 'Заново проанализировать модуль. Это происходит и само при сохранении .go файла.' };
  T.search = { title: 'Поиск', text: 'Поиск типа, функции или метода по имени (клавиша /). Enter — перейти к символу; если он скрыт — открыть его в режиме фокуса.' };

  window.BP_TIPS = T;
})();
