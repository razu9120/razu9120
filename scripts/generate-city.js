#!/usr/bin/env node
/**
 * generate-city.js
 * -----------------
 * GitHub の contribution グラフを「アイソメトリックな立体の街並み」として描く
 * アニメーション SVG を生成します。
 *   - 1日 = 1棟のビル。コミット数が多いほどビルが高くなる
 *   - ビルの間（手前の大通り）を車が走る
 *
 * 出力: dist/city.svg (ライト) / dist/city-dark.svg (ナイト)
 *
 * 実行:
 *   GITHUB_TOKEN=xxxx GH_USER=razu9120 node scripts/generate-city.js
 *   （トークン無しで実行するとモックデータでプレビュー生成）
 */

const fs = require("fs");
const path = require("path");

const USER = process.env.GH_USER || "razu9120";
const TOKEN = process.env.GITHUB_TOKEN;
const OUT_DIR = process.env.OUT_DIR || path.join(process.cwd(), "dist");

// ---------- レイアウト定数 ----------
const SX = 11;      // アイソメtrックのX半ステップ（タイル幅の半分）
const SY = 5.5;     // アイソメトリックのY半ステップ（タイル奥行の半分）
const MAX_H = 78;   // 一番コミットが多い日のビルの高さ
const MIN_H = 6;    // コミットのある日の最低の高さ
const PAD = 26;     // 余白

