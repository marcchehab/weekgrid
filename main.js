'use strict';

const obsidian = require('obsidian');

const DATA_PATH = '4_system/weekgrid.json';
const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const PALETTE = [
  { name: 'cyan',   bg: 'rgba(34,197,214,.22)',  br: '#22c5d6', fg: '#8bf0ff' },
  { name: 'orange', bg: 'rgba(255,146,43,.22)',  br: '#ff922b', fg: '#ffc189' },
  { name: 'violet', bg: 'rgba(151,117,250,.22)', br: '#9775fa', fg: '#c9b8ff' },
  { name: 'green',  bg: 'rgba(64,192,87,.22)',   br: '#40c057', fg: '#a4e5b4' },
  { name: 'pink',   bg: 'rgba(240,101,149,.22)', br: '#f06595', fg: '#ffb3cd' },
  { name: 'blue',   bg: 'rgba(77,141,255,.22)',  br: '#4d8dff', fg: '#a9c7ff' },
  { name: 'yellow', bg: 'rgba(250,203,46,.22)',  br: '#facb2e', fg: '#ffe28a' },
  { name: 'grey',   bg: 'rgba(150,160,175,.20)', br: '#96a0af', fg: '#cbd3de' },
];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => Math.random().toString(36).slice(2, 10);
const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function parseOpts(src) {
  const o = { id: 'default', start: 7, end: 22, snap: 15, hourHeight: 44, marks: [7, 10, 12, 13, 15, 19, 22], midday: [12, 13] };
  for (const line of (src || '').split('\n')) {
    const m = line.match(/^\s*([a-zA-Z]+)\s*[:=]\s*(.+?)\s*$/);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2];
    if (k === 'id' || k === 'board') o.id = v;
    else if (k === 'start') o.start = parseInt(v, 10);
    else if (k === 'end') o.end = parseInt(v, 10);
    else if (k === 'snap') o.snap = parseInt(v, 10);
    else if (k === 'hourheight' || k === 'height') o.hourHeight = parseInt(v, 10);
    else if (k === 'marks') {
      const list = v.split(/[,\s]+/).map((x) => parseFloat(x)).filter((x) => !isNaN(x)).sort((a, b) => a - b);
      if (list.length > 1) { o.marks = list; o.start = list[0]; o.end = list[list.length - 1]; }
    } else if (k === 'midday') {
      const p = v.split(/[-–]/).map((x) => parseFloat(x));
      o.midday = (p.length === 2 && !isNaN(p[0]) && !isNaN(p[1])) ? p : null;
    }
  }
  o.start = clamp(o.start || 0, 0, 23);
  o.end = clamp(o.end || 22, o.start + 1, 24);
  o.marks = o.marks.filter((h) => h >= o.start && h <= o.end);
  o.snap = clamp(o.snap || 15, 5, 60);
  o.hourHeight = clamp(o.hourHeight || 44, 20, 200);
  return o;
}

// side-by-side lanes for overlapping blocks
function layout(blocks) {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    if (!cluster.length) return;
    const lanes = [];
    for (const b of cluster) {
      let li = lanes.findIndex((end) => end <= b.start);
      if (li === -1) { li = lanes.length; lanes.push(0); }
      lanes[li] = b.end;
      b._lane = li;
    }
    for (const b of cluster) { b._lanes = lanes.length; out.push(b); }
    cluster = []; clusterEnd = -1;
  };
  for (const b of sorted) {
    if (cluster.length && b.start >= clusterEnd) flush();
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, b.end);
  }
  flush();
  return out;
}

class WeekGridPlugin extends obsidian.Plugin {
  async onload() {
    this.data = { boards: {} };
    this.views = new Set();
    this.saveTimer = null;
    this.lastWrite = 0;
    await this.loadStore();

    this.registerMarkdownCodeBlockProcessor('weekgrid', (src, el, ctx) => {
      const view = new GridView(this, el, parseOpts(src));
      this.views.add(view);
      view.render();
      ctx.addChild(new (class extends obsidian.MarkdownRenderChild {
        onunload() { view.destroy(); }
      })(el));
    });

    this.registerEvent(this.app.vault.on('modify', async (f) => {
      if (f.path !== DATA_PATH) return;
      if (Date.now() - this.lastWrite < 1500) return; // our own write
      await this.loadStore();
      this.views.forEach((v) => v.render());
    }));

    this.addCommand({
      id: 'insert-weekgrid',
      name: 'Insert week grid',
      editorCallback: (editor) => {
        editor.replaceSelection('```weekgrid\nid: default\nstart: 7\nend: 22\n```\n');
      },
    });
  }

