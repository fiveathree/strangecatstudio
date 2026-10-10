# 奇怪貓工作室 Studio Strange Cat — 網站初稿

紀念琉璃訂製品牌網站的靜態初稿。純 HTML / CSS / JavaScript，沒有建置步驟，直接開 `index.html` 或用 GitHub Pages 就可以瀏覽。

## 頁面

| 檔案 | 內容 |
| --- | --- |
| `index.html` | 首頁：主視覺、七個系列、貓咪款、訂製摘要、工藝、課程、工作室 |
| `series.html` | 作品系列：各系列起價、規格、製作時間、加購項目 |
| `product.html` | 商品訂製頁示範（小貓咪純銀戒指），選項會即時更新價格 |
| `process.html` | 訂製流程六步驟、紀念元素準備方式、色票、製作時間 |
| `visit.html` | 預約表單、台南／高雄工作室資訊、社群連結 |

## 結構

- `css/site.css`：色彩變數與基本樣式。淺色版在 `:root`，黑色版在 `:root[data-theme="dark"]`，改顏色只需要改這裡。
- `js/site.js`：右上角的黑色／淺色切換（選擇會記在瀏覽器的 `localStorage`），以及商品頁的選項與價格。
- `assets/`：Logo 與產品相片。
- 版面樣式目前寫在各頁的 inline `style` 內。

## 首頁開場影片

首頁開場會播放 `assets/hero.mp4`（靜音、自動播放、播一次後停在最後一格）。影片載入失敗，或訪客的裝置設定了「減少動態效果」時，會改為顯示 `assets/galaxy.jpg`。

建議規格：橫向 16:9、1920×1080、8–12 秒、MP4（H.264）、無聲、檔案盡量在 8MB 以內；主體靠畫面右側或中央，左側留暗位給標題文字。

## 尚未完成

- 以 `[方括號]` 標示的內容是待補資料（課程名稱與費用、部分售價、聯絡電話／LINE、戒圍說明）。
- 商品頁與流程頁的色票是示意色，並非型錄 57 色的實際編號。
- 「加入訂製單」與「送出預約」按鈕未接後端；會員、購物車、金流、預約系統尚未實作。

## 在 GitHub Pages 上線

Repo 的 Settings → Pages → Source 選 `Deploy from a branch`，Branch 選 `main`、資料夾選 `/ (root)`。
