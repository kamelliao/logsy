# Notebook Panel — Design Document

Log Viewer Desktop App (React 19 + TipTap)

## 1. 目的與定位

在現有的 log viewer desktop app 中新增 **Notebook Panel**，作為撰寫 **issue analysis report** 的 WYSIWYG 編輯區。使用者可從既有的三個 panel（Log Lines / Compare Table / Timeline）將資訊插入 notebook，穿插自己的分析文字，最終匯出成單一、可攜（portable）的報告檔。

### 核心設計原則

- **證據與論述分離**：插入物是「定格的證據快照」，作者文字是「分析論述」，兩者在視覺上需一眼可辨。
- **Self-contained export**：報告主要用途是分享 / 貼 ticket / 歸檔，匯出檔必須單一且不依賴 app 或外部資產。
- **App 內可回溯，匯出後靜態化**：app 內每個插入物可「跳回原 panel」對照；匯出後該互動消失，只留靜態內容與 `data-*` metadata。
- **Per-document state**：notebook 綁定於 document，每個 document 各有獨立一份、且僅一個 notebook；source of truth 在 document store。

---

## 2. 技術架構

### 2.0 State scope：per-document

Notebook **不是全域單例**，而是綁定在 document 上的 **per-document state**：

- 一個 app session 可開啟多個 document（log session）；每個 document 各自擁有**獨立一份** notebook state。
- 每個 document 內**只有一個** notebook（非多 notebook tab）。
- 切換 document → notebook 內容跟著切換；關閉 document → 其 notebook state 卸載（內容已持久化，不遺失）。

**Source of truth 在 document store，非 editor。** 每個 document 持有 `notebookJSON`（`editor.getJSON()` 的結果），存於 per-document store；editor 只是該 JSON 的「編輯視圖」。這呼應「notebook panel 可卸載時內容須序列化存上層 store」——上層 store 即 document store。

```ts
interface DocumentState {
  id: string;
  // ...log session 相關 state...
  notebookJSON: JSONContent | null; // notebook 的 source of truth
}
```

### 2.1 Editor instance 管理

採 **hook-based `useEditor` + React Context** 分發 editor instance（非 `<EditorProvider>` composable）。

理由：三個來源 panel 多半不在 notebook 的 component 子樹內，需要從外部存取 editor 來呼叫 `insertContent(...)`。Composable 的 `<EditorProvider>` 將 editor 藏在內部 context，只能在 provider 子樹內透過 `useCurrentEditor()` 取得，不符跨 panel 注入需求。

**Editor lifecycle 綁 active document。** 採 **`key={documentId}` 強制 remount** 策略：切換 document 時 editor 整個重建，從該 document 的 `notebookJSON` rehydrate。如此 undo history 天然隔離（不跨 document 共用），最安全乾淨。

> 替代方案：維持單一 editor instance，切 document 時 `editor.commands.setContent(doc.notebookJSON)` 換內容——省 remount 成本，但 undo history 會殘留跨 document，需自行清理。issue report 場景下 remount 的隔離性更值得。

```tsx
// NotebookProvider 綁定 active document，由 key 觸發 remount
function NotebookHost() {
  const activeDocId = useActiveDocumentId();
  return <NotebookProvider key={activeDocId} documentId={activeDocId} />;
}

// NotebookContext.tsx
const EditorContext = createContext<Editor | null>(null);

function NotebookProvider({ documentId, children }) {
  const initialJSON = useDocumentStore((s) => s.docs[documentId]?.notebookJSON);
  const setNotebookJSON = useDocumentStore((s) => s.setNotebookJSON);

  const editor = useEditor({
    extensions: [
      /* StarterKit, custom nodes... */
    ],
    content: initialJSON ?? "", // 從該 document rehydrate
    // 純 client desktop app（Tauri/Electron）維持預設 true，避免第一幀空白
    immediatelyRender: true,
    // 編輯時 debounce 寫回 document store（source of truth）
    onUpdate: ({ editor }) => setNotebookJSON(documentId, editor.getJSON()),
  });

  return (
    <EditorContext.Provider value={editor}>{children}</EditorContext.Provider>
  );
}

export const useNotebookEditor = () => useContext(EditorContext);
```

來源 panel 注入範例（panel 屬於同一 document，自然對到該 document 的 editor）：

