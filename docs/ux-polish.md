# UX Polish — 討論紀錄

狀態：**討論中**（尚未定案，逐項討論後再展開實作規格）。
來源：2026-07-08 對整個 app 的 UI/UX 成熟度盤點。已排除項目：dark theme（不做）。

---

## 1. 同名檔案自動消歧（filename disambiguation）

### 現況

- Sidebar 檔案列只顯示 basename（`Sidebar.tsx` 的 `.file-name`），完整 path 只在 hover tooltip（`.file-tip-path`）。
- firmware log 常見情境：同一天抓多份 `console.log` / `syslog.txt`，列表上完全無法區分，只能靠手動挑 file icon 或 hover。

### 初步方向

- VS Code 式消歧：偵測到 basename 重複時，在檔名後以淡色附上「足以區分的最短父目錄段」，例如 `console.log — deviceA/0703`。
- 只有重名的檔案才顯示後綴；不重名維持現狀。
- 計算屬純 UI derived state（從 `file.path` 推導），不進 undo/persist。

### 待討論

- 後綴取「最短可區分段」還是固定取「最後一層目錄」？（最短可區分較聰明但實作與視覺穩定性較差——開新檔可能讓既有檔的後綴變長）
- 拖進來的無 path 檔（drag & drop buffer）如何處理？
- 後綴是否也要出現在 LogView 標題列（`lv-title`）？

---

## 2. Filter set 的 dirty indicator

### 現況

- 「未存檔」判斷邏輯已存在：`useMenuDefs.ts` 以 `set.filePath && set.savedSnapshot === exportPayload(set)` 決定 Save Filter 是否 disabled。
- 但 UI 上完全看不到 dirty 狀態——使用者不知道目前 filter set 改了沒、Save Filter 為何時灰時亮。

### 初步方向

- 在 filter set 的分頁/名稱旁顯示 ●（未存檔）——類似編輯器的 dirty dot。
- 可能出現位置：FilterPanel 的 set tab、sidebar 檔案列、（未來的）status bar。

### 待討論

- 從未存過檔（`filePath` 為空）的 set 算 dirty 嗎？還是只有「載入過 filter file 後又修改」才標示？
- 只標 active set，還是每個 set tab 都標？
- 關檔/關 app 時要不要對 dirty set 提示「filters 尚未存檔」？（目前直接關）

---

## 3. Wrap long lines（log view 換行切換）

### 現況

- LogView 無 word wrap，超長行（hex dump、單行 JSON）只能橫向捲動。
- 行高目前固定（`--log-row-h`），virtualizer 依固定行高計算。

### 初步方向

- View menu 加「Wrap long lines」checkbox（比照 Show line numbers），per-app 或 per-file 設定待定。
- 快捷鍵候選：Alt+Z（VS Code 慣例）。

### 待討論

- **實作成本核心：virtualizer 依賴固定行高。** wrap 後行高可變，需要 measure-based virtualization 或「wrap 模式下改用估計高度＋動態量測」。需先評估對 scroll perf 的影響（見 memory：LogView scroll perf 很敏感）。
- wrap 模式下 minimap／match map、行選取、find jump 的行為是否都還正確？
- 折衷方案：先做「hover/點選時展開單行」或「選取行在底部 detail pane 顯示全文」，成本低很多，是否足夠？

---

## 4. 正式的 Settings dialog

### 現況

- Settings 是 sidebar 底部的 Popover（`Sidebar.tsx`），平鋪 7 排：panel 位置、match map 顏色/寬度、log 字重、timeline icon 大小、filter row label、color palette 入口，外加一行死的 `Theme: Light`。
- 無分類、無搜尋、無說明文字、無 reset to defaults；會隨功能成長而爆掉。
- 設定歸屬不一致：zoom、line numbers 在 View menu；字重、map 寬度在 popover。

### 初步方向

- 升級為正式 Settings dialog：左側分類（Appearance / Log view / Filters / Timeline / Advanced…），右側設定項含一行說明文字。
- 現有 popover 可保留為「最常用 3 項」的快速入口，或直接改成開 dialog 的按鈕。
- 移除 `Theme: Light` 死文字（dark theme 已決定不做）。

### 待討論

- 分類怎麼切？哪些 View menu 的項目要搬進來（或雙邊都留）？
- 要不要 per-file vs global 設定的區分（例如 wrap、encoding override 是 per-file）？
- reset to defaults 的範圍（全部 vs 單一分類）？

---

## 5. Log diff — 好機 vs 壞機（先做兩檔並排）

### 現況

- 「這台會過、那台不會」是韌體最典型的比對需求，目前只能兩檔來回切換、肉眼對照。
- 逐行文字 diff 對 log 沒有意義（timestamp、位址、序號都不同），有意義的是**結構性比對**。

### 初步方向（範圍：先做兩檔並排即可）

- 選兩個開啟中的檔案並排顯示，**套同一組 filter set**，各自獨立捲動。
- 附一張 counts 對照表：每個 filter 在兩檔各命中幾次，差異大的列突顯（例如只在壞機出現 hit 的 filter）。
- 序列比對（訊息出現順序的 diff）留到之後，不在第一版範圍。

### 待討論

