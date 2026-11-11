# 用資料集產生內建 DTW 模板

資料：Mendeley「A Multi-View Raw Video Dataset of Seven Fitness Exercises with Good/Bad Form Labels」
（DOI 10.17632/kgbb3yn47p.2，CC BY 4.0）的深蹲、伏地挺身側面影片（good 與 bad）。影片不放進 repo。

```bash
pip install mediapipe opencv-python         # Linux 另外需要 libegl1
# 1. 逐幀取出關節點（和 App 用同一個 pose_landmarker_lite 模型）
python3 tools/extract.py pose_landmarker_lite.task subject_001_squat_good_side.mp4 lm/subject_001_squat_good_side.json
# 2. 用 App 本身的程式計次、算規則分，輸出每一下的角度曲線
node tools/reps.mjs lm reps.json
# 3. 挑模板，並用「留一人驗證」比較 good / bad 的分數（參數：k、每人幾下、幾位受試者、輸出檔）
node tools/templates.mjs reps.json 25 2 8 tpl.json
# 4. 寫成 js/templates.js
node tools/write-templates.mjs tpl.json
```

資料集裡有內容完全相同（md5 相同）的影片，templates.mjs 開頭的 EXCLUDE 會排除：
同一人的 good 和 bad 是同一支（深蹲 023、伏地挺身 019）、不同人的 good 和 bad 是同一支（深蹲 015 good = 026 bad），
以及單純重複（深蹲 005 = 006、伏地挺身 good 010 = 013、伏地挺身 bad 014 = 020）。