```tsx
function TimelinePanel() {
  const editor = useNotebookEditor();
  const insertSnapshot = (snap) => {
    editor
      ?.chain()
      .focus()
      .insertContent({
        type: "timelineSnapshot",
        attrs: {
          /* ... */
        },
      })
      .run();
  };
}
```

### 2.2 注意事項

- 跨 panel 注入時 editor 可能尚未 mount（`null`）或失焦：一律 `editor?.` guard，並視情況 `.focus()`。
- `onUpdate` 寫回 store 建議 debounce（例如 300–500ms），避免每次 keystroke 都觸發 store 更新與重渲染。
- 三個來源 panel 與 notebook 同屬一個 document scope，`useNotebookEditor()` 取到的恆為該 document 的 editor，無需額外傳 documentId。
- document 關閉前確保最後一次 `getJSON()` 已 flush 進 store（debounce 尾巴），再卸載 editor。

---

## 3. Custom Node 機制

每種插入物為一個 TipTap **Custom Node**，搭配 **React NodeView**（app 內互動）與 **`renderHTML`**（靜態匯出）。

> **關鍵**：NodeView 與 `renderHTML` 是**兩條獨立渲染路徑**，同一 node 兩者都要實作。
>
> - NodeView（React）：app 內看到的可互動版本（可編輯 caption、跳回原 panel）。
> - `renderHTML`：匯出後純瀏覽器渲染的靜態 HTML，無 React。

通用結構：

```tsx
export const SomeNode = Node.create({
  name: "someNode",
  group: "block",
  atom: true, // 不可分割的單一卡片單位，游標不進入內部
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      /* 還原 widget 所需最少欄位 */
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="some-node"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    /* 吐靜態 HTML */
  },
  addNodeView() {
    return ReactNodeViewRenderer(SomeNodeView);
  },
});
```

序列化原則：**attrs 存得下的才會被持久化**。設計 node 時先問「還原這個 widget 最少需要哪些欄位」，只把這些放進 `addAttributes()`；objectURL、暫時 render state 等不進 attrs。

---

## 4. 共用設計：Source Bar 與 Caption

三種插入物共用一致的視覺語言，形成「證據卡片」風格。

### 4.1 Shared source bar（卡片頂部）

| 元素            | 說明                                                                | 匯出後       |
| --------------- | ------------------------------------------------------------------- | ------------ |
| 來源圖示 + 名稱 | 例如 `📄 kernel.log`、`▦ compare`、`⌁ timeline`                     | 保留         |
| 座標            | log 檔名（行號隨各行內嵌） / table source query / timeline 時間區間 | 保留（文字） |
| 跳回原 panel 鈕 | app 內靠 metadata 定位回原 panel                                    | **消失**     |

### 4.2 共用 attrs（抽成 shared structure）

```ts
interface SourceMeta {
  kind: "log" | "compareTable" | "timelineSnapshot";
  sourceLabel: string; // 顯示用來源名稱，e.g. "kernel.log"
  caption: string; // 作者註解（報告價值所在）
  // 各 node 再擴充自己的定位 metadata（見下）
}
```

- **Caption / note 欄位**：三種插入物都可加一行作者註解（例如「fifo overflow 早於 frame drop 17ms，推測為 ...」）。報告的價值在註解，不在原始資料本身。
- 共用部分以 `data-*` 屬性帶入匯出 HTML，供日後重新 import 時 `parseHTML()` 撈回。

---

## 5. 各 Node 規格

### 5.1 Timeline Snapshot

Timeline 是 canvas，使用者框選其中一段截圖插入。

**UI**：圖像卡片（`<figure>` + `<img>` + 可編輯 `<figcaption>`）。

**截圖**：從原 canvas 切一塊後 `toDataURL`。

```tsx
function captureTimelineRegion(canvas, x, y, w, h) {
  // export 用途 clamp 在合理顯示寬度，避免存 2x retina（面積 4 倍）
  const scale = Math.min(1, MAX_REPORT_WIDTH / w);
  const off = document.createElement("canvas");
  off.width = w * scale;
  off.height = h * scale;
  off
    .getContext("2d")
    .drawImage(canvas, x, y, w, h, 0, 0, off.width, off.height);
  return off.toDataURL("image/webp", 0.85); // WebP 比 PNG 小 50%+，現代瀏覽器皆支援
}
```