- 入口放哪？（sidebar 檔案右鍵「Compare with…」？View menu？）
- 「同一組 filter set」的語意：以哪個檔的 set 為準？兩檔的 set 是暫時共用還是複製一份？
- counts 對照表放哪個 panel（新 tab？併入 Compare？）——注意 Compare 一詞已被現有的欄位比較 panel 佔用，命名要避免混淆。
- 與現有 dock/layout 系統的關係：並排是 Workspace 的新 layout mode，還是第二個 LogView panel？

---

## 6. 同檔 split view（雙 pane）

### 現況

- 看 crash 段時要回頭對照 boot 段的設定值，只能來回捲動或靠 bookmark 跳。

### 初步方向

- 同一檔上下（或左右）兩個獨立捲動的 pane，**共用 filters 與高亮**（同一 view，不重算）。
- 與 boot-cycle 偵測（未收錄）天然互補；單獨存在也有價值。

### 待討論

- 分割方向：上下 vs 左右 vs 兩者皆可？
- 第二個 pane 共享哪些狀態：選取？bookmarks（應共享）？find bar（各自一條還是共用 query）？view mode（matches-only 是否 per-pane）？
- 實作面：LogView 目前以 `key={file.id}` 單例掛載，per-file state（findOpen、viewMode）存在 LogFile 上——第二個 pane 的這些狀態放哪？
- 與第 5 項（兩檔並排）共用同一套 split 布局機制的可能性——兩者一起設計可省一次架構功。

---

## 7. 鍵盤導航層（hit-to-hit 巡覽）

### 現況

- 導航以滑鼠為主：點 minimap scrub、點 bookmark、點 find 的上下箭頭。
- 引擎已有每個 filter 的 match bitset（computeView 的 match cache），跳轉的資料基礎已存在。

### 初步方向

- 補一層巡覽快捷鍵：
  - 下一個／上一個 **bookmark**；
  - 下一個／上一個 **某個 filter 的 hit**（在 filter row 上觸發，或「選中」一個 filter 後以 n/N 巡覽）；
  - 下一個／上一個 excluded 區塊（檢查被排除內容用）。
- 跳轉行為比照現有 find jump：置中＋flash。

### 待討論

- 「目前巡覽對象是哪個 filter」的狀態怎麼呈現？（與 solo filter 的關係——是同一個「focused filter」概念嗎？）
- 快捷鍵配置：F3/Shift+F3 已是 find 慣例，filter 巡覽用什麼？（候選：Ctrl+F3、n/N、Alt+↑↓）
- 快捷鍵需進 ShortcutsModal 與（未來的）command palette。

---

## 8. 多檔共用 filter sets（shared / linked sets）

> 第 5 項（兩檔並排 diff）的前提功能：pass 與 failed 的多份 log 要用同一組 filter set 檢視。

### 現況

- Filter sets 完全 per-file（`file.sets`、`file.activeSetId`），跨檔只能靠 packs（**複製**語意）或 Save/Load filter file 手動同步，改一處不會動另一處。

### 初步方向（傾向方案 A）

- **方案 A（傾向採用）**：filter set 升格為 app 層級物件（`doc.filterSets` 池），檔案以 reference 指向；多檔指向同一 set 即共用，編輯天然同步（同一物件）。
  - 預設不變：新開檔拿到私有 set；**共用是顯式動作**（set tab 右鍵「Share with…」、開檔時「套用與 file X 相同的 set」）。
  - 共用中的 set tab 顯示 link icon＋使用檔數（`⛓ 3 files`）；提供「Detach」複製成私有退出共用。
- 方案 B（不採用）：引入 Workspace 新單位、set 屬於 workspace——persist/undo 全翻、多一個新名詞，且最終仍需 per-file override 繞回 A 的複雜度。「Workspace」一詞保留給未來的 session snapshot。
- 方案 C（不採用）：用 file group 當共用單位——分組（整理，可能按 pass/fail 分）與共用（分析，pass/fail 要用同一組看）是正交概念，綁死正好違反主要使用情境。
- **不做瀏覽器式上方 file tabs**：sidebar 已是檔案切換器且對多檔更可擴展；上方 tabs 是重複 UI，且本功能需要的是「set 被哪些檔共用」的可視化（FilterPanel 的事），不是檔案導航。

### 待討論

- **與 packs 的語意區分是最大 UX 地雷**：packs＝複製（模板）、shared set＝引用（活的）。共用狀態的可視性（link icon、編輯共用 set 時輕提示「同時用於另外 N 個檔」）是功能成立的關鍵，不是裝飾。
- 命名：Shared set？Linked set？（要與 pack 明確區隔）
- Undo 語意：在檔 A 編輯共用 set 後 undo，檔 B 視角如何呈現？（同一 doc patch，技術上一致，但使用者感知要驗證）
- 資料遷移：`file.sets[]` → `doc.filterSets{}` + `file.setRefs[]`，舊 workspace state 的 migration。
- 計數徽章（per-filter hit counts）是 per-file 的 view 結果——共用 set 在不同檔上 counts 不同，切檔時 FilterPanel 數字會變，需要確認這不造成困惑（或在並排模式下雙欄顯示 counts，銜接第 5 項）。

---

## 候選方向（尚未討論）

（待後續討論後補入）
