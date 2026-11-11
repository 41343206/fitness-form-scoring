// 把 templates.mjs 挑出的模板寫成 js/templates.js
import fs from 'node:fs';
const r = JSON.parse(fs.readFileSync(process.argv[2]));
let s = `// 內建 DTW 標準模板：由 Mendeley 公開資料集（DOI 10.17632/kgbb3yn47p.2，CC BY 4.0）
// 側面 good 影片產生，產生方式見 tools/build-templates.md。
// 每一筆是一下動作的角度曲線，重新取樣成 40 點；特徵和 exercises.js 的 dtwFeatures 相同
// （深蹲：[膝角, 軀幹前傾]；伏地挺身：[肘角, 身體直線]），單位是度。
// 挑選方式：只用規則分 ≥ 90 的動作，每位受試者取最典型的 2 下，再取最典型的 8 位。
// 這個檔案是程式產生的，不要手動修改。
export const BUILTIN_TEMPLATES = {\n`;
for (const e of ['squat', 'pushup']) {
  s += `  ${e}: [\n`;
  for (const p of r[e].picks) s += `    // subject_${p.subject}，第 ${p.index} 下，規則分 ${p.ruleScore}\n    ${JSON.stringify(p.seq)},\n`;
  s += '  ],\n';
}
s += '};\n';
fs.writeFileSync(new URL('../js/templates.js', import.meta.url), s);