> WebGL canvas 需以 `preserveDrawingBuffer: true` 建立 context，否則 `drawImage`/`toDataURL` 取到空白。

**attrs**：

```ts
{
  src: string;          // WebP dataURL（內嵌，見 §6 序列化策略）
  tStart: number;       // 重建 metadata
  tEnd: number;
  lanes: string[];      // 截取的 track
  width: number;
  height: number;
  caption: string;
}
```

`tStart`/`tEnd`/`lanes` 為重建參數：匯出 HTML 對讀者無用但留著無妨（寫進 `data-*`），可支援 app 內「跳回 timeline 看這段」或「重新截高解析版」。

### 5.2 Log Lines —— 引用式 code block（非 pure text）

Log 在 report 中是**證據**，需保留語境而非僅純文字。

**UI**：

```
┌─────────────────────────────────────────────┐
│ 📄 kernel.log                          [跳回] │
├─────────────────────────────────────────────┤
│ 4821  [  12.456] seninf: csi-2 link up       │
│ 4823  [  12.501] seninf: ERROR fifo overflow │  ← 行內 "ERROR fifo overflow" 套色
│ 4827  [  12.502] seninf: frame dropped       │
└─────────────────────────────────────────────┘
```

設計要點：

- **保留原始檔行號**（非重新從 1 數）——「line 4823」是可被驗證的座標。行號隨各行帶入，不需 `startLine`，也不顯示 line range（使用者本就可能跳著選取，range 無意義）。
- **等寬字體 + 保留原始對齊**，不 reflow（timestamp / tag 欄位對齊有意義）。
- **跳行不標示斷裂**：使用者本來就可能跳著選取，毋須 `⋯` / `(N–M omitted)`，照選取結果原樣呈現即可。
- **inline 字段樣式（取代單行 highlight）**：不只能標記整行，還能在行內**選取特定字段**套用樣式 —— bold / italic / underline / 文字色 / 背景色等。這把 log 從「整行高亮」升級為「精準指出哪個 token 是重點」（例如只圈出 `fifo overflow`、把某個 register value 標紅），對 issue report 的精確度很有價值。

**inline 樣式的資料表示**：每行的 `text` 不再是單純字串，而是 span 序列，各 span 帶自己的樣式：

```ts
type Span = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string; // 文字色
  bg?: string; // 背景色
};
```

**attrs**：

```ts
{
  file: string;
  lines: {
    n: number;          // 原始檔行號
    spans: Span[];      // 行內容拆成帶樣式的 span 序列
  }[];
  caption: string;
}
```

**匯出**：`renderHTML` 吐 `<pre>` + 行號，每個 span 依樣式包成 `<strong>`/`<em>`/`<u>`/`<span style="color:…;background:…">`。app 內 NodeView 另含「跳回 log panel 該行」按鈕（靠行號 metadata），並提供選取字段套用樣式的 inline toolbar。

### 5.3 Compare Table —— 真 table（靜態化 + 可摘要）

存成真 `<table>`（匯出後瀏覽器原生渲染、可複製、可被 wiki 吃進）。

設計要點：

- **插入時 column / row picker**：只帶需要的子集進 notebook（compare panel 常有數十列十幾欄，report 通常只需問題列 + 相關數欄），優於插入後再刪。
- **保留 regex parse 的型別語義**：標記 key 欄 / 異常值欄，render 時異常 cell 上色（全黑白表 vs 壞值標紅，可讀性差很多）。
- **大表「摘要 + 展開」**：NodeView 預設顯示前 N 列 + 「展開全部（共 N 列）」。匯出 HTML 用 `<details>` 原生折疊，仍維持單檔 portable。
- **對齊與型別**：數字欄右對齊 + 等寬；文字欄左對齊。

**attrs**：

```ts
{
  columns: { key: string; label: string; type: 'ts'|'num'|'text'; align: 'left'|'right' }[];
  rows: { cells: Record<string, string>; anomaly?: string[] }[];  // anomaly: 標紅的 cell keys
  sourceRegex?: string;   // 重建 / 跳回用 metadata
  caption: string;
}
```

---

## 6. 序列化與匯出策略

### 6.1 決策：單檔內嵌（dataURL）

報告主要用途為 issue analysis report，核心訴求是**可攜**（丟給同事 / 貼 ticket / 半年後仍可開）。因此圖像一律 **base64 dataURL 內嵌**，換取 self-contained 單檔，其價值遠大於檔案體積代價。