  onunload() { this.views.forEach((v) => v.destroy()); }

  async loadStore() {
    try {
      const raw = await this.app.vault.adapter.read(DATA_PATH);
      const parsed = JSON.parse(raw);
      this.data = parsed && parsed.boards ? parsed : { boards: {} };
    } catch (e) { this.data = { boards: {} }; }
  }

  board(id) {
    if (!this.data.boards[id]) this.data.boards[id] = { blocks: [] };
    if (!Array.isArray(this.data.boards[id].blocks)) this.data.boards[id].blocks = [];
    return this.data.boards[id];
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      this.lastWrite = Date.now();
      try {
        const clean = (k, v) => (k.startsWith('_') ? undefined : v);
        await this.app.vault.adapter.write(DATA_PATH, JSON.stringify(this.data, clean, 2));
        this.lastWrite = Date.now();
      } catch (e) { new obsidian.Notice('WeekGrid: could not write ' + DATA_PATH); }
    }, 350);
  }

  sync(except) {
    this.views.forEach((v) => { if (v !== except && v.opts.id === except.opts.id) v.render(); });
  }
}

class GridView {
  constructor(plugin, el, opts) {
    this.p = plugin;
    this.el = el;
    this.opts = opts;
    this.color = 0;
    this.selected = null;
    this.dragging = null;
    this.onKey = this.onKey.bind(this);
    document.addEventListener('keydown', this.onKey);
    this.timer = window.setInterval(() => {
      if (document.body.contains(this.el)) this.renderNow();
    }, 60000);
    plugin.registerInterval(this.timer);
  }

  destroy() {
    document.removeEventListener('keydown', this.onKey);
    window.clearInterval(this.timer);
    this.p.views.delete(this);
  }

  renderNow() {
    if (!this.cols) return;
    this.el.querySelectorAll('.wg-now').forEach((n) => n.remove());
    const d = new Date();
    const day = (d.getDay() + 6) % 7;
    const m = d.getHours() * 60 + d.getMinutes();
    if (m < this.minMin || m > this.maxMin) return;
    const ln = this.cols[day].createDiv('wg-now');
    ln.style.top = this.m2y(m) + 'px';
    ln.setAttr('aria-label', fmt(m));
  }

  get blocks() { return this.p.board(this.opts.id).blocks; }
  get minMin() { return this.opts.start * 60; }
  get maxMin() { return this.opts.end * 60; }
  // every band between two marks is the same pixel height, regardless of its duration
  get bandH() { return this.opts.hourHeight * 2; }
  get totalH() { return (this.opts.marks.length - 1) * this.bandH; }
  m2y(m) {
    const mk = this.opts.marks, H = this.bandH;
    m = clamp(m, this.minMin, this.maxMin);
    for (let i = 0; i < mk.length - 1; i++) {
      const a = mk[i] * 60, b = mk[i + 1] * 60;
      if (m <= b) return i * H + ((m - a) / (b - a)) * H;
    }
    return this.totalH;
  }
  y2m(y) {
    const mk = this.opts.marks, H = this.bandH;
    const i = clamp(Math.floor(y / H), 0, mk.length - 2);
    const a = mk[i] * 60, b = mk[i + 1] * 60;
    return a + ((y - i * H) / H) * (b - a);
  }
  snap(m) { return Math.round(m / this.opts.snap) * this.opts.snap; }

  commit() { this.p.save(); this.render(); this.p.sync(this); }

