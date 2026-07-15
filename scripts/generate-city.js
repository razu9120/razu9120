#!/usr/bin/env node
/**
 * generate-city.js
 * -----------------
 * GitHub の contribution グラフを「アイソメトリックな夜の街並み」として描く
 * アニメーション SVG を生成します。
 *   - 1日 = 1棟のビル。コミット数が多いほどビルが高くなる
 *   - 週を分割して複数の「街区(ブロック)」に配置し、間を大通りで区切る
 *   - 街区の間の大通りを車が走る（手前のビルに隠れる／ナイトのみ）
 *
 * 出力: dist/city.svg
 *
 * 実行:
 *   GITHUB_TOKEN=xxxx GH_USER=razu9120 node scripts/generate-city.js
 *   （トークン無しで実行するとモックデータでプレビュー生成）
 *   CAR_PREVIEW=1 を付けると車を大通りの中間に固定して静止プレビュー
 */

const fs = require("fs");
const path = require("path");

const USER = process.env.GH_USER || "razu9120";
const TOKEN = process.env.GITHUB_TOKEN;
const OUT_DIR = process.env.OUT_DIR || path.join(process.cwd(), "dist");
const CAR_PREVIEW = !!process.env.CAR_PREVIEW;

// ---------- レイアウト定数 ----------
const SX = 11;      // アイソメトリックのX半ステップ（タイル幅の半分）
const SY = 5.5;     // アイソメトリックのY半ステップ（タイル奥行の半分）
const MAX_H = 78;   // 一番コミットが多い日のビルの高さ
const MIN_H = 6;    // コミットのある日の最低の高さ
const PAD = 26;     // 余白

// ---------- 街区(ブロック)分割 ----------
const WEEKS_PER_BLOCK = 14; // 1街区あたりの週数
const BLOCKS_PER_ROW = 2;   // 横に並べる街区数（2 → 2xN のグリッド）
const GAP = 3;              // 街区の間（大通り）の広さ（セル）

// ---------- 配色（ナイトのみ） ----------
const THEME = {
  bg: ["#0d1117", "#010409"],
  ground: "#11151c",
  buildingLow: "#233152",
  buildingHigh: "#8b5cf6",
  window: "#ffdd7a",
  windowDim: "#5b6b8c",
  road: "#181d25",
  roadLine: "#39424f",
  cars: ["#ff5c6c", "#ffd93d", "#4dd0e1", "#7bffb0"],
  text: "#7d8590",
};

// ---------- 色ユーティリティ ----------
function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}
function scale(hex, f) {
  return rgbToHex(hexToRgb(hex).map((v) => v * f));
}

// ---------- アイソメトリック変換 ----------
function iso(col, row) {
  return { x: (col - row) * SX, y: (col + row) * SY };
}
const pts = (arr) => arr.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

// ---------- データ取得 ----------
async function fetchContributions(user, token) {
  const query = `query($login:String!){
    user(login:$login){
      contributionsCollection{
        contributionCalendar{
          totalContributions
          weeks{ contributionDays{ contributionCount weekday } }
        }
      }
    }
  }`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { login: user } }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  const cal = json.data.user.contributionsCollection.contributionCalendar;
  return { weeks: cal.weeks, total: cal.totalContributions };
}

// 統計（総数・現在の連続日数・自己ベスト）を算出
function computeStats(weeks, total) {
  const days = weeks.flatMap((w) => w.contributionDays);
  const best = days.reduce((m, d) => Math.max(m, d.contributionCount), 0);
  const sum = days.reduce((s, d) => s + d.contributionCount, 0);
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].contributionCount > 0) streak++;
    else break;
  }
  return { total: total != null ? total : sum, streak, best };
}

// トークンが無いときのモック（見た目確認用・決定論的）
function mockWeeks() {
  const weeks = [];
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let w = 0; w < 53; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const r = rand();
      let c = 0;
      if (r > 0.35) c = Math.floor(rand() * rand() * 40);
      days.push({ contributionCount: c, weekday: d });
    }
    weeks.push({ contributionDays: days });
  }
  return weeks;
}

