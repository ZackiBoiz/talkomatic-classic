// public/js/puzzle-geometry.js
// Shared jigsaw geometry, ported from Cutfit. One source of truth for the
// Talkomatic server and the puzzle client, so a piece can never be cut two ways.
// Works as a browser <script> (window.PuzzleGeo) and as a CommonJS require on
// the server. Anything computable from the seed is never sent over the wire.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PuzzleGeo = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const PINNED = 0xffff; // gid sentinel: in the frame, not in a group
  const NOBODY = 255; // player sentinel
  const MAXG = 0xfffe;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // mulberry32 - the only randomness in the build. Never Math.random().
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Each seam is hashed independently from (seed, r, c, orientation) so any
  // client can compute any seam without replaying the draw order.
  function hash32(a, b, c, d) {
    let h = 2166136261 >>> 0;
    const v = [a >>> 0, b >>> 0, c >>> 0, d >>> 0];
    for (let i = 0; i < 4; i++) {
      let x = v[i];
      for (let s = 0; s < 4; s++) {
        h ^= (x >>> (s * 8)) & 255;
        h = Math.imul(h, 16777619) >>> 0;
      }
    }
    h ^= h >>> 16;
    h = Math.imul(h, 2246822507) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 3266489909) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  }
  const rand = (seed, a, b, c) => hash32(seed, a, b, c) / 4294967296;
  const sign = (seed, a, b, c) => (rand(seed, a, b, c) < 0.5 ? -1 : 1);

  function gridFor(n, aspect) {
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.max(1, Math.round(n / cols));
      const off = Math.abs(rows * cols - n) / n;
      if (off > 0.12) continue;
      const score = Math.abs(Math.log((aspect / cols) * rows)) + off * 0.6;
      if (!best || score < best.score) best = { rows, cols, score };
    }
    return best || { rows: 1, cols: n };
  }

  // bw/bh are integers, computed once at room creation and shipped in WELCOME.
  function baseDims(target, iw, ih) {
    const g = gridFor(target, iw / ih);
    const n = g.rows * g.cols;
    const span = 320 + Math.sqrt(n) * 62;
    const k = span / Math.max(iw, ih);
    return {
      cols: g.cols,
      rows: g.rows,
      count: n,
      bw: Math.round(iw * k),
      bh: Math.round(ih * k),
    };
  }

  // Every piece gets its own slot around the frame. Nothing is ever stacked.
  function ring(n, pw, ph, bw, bh) {
    const gx = pw + Math.max(5, pw * 0.09),
      gy = ph + Math.max(5, ph * 0.09);
    let m = Math.max(80, Math.min(bw, bh) * 0.3);
    for (let t = 0; t < 60; t++) {
      const W = bw + m * 2,
        H = bh + m * 2,
        bx = m,
        by = m;
      const cols = Math.floor(W / gx),
        rows = Math.floor(H / gy);
      const ox = (W - cols * gx) / 2,
        oy = (H - rows * gy) / 2;
      const slots = [];
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const x = ox + c * gx,
            y = oy + r * gy;
          if (
            x + pw > bx - 14 &&
            x < bx + bw + 14 &&
            y + ph > by - 14 &&
            y < by + bh + 14
          )
            continue;
          slots.push([x, y]);
        }
      if (slots.length >= n) return { W, H, m, slots, gx, gy };
      m *= 1.1;
    }
    return null;
  }

  function layout(seed, cols, rows, bw, bh) {
    const n = cols * rows;
    const cw = bw / cols,
      ch = bh / rows;
    const tab = 0.24 * Math.min(cw, ch);
    const pad = Math.ceil(tab) + 3;
    const pw = Math.ceil(cw) + pad * 2,
      ph = Math.ceil(ch) + pad * 2;
    const snapR = Math.max(9, Math.min(cw, ch) * 0.42);
    const tol = 0.35 * Math.min(cw, ch);
    const R = ring(n, pw, ph, bw, bh);
    const board = { x: R.m, y: R.m, w: bw, h: bh };
    const mat = { x: 0, y: 0, r: R.W, b: R.H };
    return {
      seed,
      cols,
      rows,
      n,
      bw,
      bh,
      cw,
      ch,
      tab,
      pad,
      pw,
      ph,
      snapR,
      tol,
      board,
      mat,
      ring: R,
    };
  }

  const homeX = (i, L) => L.board.x + (i % L.cols) * L.cw - L.pad;
  const homeY = (i, L) => L.board.y + Math.floor(i / L.cols) * L.ch - L.pad;

  function deal(L, dealSeed, idxs) {
    const s = L.ring.slots.slice();
    const rnd = mulberry32(dealSeed >>> 0);
    for (let i = s.length - 1; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const t = s[i];
      s[i] = s[j];
      s[j] = t;
    }
    const jx = (L.ring.gx - L.pw) / 2,
      jy = (L.ring.gy - L.ph) / 2;
    const out = [];
    for (let i = 0; i < idxs.length; i++) {
      const sl = s[i % s.length];
      const x = sl[0] + (rnd() * 2 - 1) * jx;
      const y = sl[1] + (rnd() * 2 - 1) * jy;
      out.push([Math.round(x - homeX(idxs[i], L)), Math.round(y - homeY(idxs[i], L))]);
    }
    return out;
  }

  const SEG = [
    [0.2, 0],
    [0.5, 0.14],
    [0.38, 0.57],
    [0.25, 1],
    [0.75, 1],
    [0.62, 0.57],
    [0.5, 0.14],
    [0.8, 0],
    [1, 0],
  ];

  function seam(ax, ay, bx, by, s, tab) {
    const dx = bx - ax,
      dy = by - ay,
      len = Math.hypot(dx, dy);
    if (!s)
      return [
        [ax, ay],
        [ax + dx / 3, ay + dy / 3],
        [ax + (2 * dx) / 3, ay + (2 * dy) / 3],
        [bx, by],
      ];
    const ux = dx / len,
      uy = dy / len,
      nx = -uy,
      ny = ux,
      o = [[ax, ay]];
    for (let i = 0; i < SEG.length; i++) {
      const t = SEG[i][0],
        v = SEG[i][1];
      o.push([ax + ux * len * t + nx * tab * v * s, ay + uy * len * t + ny * tab * v * s]);
    }
    return o;
  }

  function pathOf(pts, ox, oy) {
    const p = new Path2D();
    p.moveTo(pts[0][0] - ox, pts[0][1] - oy);
    for (let i = 1; i < pts.length; i += 3)
      p.bezierCurveTo(
        pts[i][0] - ox,
        pts[i][1] - oy,
        pts[i + 1][0] - ox,
        pts[i + 1][1] - oy,
        pts[i + 2][0] - ox,
        pts[i + 2][1] - oy,
      );
    p.closePath();
    return p;
  }

  function outline(i, L) {
    const c = i % L.cols,
      r = (i / L.cols) | 0;
    const { cw, ch, tab, seed, cols, rows } = L;
    const top = seam(c * cw, r * ch, (c + 1) * cw, r * ch, r === 0 ? 0 : sign(seed, r, c, 0), tab);
    const right = seam(
      (c + 1) * cw,
      r * ch,
      (c + 1) * cw,
      (r + 1) * ch,
      c + 1 === cols ? 0 : sign(seed, r, c + 1, 1),
      tab,
    );
    const bottom = seam(
      c * cw,
      (r + 1) * ch,
      (c + 1) * cw,
      (r + 1) * ch,
      r + 1 === rows ? 0 : sign(seed, r + 1, c, 0),
      tab,
    );
    const left = seam(c * cw, r * ch, c * cw, (r + 1) * ch, c === 0 ? 0 : sign(seed, r, c, 1), tab);
    return top
      .concat(right.slice(1))
      .concat(bottom.slice().reverse().slice(1))
      .concat(left.slice().reverse().slice(1));
  }

  function neighbours(i, cols, rows, out) {
    const c = i % cols,
      r = (i / cols) | 0;
    out.length = 0;
    if (c > 0) out.push(i - 1);
    if (c < cols - 1) out.push(i + 1);
    if (r > 0) out.push(i - cols);
    if (r < rows - 1) out.push(i + cols);
    return out;
  }

  const OP = {
    // client -> server
    HELLO: 0x10, GRAB: 0x11, MOVE: 0x12, DROP: 0x13, CURSOR: 0x14, TIDY: 0x15,
    PING: 0x16, CHAT: 0x17, PINGCELL: 0x18, RENAME: 0x19, RECUT: 0x1a,
    UNTIDY: 0x1b, UNPIN: 0x1c, VOTEEND: 0x1d,
    // server -> client
    WELCOME: 0x80, SNAPSHOT: 0x81, DELTA: 0x82, GRABBED: 0x83, REJECT: 0x84,
    MERGED: 0x85, PINNED_: 0x86, CURSORS: 0x87, PLAYERS: 0x88, CHATMSG: 0x89,
    CELLPING: 0x8a, RESET: 0x8b, UNPINNED: 0x8c, SOLVED: 0x8d, TIDIED: 0x8e,
    RELEASED: 0x8f, ERROR: 0x90, CHOOSING: 0x91, VOTES: 0x92,
  };

  return {
    PINNED, NOBODY, MAXG, OP, clamp, mulberry32, hash32, rand, sign, gridFor,
    baseDims, ring, layout, homeX, homeY, deal, SEG, seam, pathOf, outline,
    neighbours,
  };
});