  render() {
    const el = this.el;
    el.empty();
    el.addClass('wg');
    if (!el._wgGuard) { // keep clicks from bubbling into the live-preview editor
      el._wgGuard = true;
      ['mousedown', 'click', 'dblclick', 'pointerdown'].forEach((t) =>
        el.addEventListener(t, (e) => e.stopPropagation()));
    }
    const { hourHeight, start, end } = this.opts;

    // toolbar
    const bar = el.createDiv('wg-bar');
    const sw = bar.createDiv('wg-sw');
    PALETTE.forEach((c, i) => {
      const b = sw.createDiv('wg-swatch');
      b.style.background = c.br;
      b.setAttr('aria-label', c.name);
      if (i === this.color && !this.selected) b.addClass('is-on');
      if (this.selected && this.selected.color === i) b.addClass('is-on');
      b.onclick = () => {
        if (this.selected) { this.selected.color = i; this.color = i; this.commit(); }
        else { this.color = i; this.render(); }
      };
    });

    // header
    const head = el.createDiv('wg-head');
    head.createDiv('wg-gutter-h');
    DAYS.forEach((d) => head.createDiv('wg-dh').setText(d));

    // body
    const body = el.createDiv('wg-body');
    const gut = body.createDiv('wg-gutter');
    gut.style.height = this.totalH + 'px';
    for (const h of this.opts.marks) {
      const t = gut.createDiv('wg-hl');
      t.style.top = this.m2y(h * 60) + 'px';
      t.setText(String(h));
    }

    const mid = this.opts.midday;
    const cols = [];
    for (let d = 0; d < 7; d++) {
      const col = body.createDiv('wg-col');
      col.style.height = this.totalH + 'px';
      if (d > 4) col.addClass('wg-we');
      if (mid) {
        const band = col.createDiv('wg-mid');
        band.style.top = this.m2y(mid[0] * 60) + 'px';
        band.style.height = (this.m2y(mid[1] * 60) - this.m2y(mid[0] * 60)) + 'px';
      }
      for (const h of this.opts.marks) {
        if (h === start) continue;
        const ln = col.createDiv('wg-ln');
        ln.style.top = this.m2y(h * 60) + 'px';
      }
      col.dataset.day = String(d);
      cols.push(col);
      col.addEventListener('pointerdown', (e) => this.onColDown(e, d, col));
    }
    this.cols = cols;

    const byDay = [[], [], [], [], [], [], []];
    for (const b of this.blocks) if (byDay[b.day]) byDay[b.day].push(b);
    byDay.forEach((list, d) => layout(list).forEach((b) => this.drawBlock(b, cols[d])));
    this.renderNow();
  }

  drawBlock(b, col) {
    const c = PALETTE[b.color % PALETTE.length];
    const node = col.createDiv('wg-b');
    const top = this.m2y(b.start);
    const h = Math.max(this.m2y(b.end) - top, 14);
    node.style.top = top + 'px';
    node.style.height = h + 'px';
    const lanes = b._lanes || 1, lane = b._lane || 0;
    node.style.left = `calc(${(lane / lanes) * 100}% + 2px)`;
    node.style.width = `calc(${100 / lanes}% - 4px)`;
    node.style.background = c.bg;
    node.style.borderColor = c.br;
    node.style.color = c.fg;
    if (this.selected && this.selected.id === b.id) node.addClass('is-sel');

    const time = node.createDiv('wg-time');
    time.setText(`${fmt(b.start)}–${fmt(b.end)}`);
    const title = node.createDiv('wg-t');
    title.setText(b.title || '');
    node.createDiv('wg-rs wg-rs-top');
    node.createDiv('wg-rs wg-rs-bot');

    const tools = node.createDiv('wg-tools');
    const dup = tools.createDiv('wg-ic');
    obsidian.setIcon(dup, 'copy');
    dup.setAttr('aria-label', 'duplizieren');
    dup.onclick = (e) => {
      e.stopPropagation();
      const dur = b.end - b.start;
      const start = clamp(b.end, this.minMin, this.maxMin - dur);
      const copy = { ...b, id: uid(), start, end: start + dur };
      delete copy._lane; delete copy._lanes;
      this.blocks.push(copy);
      this.selected = copy;
      this.commit();
    };
    const del = tools.createDiv('wg-ic wg-del');
    obsidian.setIcon(del, 'trash-2');
    del.setAttr('aria-label', 'löschen');
    del.onclick = (e) => {
      e.stopPropagation();
      const i = this.blocks.findIndex((x) => x.id === b.id);
      if (i >= 0) this.blocks.splice(i, 1);
      this.selected = null;
      this.commit();
    };

    node.addEventListener('pointerdown', (e) => this.onBlockDown(e, b, node));
    node.addEventListener('dblclick', (e) => { e.stopPropagation(); this.edit(b, title); });
    if (b._editing) { delete b._editing; setTimeout(() => this.edit(b, title), 0); }
  }

