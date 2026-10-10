# 奇怪貓工作室 Studio Strange Cat — 網站初稿

紀念琉璃訂製品牌網站的靜態初稿。純 HTML / CSS / JavaScript，沒有建置步驟，直接開 `index.html` 或用 GitHub Pages 就可以瀏覽。

## 頁面

| 檔案 | 內容 |
| --- | --- |
| `index.html` | 首頁：開場影片、三種主石入口、宇宙玻璃系列、貓與星球、Bespoke、工藝、課程、工作室 |
| `shop.html` | 現貨選購：玻璃鑽石、實驗室鑽石、宇宙玻璃，可按主石、類別、供應方式篩選 |
| `build.html` | 自選配搭：選主石 → 選款式 → 完成細節，右側即時顯示配搭摘要 |
| `series.html` | 宇宙玻璃五個手工系列：各款價格、規格、製作時間、加購項目（依 2026/03 訂購表單） |
| `product.html` | 商品頁示範（小貓咪純銀戒指），選項會即時更新價格 |
| `process.html` | Bespoke 訂製流程、紀念元素準備方式、色票、製作時間 |
| `visit.html` | 預約（自建預約系統；未啟用前顯示台南 Calendly）、台南／高雄工作室資訊、官方 LINE 與社群連結 |
| `admin.html` | 工作室專用的預約管理頁（需管理密碼） |
| `about.html` | 創作者介紹：Ben Yuen |

## 結構

- `css/site.css`：色彩變數與基本樣式。淺色版在 `:root`，黑色版在 `:root[data-theme="dark"]`，網站預設為黑色版，改顏色只需要改這裡。
- `js/site.js`：中文斷行處理（把每個分句包成不拆開的一段，避免手機上落單字）、Calendly 嵌入、現貨篩選、自選配搭，以及右上角的黑色／淺色切換（選擇會記在瀏覽器的 `localStorage`），以及商品頁的選項與價格。
- `assets/`：Logo、產品相片、開場影片（`hero.mp4` 與手機用的 `hero-mobile.mp4`）。
- `assets/fonts/`：Noto Sans TC／Noto Serif TC（Google，SIL OFL 免費授權），只保留網站用到的字。**改過網站文字後要重跑 `python3 tools/build_fonts.py`**，否則新字會以裝置內建字型顯示。
- 版面樣式目前寫在各頁的 inline `style` 內。

## 首頁開場影片

首頁開場會播放 `assets/hero.mp4`（靜音、自動循環播放，佔滿整個螢幕；選單會疊在影片上，捲過影片後變回固定在頂部的實色選單列）。影片載入失敗，或訪客的裝置設定了「減少動態效果」時，會改為顯示 `assets/galaxy.jpg`。

建議規格：橫向 16:9、1920×1080、8–12 秒、MP4（H.264）、無聲、檔案盡量在 8MB 以內；主體靠畫面右側或中央，左側留暗位給標題文字。

## 尚未完成

- 以 `[方括號]` 標示的內容是待補資料（玻璃鑽石與實驗室鑽石的售價、規格與相片、出貨時間、課程名稱與費用、聯絡電話／LINE、戒圍說明）。
- 現貨頁的商品清單寫在 `shop.html` 內，尚未接商品資料庫；價格未齊，所以暫時沒有價格篩選與排序。
- 商品頁與流程頁的色票是示意色，並非型錄透明色系 26 色的實際編號。
- 「加入訂製單」未接後端；會員、購物車、金流尚未實作。
- 自建預約系統的程式已完成，但要部署後端並在 `js/config.js` 填入網址才會啟用（見下方）；未啟用前仍用 Calendly。
- 水晶鍊、實驗室鑽石、創作者相片與自述為待補內容。
- 貓咪純銀戒指：2026/03 訂購表單已劃掉戒指款，售價待確認。

## 預約系統

後端是 `booking/` 內的 Cloudflare Worker 加 D1 資料庫；前端是 `js/booking.js`（顧客）與 `admin.html`（工作室）。

- 台南、高雄分開排期；體驗課與到訪鑑賞共用同一個行事曆與名額。
- 營業時段、每節長度、每節名額都在 `booking/worker.js` 最上方的 `CONFIG`。目前為：台南每日 13:30–21:00、高雄週二至週六 13:30–19:30、每節 90 分鐘、每節 4 位、最早可約明天、最遠 60 天。
- 體驗課預約後為「待匯款」，顧客回報匯款帳號末五碼後變「已回報」，工作室在管理頁按「確認」。到訪鑑賞不用付款，直接確認。
- 國定假日等休息日在管理頁新增。

部署（在 `booking/` 資料夾內執行，需要 Node.js 與 Cloudflare 帳號）：

```
npx wrangler d1 create strangecat-booking        # 把輸出的 database_id 貼到 wrangler.toml
npx wrangler d1 execute strangecat-booking --remote --file=schema.sql
npx wrangler secret put ADMIN_TOKEN              # 設定管理頁密碼
npx wrangler deploy                              # 會顯示 Worker 網址
```

然後把 Worker 網址填入 `js/config.js` 的 `SSC_API`，匯款資料填入 `SSC_BANK_INFO`。換了網域要同步改 `wrangler.toml` 的 `ALLOWED_ORIGINS`。

本機測試：`node --experimental-sqlite booking/test.mjs`（跑檢查）或加 `serve`（在 8787 埠開一個測試用 API）。

## 在 GitHub Pages 上線

Repo 的 Settings → Pages → Source 選 `Deploy from a branch`，Branch 選 `main`、資料夾選 `/ (root)`。
