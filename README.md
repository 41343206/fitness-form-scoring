# 健身動作評分（手機網頁）

用手機鏡頭側拍，在瀏覽器內以 MediaPipe Pose Landmarker 偵測關節點，計算關節角度並計次。目前是第一階段原型：鏡頭、骨架、角度、計次。評分（規則＋DTW）在後續階段加入，見 [docs/plan.md](docs/plan.md)。

## 檔案

| 檔案 | 內容 |
|---|---|
| `index.html`、`style.css` | 手機版畫面 |
| `js/main.js` | 鏡頭/影片、MediaPipe 推論、畫骨架、更新畫面 |
| `js/pose-math.js` | 關節點編號、角度計算、選擇側面、平滑 |
| `js/rep-counter.js` | 計次狀態機（含緩衝區，避免抖動重複計次） |
| `js/exercises.js` | 深蹲、伏地挺身的關鍵角度與門檻 |
| `tests/logic.test.mjs` | 角度與計次邏輯的單元測試 |

## 本機執行

```bash
npm test          # 跑單元測試（需要 Node 18 以上）
npm run serve     # 在 http://localhost:8080 開啟
```

鏡頭只能在 HTTPS 或 localhost 下開啟。要用手機測試，請部署到 GitHub Pages（或 Netlify），再用手機打開網址。

沒有鏡頭時，可以按「或用影片測試」選一段側拍的深蹲或伏地挺身影片。

## 目前門檻（之後用實測資料調整）

| 動作 | 關鍵角度 | 「下」 | 「上」 |
|---|---|---|---|
| 深蹲 | 膝角（髖–膝–踝） | ≤ 100° | ≥ 160° |
| 伏地挺身 | 肘角（肩–肘–腕） | ≤ 100° | ≥ 150° |