  edit(b, title) {
    title.contentEditable = 'true';
    title.addClass('is-edit');
    title.focus();
    const r = document.createRange();
    r.selectNodeContents(title);
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(r);
    const done = () => {
      title.contentEditable = 'false';
      b.title = title.innerText.trim();
      this.p.save(); this.p.sync(this);
      title.removeClass('is-edit');
    };
    title.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
      if (e.key === 'Escape') { title.innerText = b.title || ''; title.blur(); }
    };
    title.onblur = done;
  }

  onColDown(e, day, col) {
    if (e.button !== 0) return;
    if (e.target.closest('.wg-b')) return;
    e.preventDefault();
    const rect = col.getBoundingClientRect();
    const anchor = clamp(this.snap(this.y2m(e.clientY - rect.top)), this.minMin, this.maxMin);
    const b = { id: uid(), day, start: anchor, end: anchor + this.opts.snap, title: '', color: this.color };
    this.blocks.push(b);
    this.selected = b;
    this.dragging = { mode: 'new', b, anchor, rect };
    this.startDrag(col, e);
    this.render();
  }

  onBlockDown(e, b, node) {
    if (e.button !== 0) return;
    if (e.target.isContentEditable || e.target.closest('.wg-tools')) return;
    e.preventDefault(); e.stopPropagation();
    const col = node.parentElement;
    const rect = col.getBoundingClientRect();
    const mode = e.target.classList.contains('wg-rs-top') ? 'resize-top'
      : e.target.classList.contains('wg-rs-bot') ? 'resize' : 'move';

    // manual double-click detection: pointerdown+preventDefault kills native dblclick
    const now = Date.now();
    if (mode === 'move' && this._lastTap && this._lastTap.id === b.id && now - this._lastTap.t < 450) {
      this._lastTap = null;
      this.selected = b;
      this.edit(b, node.querySelector('.wg-t'));
      return;
    }
    this._lastTap = { id: b.id, t: now };
    this.selected = b;
    this.dragging = { mode, b, rect, grabOff: this.y2m(e.clientY - rect.top) - b.start, dur: b.end - b.start };
    this.startDrag(col, e);
    this.render();
  }

  startDrag(col, e) {
    const move = (ev) => this.onMove(ev);
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      const d = this.dragging;
      this.dragging = null;
      if (!d) return;
      if (d.mode === 'new' && d.b.end - d.b.start <= this.opts.snap) d.b.end = Math.min(d.b.start + 60, this.maxMin);
      if (d.b.end <= d.b.start) d.b.end = d.b.start + this.opts.snap;
      if (d.mode === 'new') d.b._editing = true;
      this.commit();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  onMove(e) {
    const d = this.dragging;
    if (!d) return;
    const rect = d.rect;
    const m = this.snap(this.y2m(e.clientY - rect.top));
    if (d.mode === 'new') {
      d.b.start = clamp(Math.min(d.anchor, m), this.minMin, this.maxMin - this.opts.snap);
      d.b.end = clamp(Math.max(d.anchor + this.opts.snap, m), this.minMin + this.opts.snap, this.maxMin);
    } else if (d.mode === 'resize') {
      d.b.end = clamp(Math.max(m, d.b.start + this.opts.snap), this.minMin + this.opts.snap, this.maxMin);
    } else if (d.mode === 'resize-top') {
      d.b.start = clamp(Math.min(m, d.b.end - this.opts.snap), this.minMin, this.maxMin - this.opts.snap);
    } else {
      const dur = d.dur;
      d.b.start = clamp(m - this.snap(d.grabOff), this.minMin, this.maxMin - dur);
      d.b.end = d.b.start + dur;
      // horizontal: which column is the pointer over
      for (let i = 0; i < this.cols.length; i++) {
        const r = this.cols[i].getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right) { d.b.day = i; break; }
      }
    }
    this.render();
  }

  onKey(e) {
    if (!this.selected || !document.body.contains(this.el)) return;
    if (document.activeElement && document.activeElement.isContentEditable) return;
    const b = this.blocks.find((x) => x.id === this.selected.id);
    if (!b) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.blocks.splice(this.blocks.indexOf(b), 1);
      this.selected = null;
      this.commit();
    } else if (/^[1-8]$/.test(e.key)) {
      b.color = parseInt(e.key, 10) - 1;
      this.color = b.color;
      this.commit();
    } else if (e.key === 'Escape') {
      this.selected = null;
      this.render();
    }
  }
}

module.exports = WeekGridPlugin;