// ---------- ビル1棟の描画 ----------
function building(col, row, count, max) {
  const t = max > 0 ? count / max : 0;
  const h = count === 0 ? 2 : MIN_H + Math.pow(t, 0.8) * (MAX_H - MIN_H);

  const p0 = iso(col, row);         // 奥
  const p1 = iso(col + 1, row);     // 右
  const p2 = iso(col + 1, row + 1); // 手前
  const p3 = iso(col, row + 1);     // 左
  const up = (p) => ({ x: p.x, y: p.y - h });

  const base = mix(THEME.buildingLow, THEME.buildingHigh, t);
  const topC = scale(base, 1.45);
  const rightC = scale(base, 1.0);
  const leftC = scale(base, 0.68);
  const poly = (arr, c) => `<polygon points="${pts(arr)}" fill="${c}"/>`;

  if (count === 0) {
    // コミット無し = 低い土台スラブ
    return (
      poly([up(p0), up(p1), up(p2), up(p3)], scale(THEME.ground, 1.25)) +
      poly([p3, p2, up(p2), up(p3)], scale(THEME.ground, 0.9)) +
      poly([p1, p2, up(p2), up(p1)], scale(THEME.ground, 1.05))
    );
  }

  let svg = "";
  svg += poly([p3, p2, up(p2), up(p3)], leftC);  // 左面
  svg += poly([p1, p2, up(p2), up(p1)], rightC); // 右面
  svg += poly([up(p0), up(p1), up(p2), up(p3)], topC); // 屋上

  // 窓（高いビルのみ・右面/左面に点灯）
  if (h > 18) {
    const faces = [
      { o: p2, u: { x: p1.x - p2.x, y: p1.y - p2.y } },
      { o: p2, u: { x: p3.x - p2.x, y: p3.y - p2.y } },
    ];
    const floors = Math.max(1, Math.floor(h / 14));
    for (const f of faces) {
      for (let fl = 0; fl < floors; fl++) {
        for (let wx = 0; wx < 2; wx++) {
          const on = ((col * 7 + row + fl * 3 + wx * 11) % 5) < (1 + Math.round(t * 3));
          const wc = on ? THEME.window : THEME.windowDim;
          const cls = on ? ` class="tw${(col * 3 + row * 5 + fl * 2 + wx) % 6}"` : "";
          const sx0 = 0.18 + wx * 0.42, sw = 0.24;
          const ty = 0.14 + fl * (0.72 / floors), th = 0.4 / floors;
          const P = (s, tt) => ({ x: f.o.x + f.u.x * s, y: f.o.y + f.u.y * s - h * tt });
          svg += `<polygon${cls} points="${pts([P(sx0, ty), P(sx0 + sw, ty), P(sx0 + sw, ty + th), P(sx0, ty + th)])}" fill="${wc}"/>`;
        }
      }
    }
  }

  // 屋上の航空障害灯（高層ビルのみ・赤く点滅）
  if (h > 60) {
    const bx = ((p0.x + p1.x + p2.x + p3.x) / 4).toFixed(1);
    const by = ((p0.y + p1.y + p2.y + p3.y) / 4 - h - 1).toFixed(1);
    svg += `<circle cx="${bx}" cy="${by}" r="2.6" fill="#ff5a5a" opacity="0.16"/>`;
    svg += `<circle cx="${bx}" cy="${by}" r="1.3" fill="#ff6b6b" class="beacon"/>`;
  }
  return svg;
}

// ---------- 車 ----------
function carShape(pos, color) {
  // 進行方向は +x,+y（下り右）。前=ヘッドライト（白）、後=テールライト（赤）
  return `<g transform="translate(${pos.x.toFixed(1)},${pos.y.toFixed(1)})">
    <ellipse cx="17" cy="10" rx="13" ry="6" fill="url(#head)" opacity="0.5"/>
    <polygon points="0,0 8,4 0,8 -8,4" fill="${scale(color, 0.7)}"/>
    <polygon points="0,-5 8,-1 8,4 0,0" fill="${color}"/>
    <polygon points="0,-5 -8,-1 -8,4 0,0" fill="${scale(color, 0.82)}"/>
    <polygon points="0,-5 8,-1 0,3 -8,-1" fill="${scale(color, 1.25)}"/>
    <circle cx="6.6" cy="1.4" r="1.1" fill="#fff7d6"/>
    <circle cx="6.6" cy="3.6" r="1.1" fill="#fff7d6"/>
    <circle cx="-6.6" cy="1.6" r="1" fill="#ff3b3b"/>
    <circle cx="-6.6" cy="3.8" r="1" fill="#ff3b3b"/>
  </g>`;
}
function carCss(id, from, to, dur, delay) {
  const dx = (to.x - from.x).toFixed(1), dy = (to.y - from.y).toFixed(1);
  return `.${id}{animation:${id} ${dur}s linear ${delay}s infinite;}
@keyframes ${id}{from{transform:translate(0,0)}to{transform:translate(${dx}px,${dy}px)}}`;
}