// ---------- 配色 ----------
const THEMES = {
  dark: {
    bg: ["#0d1117", "#010409"],
    ground: "#11151c",
    groundEdge: "#0a0d12",
    buildingLow: "#233152",
    buildingHigh: "#8b5cf6",
    window: "#ffdd7a",
    windowDim: "#5b6b8c",
    road: "#181d25",
    roadLine: "#39424f",
    cars: ["#ff5c6c", "#ffd93d", "#4dd0e1", "#7bffb0"],
    text: "#7d8590",
  },
  light: {
    bg: ["#eef4ff", "#dfeaff"],
    ground: "#c9d6ec",
    groundEdge: "#b3c3de",
    buildingLow: "#a7bbdd",
    buildingHigh: "#5570b8",
    window: "#fff2c2",
    windowDim: "#8ea3c6",
    road: "#d4ddec",
    roadLine: "#aebbd2",
    cars: ["#e8543f", "#f0a500", "#2196a6", "#3aa76d"],
    text: "#57606a",
  },
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

// ---------- データ取得 ----------
async function fetchContributions(user, token) {
  const query = `query($login:String!){
    user(login:$login){
      contributionsCollection{
        contributionCalendar{
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
  return json.data.user.contributionsCollection.contributionCalendar.weeks;
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
function building(col, row, count, max, theme) {
  const t = max > 0 ? count / max : 0;
  const h = count === 0 ? 2 : MIN_H + Math.pow(t, 0.8) * (MAX_H - MIN_H);

  // フットプリント（菱形）4隅
  const p0 = iso(col, row);         // 奥
  const p1 = iso(col + 1, row);     // 右
  const p2 = iso(col + 1, row + 1); // 手前
  const p3 = iso(col, row + 1);     // 左
  const up = (p) => ({ x: p.x, y: p.y - h });

  const base = mix(theme.buildingLow, theme.buildingHigh, t);
  const topC = scale(base, 1.45);
  const rightC = scale(base, 1.0);
  const leftC = scale(base, 0.68);

  if (count === 0) {
    // コミット無し = 低い土台スラブ
    const poly = (pts, c) => `<polygon points="${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}" fill="${c}"/>`;
    return (
      poly([up(p0), up(p1), up(p2), up(p3)], scale(theme.ground, 1.25)) +
      poly([p3, p2, up(p2), up(p3)], scale(theme.ground, 0.9)) +
      poly([p1, p2, up(p2), up(p1)], scale(theme.ground, 1.05))
    );
  }

  const poly = (pts, c, extra = "") =>
    `<polygon points="${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}" fill="${c}" ${extra}/>`;

  let svg = "";
  // 左面（手前左）
  svg += poly([p3, p2, up(p2), up(p3)], leftC);
  // 右面（手前右）
  svg += poly([p1, p2, up(p2), up(p1)], rightC);
  // 屋上
  svg += poly([up(p0), up(p1), up(p2), up(p3)], topC);

  // 窓（ある程度高いビルのみ・右面と左面に格子状）
  if (h > 18) {
    const win = (a, b, c, d, col2) =>
      `<polygon points="${[a, b, c, d].map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}" fill="${col2}"/>`;
    // 右面の基底ベクトル: 原点 p2, u = (p1-p2)方向, v = 上方向(0,-h)
    const faces = [
      { o: p2, u: { x: p1.x - p2.x, y: p1.y - p2.y }, lit: rightC },
      { o: p2, u: { x: p3.x - p2.x, y: p3.y - p2.y }, lit: leftC },
    ];
    const floors = Math.max(1, Math.floor(h / 14));
    for (const f of faces) {
      for (let fl = 0; fl < floors; fl++) {
        for (let wx = 0; wx < 2; wx++) {
          // 点灯 or 消灯をコミット数から決定論的に
          const on = ((col * 7 + row + fl * 3 + wx * 11) % 5) < (1 + Math.round(t * 3));
          const wc = on ? theme.window : theme.windowDim;
          const sx0 = 0.18 + wx * 0.42, sw = 0.24;
          const ty = 0.14 + fl * (0.72 / floors), th = 0.4 / floors;
          const P = (s, tt) => ({
            x: f.o.x + f.u.x * s,
            y: f.o.y + f.u.y * s - h * tt,
          });
          svg += win(P(sx0, ty), P(sx0 + sw, ty), P(sx0 + sw, ty + th), P(sx0, ty + th), wc);
        }
      }
    }
  }
  return svg;
}

// ---------- 車 ----------
function car(id, from, to, color, dur, delay, theme) {
  const dx = (to.x - from.x).toFixed(1);
  const dy = (to.y - from.y).toFixed(1);
  // 小さなアイソメトリックの車体（原点基準で組み立て）
  const body = `
    <g class="${id}">
      <g transform="translate(${from.x.toFixed(1)},${from.y.toFixed(1)})">
        <polygon points="0,0 8,4 0,8 -8,4" fill="${scale(color, 0.7)}"/>
        <polygon points="0,-5 8,-1 8,4 0,0" fill="${color}"/>
        <polygon points="0,-5 -8,-1 -8,4 0,0" fill="${scale(color, 0.82)}"/>
        <polygon points="0,-5 8,-1 0,3 -8,-1" fill="${scale(color, 1.25)}"/>
        <circle cx="6" cy="1.2" r="1.3" fill="#fff7d6"/>
      </g>
    </g>`;
  const css = `.${id}{animation:${id} ${dur}s linear ${delay}s infinite;}
@keyframes ${id}{from{transform:translate(0,0)}to{transform:translate(${dx}px,${dy}px)}}`;
  return { body, css };
}

// ---------- SVG組み立て ----------
function render(weeks, theme, themeName) {
  const cols = weeks.length;
  const rows = 7;
  let max = 1;
  const grid = [];
  weeks.forEach((wk, c) => {
    wk.contributionDays.forEach((d) => {
      max = Math.max(max, d.contributionCount);
      grid.push({ col: c, row: d.weekday, count: d.contributionCount });
    });
  });

  // 描画順（奥→手前）
  grid.sort((a, b) => a.col + a.row - (b.col + b.row) || a.row - b.row);

  let buildings = "";
  for (const g of grid) buildings += building(g.col, g.row, g.count, max, theme);

  // ---- 手前の2本の大通り（L字）----
  const roadPoly = (pts, fill) =>
    `<polygon points="${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}" fill="${fill}"/>`;
  // 大通りA: row=7 に沿って col 0→cols （手前・右下方向）
  const aOut = 7.05, aIn = 7.85;
  const roadA =
    roadPoly([iso(0, aOut), iso(cols, aOut), iso(cols, aIn), iso(0, aIn)], theme.road) +
    `<polyline points="${iso(0, 7.45).x},${iso(0, 7.45).y} ${iso(cols, 7.45).x},${iso(cols, 7.45).y}" stroke="${theme.roadLine}" stroke-width="0.8" stroke-dasharray="6 6" fill="none"/>`;
  // 大通りB: col=cols に沿って row 0→7 （手前・左下方向）
  const bOut = cols + 0.05, bIn = cols + 0.85;
  const roadB =
    roadPoly([iso(bOut, 0), iso(bOut, rows), iso(bIn, rows), iso(bIn, 0)], theme.road) +
    `<polyline points="${iso(cols + 0.45, 0).x},${iso(cols + 0.45, 0).y} ${iso(cols + 0.45, rows).x},${iso(cols + 0.45, rows).y}" stroke="${theme.roadLine}" stroke-width="0.8" stroke-dasharray="6 6" fill="none"/>`;

  // ---- 車 ----
  const carDefs = [
    car("carA1", iso(-3, 7.45), iso(cols + 3, 7.45), theme.cars[0], 7, 0, theme),
    car("carA2", iso(-3, 7.45), iso(cols + 3, 7.45), theme.cars[2], 7, -3.5, theme),
    car("carB1", iso(cols + 0.45, -3), iso(cols + 0.45, rows + 3), theme.cars[1], 6, -1.5, theme),
    car("carB2", iso(cols + 0.45, -3), iso(cols + 0.45, rows + 3), theme.cars[3], 6, -4.5, theme),
  ];

  // ---- ビュー範囲 ----
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let c = -4; c <= cols + 4; c++)
    for (let r = -4; r <= rows + 4; r++) {
      const p = iso(c, r);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y - MAX_H); maxY = Math.max(maxY, p.y);
    }
  const W = maxX - minX + PAD * 2;
  const H = maxY - minY + PAD * 2;
  const vb = `${(minX - PAD).toFixed(1)} ${(minY - PAD).toFixed(1)} ${W.toFixed(1)} ${H.toFixed(1)}`;

  const css = carDefs.map((c) => c.css).join("\n");
  const carsSvg = carDefs.map((c) => c.body).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(0)}" height="${H.toFixed(0)}" viewBox="${vb}" font-family="Segoe UI, sans-serif">
  <defs>
    <linearGradient id="sky-${themeName}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${theme.bg[0]}"/>
      <stop offset="1" stop-color="${theme.bg[1]}"/>
    </linearGradient>
    <style>${css}</style>
  </defs>
  <rect x="${(minX - PAD).toFixed(1)}" y="${(minY - PAD).toFixed(1)}" width="${W.toFixed(1)}" height="${H.toFixed(1)}" rx="12" fill="url(#sky-${themeName})"/>
  <g>${roadA}${roadB}</g>
  <g>${buildings}</g>
  <g>${roadA}${roadB}</g>
  ${carsSvg}
  <text x="${(minX - PAD + 14).toFixed(1)}" y="${(maxY + PAD - 12).toFixed(1)}" fill="${theme.text}" font-size="11" opacity="0.7">@${USER} · commits as a city</text>
</svg>`;
}

// ---------- main ----------
(async () => {
  let weeks;
  if (TOKEN) {
    console.log(`Fetching contributions for ${USER}...`);
    weeks = await fetchContributions(USER, TOKEN);
  } else {
    console.log("No GITHUB_TOKEN — using mock data for preview.");
    weeks = mockWeeks();
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "city-dark.svg"), render(weeks, THEMES.dark, "dark"));
  fs.writeFileSync(path.join(OUT_DIR, "city.svg"), render(weeks, THEMES.light, "light"));
  console.log(`Wrote city.svg / city-dark.svg to ${OUT_DIR}`);
})();
