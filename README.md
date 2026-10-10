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
| `cart.html` | 購物車、結帳（銀行轉帳＋回報末五碼）、查詢訂單 |
| `admin.html` | 工作室後台（需管理密碼）：預約、訂單、貨品、客人、設定 |
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
- 商品頁與流程頁的色票是示意色，並非型錄透明色系 26 色的實際編號。
- 商品頁（`product.html`）的「加入訂製單」未接後端；線上金流與會員尚未實作。
- 水晶鍊、實驗室鑽石、創作者相片與自述為待補內容。
- 貓咪純銀戒指：2026/03 訂購表單已劃掉戒指款，售價待確認。

## 貨品管理

現貨頁的貨品來自後台（`admin.html` →「貨品」分頁），資料存在同一個 D1 資料庫的 `products`、`images` 兩個表。

- 每件貨品有名稱、主石、類別、供應方式、規格說明、價錢、庫存、狀態、排序、連結、相片。
- 價錢留空會顯示「價錢請洽詢」；勾選「起」會顯示「NT$5,800 起」。
- 庫存留空代表不計數量；填 0 會自動顯示「已售完」。狀態選「隱藏」就不會出現在現貨頁。
- 相片在瀏覽器內縮到最長邊 1000px 再上傳，直接存在 D1（每張約 100–300KB）。
- 現貨頁改動後最多約 1 分鐘生效（有快取）。`shop.html` 內寫死的卡片只在 API 連不上時才會顯示。

## 訂單、物流、客人

- **可以線上買的貨品**：現貨、有固定價錢（沒有勾「起」）、上架中、有庫存、沒有填外部連結。其他（手工訂製、價錢洽詢）仍然帶客人去預約／LINE。
- **購物車**存在客人的瀏覽器（`js/shop.js`）。結帳時價錢一律以資料庫為準，並即時扣庫存；庫存不足會拒絕整張訂單。
- **付款**：目前只有銀行轉帳。客人下單後取得訂單編號，匯款後回報末五碼；之後也可以在 `cart.html` 下方用「訂單編號＋手機」查詢進度或補回報。
- **訂單狀態**：待匯款 → 已回報末五碼 → 已收款 → 已出貨 → 已完成；取消會把庫存加回，取消後不能恢復。
- **取貨方式與運費**寫在 `booking/worker.js` 的 `SHOP.shipping`（目前：7-11 取貨 60、宅配 120、台南／高雄工作室自取免運）。7-11 門市由客人自己填名稱，寄件編號由工作室在後台填，客人查詢訂單時看得到。
- **客人**：以手機號碼為準，下單或預約時自動建立；後台可搜尋、看每位客人的訂單與預約紀錄、寫備註。
- **通知**：新訂單、回報末五碼、狀態變更會送到同一個 `notify.gs`（Email＋LINE，不寫入日曆）。
- **尚未實作**：線上刷卡（綠界／藍新，需商店代號與金鑰）、超商門市地圖選店與自動產生寄件單、會員登入。

## 預約系統

後端是 `booking/` 內的 Cloudflare Worker 加 D1 資料庫；前端是 `js/booking.js`（顧客）與 `admin.html`（工作室）。

- 台南、高雄分開排期；體驗課與到訪鑑賞共用同一個行事曆與名額。
- 營業時段、每節長度、每節名額都在 `booking/worker.js` 最上方的 `CONFIG`。目前為：台南每日 13:30–21:00、高雄週二至週六 13:30–19:30、每節 90 分鐘、每節 4 位、最早可約明天、最遠 60 天。
- 體驗課預約後為「待匯款」，顧客回報匯款帳號末五碼後變「已回報」，工作室在管理頁按「確認」。到訪鑑賞不用付款，直接確認。
- 國定假日等休息日在管理頁新增。
- 一天只在一個城市：某天高雄已有預約，台南當天就不開放，反之亦然（`CONFIG.blockedBy`）。取消後會重新開放。
- 即時通知：Worker 會把新預約、回報末五碼、狀態變更送到 `booking/notify.gs`（Google Apps Script），由它寄 Email、同步 Google 日曆，並可選擇推送 LINE。把 GAS 網頁應用程式網址設為 Worker 的 Secret `NOTIFY_URL` 即啟用；設定項目見 `notify.gs` 開頭。

已部署在 `https://strangecat-booking.fiveathree.workers.dev`，並已填入 `js/config.js`。Cloudflare 已連接這個 GitHub repo（根目錄 `/booking`），之後每次 push 到 `main` 都會自動重新部署 Worker。

管理頁密碼是 Worker 的 Secret `ADMIN_TOKEN`：Cloudflare 後台 → Workers & Pages → strangecat-booking → Settings → Variables and Secrets → Add → Type 選 Secret。

匯款資料填在 `js/config.js` 的 `SSC_BANK_INFO`。換了網域要同步改 `booking/wrangler.toml` 的 `ALLOWED_ORIGINS`。

本機測試：`node --experimental-sqlite booking/test.mjs`（跑檢查）或加 `serve`（在 8787 埠開一個測試用 API）。

## 在 GitHub Pages 上線

Repo 的 Settings → Pages → Source 選 `Deploy from a branch`，Branch 選 `main`、資料夾選 `/ (root)`。