// ---------- SVG組み立て ----------
function render(weeks, stats) {
  const rows = 7;

  // 週を街区に分割
  const chunks = [];
  for (let i = 0; i < weeks.length; i += WEEKS_PER_BLOCK) {
    chunks.push(weeks.slice(i, i + WEEKS_PER_BLOCK));
  }
  const nBlocks = chunks.length;
  const nBlockRows = Math.ceil(nBlocks / BLOCKS_PER_ROW);
  const totalCols = BLOCKS_PER_ROW * WEEKS_PER_BLOCK + (BLOCKS_PER_ROW - 1) * GAP;
  const totalRows = nBlockRows * rows + (nBlockRows - 1) * GAP;

  // 建物データ（全街区をまとめて奥→手前でソート）
  let max = 1;
  const grid = [];
  chunks.forEach((chunk, k) => {
    const colOff = (k % BLOCKS_PER_ROW) * (WEEKS_PER_BLOCK + GAP);
    const rowOff = Math.floor(k / BLOCKS_PER_ROW) * (rows + GAP);
    chunk.forEach((wk, localCol) => {
      wk.contributionDays.forEach((d) => {
        max = Math.max(max, d.contributionCount);
        grid.push({ col: colOff + localCol, row: rowOff + d.weekday, count: d.contributionCount });
      });
    });
    // 埋まっていない列は「空き地(平地)」として敷く
    for (let lc = chunk.length; lc < WEEKS_PER_BLOCK; lc++)
      for (let d = 0; d < rows; d++)
        grid.push({ col: colOff + lc, row: rowOff + d, count: 0 });
  });
  grid.sort((a, b) => a.col + a.row - (b.col + b.row) || a.row - b.row);
  let buildings = "";
  for (const g of grid) buildings += building(g.col, g.row, g.count, max);

  // 道路ヘルパ
  const roadPoly = (arr) => `<polygon points="${pts(arr)}" fill="${THEME.road}"/>`;
  const dash = (a, b) =>
    `<polyline points="${a.x.toFixed(1)},${a.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}" stroke="${THEME.roadLine}" stroke-width="0.9" stroke-dasharray="5 6" fill="none"/>`;

  // 街区の間の大通り（内部ストリート）＋ 中心線の座標を収集
  let roads = "";
  const vCols = [], hRows = [];
  for (let bj = 1; bj < BLOCKS_PER_ROW; bj++) {
    const c0 = bj * (WEEKS_PER_BLOCK + GAP) - GAP, c1 = bj * (WEEKS_PER_BLOCK + GAP), cm = (c0 + c1) / 2;
    vCols.push(cm);
    roads += roadPoly([iso(c0, -0.2), iso(c1, -0.2), iso(c1, totalRows + 0.2), iso(c0, totalRows + 0.2)]);
    roads += dash(iso(cm, -0.2), iso(cm, totalRows + 0.2));
  }
  for (let bi = 1; bi < nBlockRows; bi++) {
    const r0 = bi * (rows + GAP) - GAP, r1 = bi * (rows + GAP), rm = (r0 + r1) / 2;
    hRows.push(rm);
    roads += roadPoly([iso(-0.2, r0), iso(totalCols + 0.2, r0), iso(totalCols + 0.2, r1), iso(-0.2, r1)]);
    roads += dash(iso(-0.2, rm), iso(totalCols + 0.2, rm));
  }

  // 最前面の本通り（街の手前・内部ストリートと同じ GAP 幅）
  const fr0 = totalRows + 0.0, fr1 = totalRows + GAP, frM = (fr0 + fr1) / 2;
  const frontRoad =
    roadPoly([iso(-0.5, fr0), iso(totalCols + 0.5, fr0), iso(totalCols + 0.5, fr1), iso(-0.5, fr1)]) +
    dash(iso(-0.5, frM), iso(totalCols + 0.5, frM));

  // 車は手前の本通りだけを走行（全ビルより手前＝現実どおり正しく重なる）
  const routes = [
    { from: iso(-3, frM - 0.55), to: iso(totalCols + 3, frM - 0.55), color: THEME.cars[0], dur: 9, delay: 0 },
    { from: iso(-3, frM + 0.55), to: iso(totalCols + 3, frM + 0.55), color: THEME.cars[2], dur: 10, delay: -5 },
    { from: iso(-3, frM), to: iso(totalCols + 3, frM), color: THEME.cars[1], dur: 8, delay: -3 },
  ];

  const previewFrac = [0.34, 0.62, 0.4, 0.7, 0.3, 0.66];
  const carsSvg = routes
    .map((r, i) => {
      if (CAR_PREVIEW) {
        const f = previewFrac[i % previewFrac.length];
        return carShape({ x: r.from.x + (r.to.x - r.from.x) * f, y: r.from.y + (r.to.y - r.from.y) * f }, r.color);
      }
      return `<g class="car${i}">${carShape(r.from, r.color)}</g>`;
    })
    .join("\n");
  const css = CAR_PREVIEW ? "" : routes.map((r, i) => carCss(`car${i}`, r.from, r.to, r.dur, r.delay)).join("\n");

  // ビュー範囲
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let c = -4; c <= totalCols + 4; c++)
    for (let r = -4; r <= totalRows + 4; r++) {
      const p = iso(c, r);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y - MAX_H); maxY = Math.max(maxY, p.y);
    }
  const W = maxX - minX + PAD * 2;
  const H = maxY - minY + PAD * 2;
  const vb = `${(minX - PAD).toFixed(1)} ${(minY - PAD).toFixed(1)} ${W.toFixed(1)} ${H.toFixed(1)}`;

  // 星空と月（決定論的に配置＝出力が毎回安定する）
  let seed = 987654321;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const skyTop = minY - PAD, skyBand = (maxY - minY) * 0.5;
  let stars = "";
  for (let i = 0; i < 46; i++) {
    const sx = (minX - PAD + rnd() * W).toFixed(1);
    const sy = (skyTop + rnd() * skyBand).toFixed(1);
    const r = (0.4 + rnd() * 0.9).toFixed(1);
    stars += `<circle cx="${sx}" cy="${sy}" r="${r}" fill="#e6ecff" class="st${i % 3}"/>`;
  }
  const mX = (minX - PAD + W * 0.85).toFixed(1), mY = (skyTop + skyBand * 0.3).toFixed(1);
  const moon = `<circle cx="${mX}" cy="${mY}" r="30" fill="url(#moonGlow)"/><circle cx="${mX}" cy="${mY}" r="12" fill="#f4eecb"/>`;

  // 静的アニメーション（窓のまたたき・障害灯の点滅・星のまたたき）
  const staticCss = `
@keyframes tw{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes twd{0%,45%,100%{opacity:1}60%,80%{opacity:.12}}
.tw0{animation:tw 3.2s ease-in-out infinite}
.tw1{animation:tw 4.1s ease-in-out -1.2s infinite}
.tw2{animation:tw 3.6s ease-in-out -2.4s infinite}
.tw3{animation:twd 6.5s ease-in-out -1s infinite}
.tw4{animation:tw 4.8s ease-in-out -3.1s infinite}
.tw5{animation:twd 7.3s ease-in-out -4s infinite}
@keyframes beacon{0%,42%{opacity:1}50%,100%{opacity:.05}}
.beacon{animation:beacon 1.6s steps(1,end) infinite}
@keyframes star{0%,100%{opacity:.85}50%{opacity:.2}}
.st0{animation:star 3s ease-in-out infinite}
.st1{animation:star 4.5s ease-in-out -1.5s infinite}
.st2{animation:star 5.5s ease-in-out -3s infinite}`;

  // 空き地（最後の不完全ブロックの余白）を特定し、小型の自立看板を置く
  let plot = null;
  chunks.forEach((chunk, k) => {
    if (chunk.length < WEEKS_PER_BLOCK) {
      const co = (k % BLOCKS_PER_ROW) * (WEEKS_PER_BLOCK + GAP);
      const ro = Math.floor(k / BLOCKS_PER_ROW) * (rows + GAP);
      plot = { c0: co + chunk.length, c1: co + WEEKS_PER_BLOCK, r0: ro, r1: ro + rows };
    }
  });
  if (!plot) plot = { c0: totalCols - 3, c1: totalCols, r0: totalRows - rows, r1: totalRows };

  const hyp = Math.hypot(SX, SY);
  const CF = plot.c1 - 0.4;                  // 空き地の右端寄り＝手前右へ寄せる
  const rA = plot.r0 + 2, rB = plot.r1;     // 手前(行が大きい側)へ寄せて直近の建物を隠さない
  const midR = (rA + rB) / 2;
  const yBot = 8, yTop = 22;                 // 小型・低め（背後の建物を隠さない）
  const oA = iso(CF, rB);                     // 起点は手前側（rB）。右上へ読ませて反転を防ぐ
  const Lx = (rB - rA) * hyp;                // 画面の横幅（ローカルpx）
  const Ly = yTop - yBot;                    // 画面の高さ
  const mA = SX / hyp, mB = -SY / hyp;       // 右面（行方向）へ寝かせて街に溶け込ませる
  const bbMatrix = `matrix(${mA.toFixed(4)},${mB.toFixed(4)},0,1,${oA.x.toFixed(2)},${(oA.y - yTop).toFixed(2)})`;

  // ティッカー文字列（実データ）
  const S = `${stats.total.toLocaleString("en-US")} CONTRIBUTIONS   ·   ${stats.streak} DAY STREAK   ·   BEST ${stats.best}/DAY   ·   `;
  const fontPx = Ly * 0.6;
  const charW = fontPx * 0.6;
  const oneLen = S.length * charW;
  const reps = Math.ceil((Lx + oneLen) / oneLen) + 1;
  const tickerText = S.repeat(reps);
  const tickDur = Math.max(6, oneLen / 22).toFixed(1);
  const tickerCss = `.ticker{animation:tick ${tickDur}s linear infinite}@keyframes tick{from{transform:translateX(0)}to{transform:translateX(-${oneLen.toFixed(1)}px)}}`;

  // 支柱（中央・地面から画面下端まで）
  const postG = iso(CF, midR);
  const post = `<rect x="${(postG.x - 1).toFixed(1)}" y="${(postG.y - yBot).toFixed(1)}" width="2" height="${yBot.toFixed(1)}" fill="#161c24"/>`;
  const billboard = `${post}
  <g transform="${bbMatrix}">
    <rect x="-3" y="-3" width="${(Lx + 6).toFixed(1)}" height="${(Ly + 6).toFixed(1)}" rx="2" fill="#05070a" stroke="#2b3340" stroke-width="1.2"/>
    <rect x="0" y="0" width="${Lx.toFixed(1)}" height="${Ly.toFixed(1)}" fill="#0a0f14"/>
    <g clip-path="url(#bbClip)">
      <text class="ticker" x="0" y="${(Ly * 0.72).toFixed(1)}" font-family="'Courier New',monospace" font-weight="700" font-size="${fontPx.toFixed(1)}" letter-spacing="0.3" fill="#ffcf4d" filter="url(#ledGlow)">${tickerText}</text>
    </g>
  </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(0)}" height="${H.toFixed(0)}" viewBox="${vb}" font-family="Segoe UI, sans-serif">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${THEME.bg[0]}"/>
      <stop offset="1" stop-color="${THEME.bg[1]}"/>
    </linearGradient>
    <radialGradient id="moonGlow"><stop offset="0" stop-color="#f4eecb" stop-opacity="0.45"/><stop offset="1" stop-color="#f4eecb" stop-opacity="0"/></radialGradient>
    <radialGradient id="head"><stop offset="0" stop-color="#fff2b0" stop-opacity="0.85"/><stop offset="1" stop-color="#fff2b0" stop-opacity="0"/></radialGradient>
    <filter id="ledGlow" x="-20%" y="-60%" width="140%" height="220%">
      <feGaussianBlur stdDeviation="1.1" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <clipPath id="bbClip"><rect x="0" y="0" width="${Lx.toFixed(1)}" height="${Ly.toFixed(1)}"/></clipPath>
    <style>${staticCss}
${tickerCss}
${css}</style>
  </defs>
  <rect x="${(minX - PAD).toFixed(1)}" y="${(minY - PAD).toFixed(1)}" width="${W.toFixed(1)}" height="${H.toFixed(1)}" rx="12" fill="url(#sky)"/>
  ${moon}
  <g>${stars}</g>
  <g>${roads}</g>
  <g>${buildings}</g>
  <g>${frontRoad}</g>
  ${billboard}
  ${carsSvg}
  <text x="${(minX - PAD + 14).toFixed(1)}" y="${(maxY + PAD - 12).toFixed(1)}" fill="${THEME.text}" font-size="11" opacity="0.7">@${USER} · contributions as a city</text>
</svg>`;
}

// ---------- main ----------
(async () => {
  let weeks, total;
  if (TOKEN) {
    console.log(`Fetching contributions for ${USER}...`);
    ({ weeks, total } = await fetchContributions(USER, TOKEN));
  } else {
    console.log("No GITHUB_TOKEN — using mock data for preview.");
    weeks = mockWeeks();
    total = null; // モックでは合計から算出
  }
  const stats = computeStats(weeks, total);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "city.svg"), render(weeks, stats));
  console.log(`Wrote city.svg to ${OUT_DIR} (total=${stats.total}, streak=${stats.streak}, best=${stats.best})`);
})();