### 6.2 雙格式

| 格式    | 來源 API                          | 用途                                                 |
| ------- | --------------------------------- | ---------------------------------------------------- |
| `.json` | `editor.getJSON()`                | 原生可編輯檔（自己回來改）                           |
| `.html` | `editor.getHTML()` + dataURL 內嵌 | 匯出 / 分享 / 歸檔（給別人，雙擊即開、無需 runtime） |

### 6.3 控制檔案大小

- **截圖存 WebP**：`toDataURL('image/webp', 0.85)`，通常比 PNG 小 50%+。
- **1x 解析度**：匯出用途 clamp 在閱讀寬度，勿存 2x retina。
- **純向量片段考慮 SVG**：若 timeline 某段能以 SVG 重畫，內嵌 SVG 比 base64 又小又清晰可縮放（canvas-only 則略過）。

一份含十餘張 snapshot 的報告，通常落在 1–2 MB，可接受。

### 6.4 Export HTML 骨架

```tsx
function exportReportHTML(editor: Editor, title: string): string {
  const body = editor.getHTML(); // 含 custom node 經 renderHTML 吐出的靜態 HTML
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { max-width: 820px; margin: 2rem auto; padding: 0 1rem;
         font-family: -apple-system, "Noto Sans TC", sans-serif; line-height: 1.7; }
  figure { margin: 1.5rem 0; }
  figure img { max-width: 100%; border: 1px solid #ddd; border-radius: 6px; }
  figcaption { font-size: .85rem; color: #666; margin-top: .4rem; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #ccc; padding: 4px 8px; }
  pre { background: #f5f5f5; padding: 1rem; border-radius: 6px; overflow-x: auto;
        font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>`;
}
```

範例 `renderHTML`（timelineSnapshot；重建 metadata 寫進 `data-*` 保留回編輯能力）：

```tsx
renderHTML({ HTMLAttributes }) {
  const { src, caption, tStart, tEnd } = HTMLAttributes;
  return ['figure',
    { 'data-type': 'timeline-snapshot', 'data-t-start': tStart, 'data-t-end': tEnd },
    ['img', { src }],
    ['figcaption', {}, caption || `${tStart}ms – ${tEnd}ms`],
  ];
}
```

---

## 7. 設計決策摘要

| 決策點        | 選擇                                                   | 理由                                          |
| ------------- | ------------------------------------------------------ | --------------------------------------------- |
| State scope   | per-document（綁 document，每 document 一個 notebook） | source of truth 在 document store             |
| Editor 管理   | `useEditor` + Context，`key={documentId}` remount      | 跨 panel 注入 + undo history 跨 document 隔離 |
| 插入物本質    | atom custom node + NodeView/renderHTML 雙路徑          | app 互動 vs 靜態匯出分離                      |
| Log 呈現      | 引用式 code block（行號 + inline 字段樣式）            | log 是證據，需可驗證行號與精準標記            |
| Table 呈現    | 真 table + 子集 picker + 異常上色                      | 可讀、可複製、可摘要                          |
| Timeline 呈現 | WebP dataURL 圖卡 + 重建 metadata                      | 顯示快、離線可用、保留回溯能力                |
| 序列化        | dataURL 單檔內嵌                                       | portable 為第一優先                           |
| 匯出格式      | `.json`（編輯）+ `.html`（分享）                       | 自用可改、他用即開                            |
| 共用結構      | source bar + caption + `data-*` metadata               | 證據卡片一致視覺語言、可回編輯                |

---

## 8. 後續工作（建議順序）

1. 在 document store 中加入 `notebookJSON` 欄位，並建 `NotebookHost`（`key={documentId}`）+ `NotebookProvider` + `useNotebookEditor` Context 骨架，含 `onUpdate` debounce 寫回 store 與切換 document 時的 rehydrate。
2. 實作共用 `SourceMeta` schema 與 source bar component。
3. 依序實作三種 node（NodeView + renderHTML + parseHTML 三件套）：先 log quote（最單純）→ compare table → timeline snapshot。
4. 串接三個來源 panel 的插入流程（含 table column/row picker、timeline 框選截圖、log inline 字段樣式 toolbar）。
5. 實作 `.json` / `.html` 匯出與重新 import（`parseHTML` 還原 `data-*`）。
