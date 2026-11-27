# firstmate 議題看板：實作 spec

在自己的 firstmate fork 裡加一塊本機網頁看板，以「議題」為單位管理進行中的工作。三個優先佇列可拖曳排序；每個議題頁有更新、關聯的 agent、輸入框、待決佇列。first mate 繼續當 PM，聊天只用一行提醒，細節在看板上。

這份 spec 彙整自 2026-11-15 到 16 的規劃（21 張決定票）。它自己就是完整的：實作時不需要回頭讀那些票。

## 怎麼讀

| 檔 | 內容 |
| --- | --- |
| [contracts](contracts.markdown) | 六段共用的格式與規則：檔案、JSON 格式、兩條通道、指令白名單、exit code、時間與上限 |
| [stage-1-files](stage-1-files.markdown) | 第一段：只讀寫檔的指令與彙整腳本 |
| [stage-2-service](stage-2-service.markdown) | 第二段：服務的骨架、socket、議題操作 |
| [stage-3-data](stage-3-data.markdown) | 第三段：輪詢、帳本事件、燈號、待決、摘要 |
| [stage-4-writes](stage-4-writes.markdown) | 第四段：寫入、稽核紀錄、重試 |
| [stage-5-browser](stage-5-browser.markdown) | 第五段：瀏覽器通道與頁面 |
| [drag-under-filter](drag-under-filter.markdown) | 設計紀錄：篩選中拖曳議題怎麼排 |
| [card-sort](card-sort.markdown) | 設計紀錄：側欄的卡片照優先順序或建立時間排列，與這時候拖曳怎麼算 |
| [status-metrics](status-metrics.markdown) | 設計紀錄：aggregator 在回報裡帶的狀態數字（用量面板），看板只顯示 |
| [stage-6-rules](stage-6-rules.markdown) | 第六段：`install-rules` 與規則範本 |
| [rollout](../../fm-board/spec/rollout.markdown) | 上線的前提與步驟（fork 這一側的，放在 `fm-board/spec/`） |
| [verification](verification.markdown) | 哪些事實測過、哪些只讀過原始碼、哪些還沒驗 |
| [handover](handover.markdown) | 交接：怎麼跑測試、每個問題的狀態、還沒驗的事、已知限制 |
| [open-issues](open-issues.markdown) | 各票矛盾或漏接的地方與建議 |

規劃目錄裡有兩樣東西要跟著 spec 一起交給實作：`templates/` 的三個規則範本（第六段原樣搬進 fork），與 `prototype/board-prototype.html`（第五段的版面依據）。

每一段是一個 PR，可以各自驗收。段的檔案都是同一個結構：先驗再做、要做的事、驗收。後一段的驗收包含前面各段的。

## 整體的樣子

```
瀏覽器 ──HTTP（127.0.0.1、token）──┐
                                   ├─ 看板服務（node，主 home，常駐）
myshape.sh ──Unix socket（0600）──┘      │  獨家寫入 data/topics.json 等
   │                                      │
   │ list（只讀檔）                       ├─ 讀：<feed> feed <home> <offset> <sha>
   │                                      └─ 寫：<deliver> deliver（一行動作紀錄）
   │                                         <feed>、<deliver> 是 config/myshape-aggregator.json 寫的程式
   ▼
data/topics.json（只讀）

first mate 這一側：fm-board.sh（feed、deliver、bind、tag、setup、帶 task 的 split、--in-home、install-rules、rules）、fm-dispatch-plan.sh（order）
   ▼
各 home 的 data/<task-id>/topic、config/fleet-ledger、偏好檔
```

- **看板服務**只在主 home，按需啟動、獨立常駐；主 home 每次開 session 時，沒在跑的服務也會被啟動。它是議題資料唯一的寫入者。
- **`bin/myshape.sh`** 是 first mate 與使用者用的看板指令，只 source 自己的 `myshape-lib.sh`。`list` 只讀檔，服務掛了也能用；其餘經 socket 找服務。讀寫 first mate 自己的檔的指令在 first mate 這一側（[adapter](../../fm-board/spec/adapter.markdown)）。
- **另一邊的 aggregator** 用自己的名字接上看板：home 的 `config/myshape-aggregator.json` 寫它的名稱與兩支程式的路徑，看板執行 `<feed> feed …` 印一個 home 的回報、`<deliver> deliver` 收一行動作紀錄、回一行結果（[contracts](contracts.markdown) 第 4、7 節）。在 code root 的 `bin/` 底下、git 追蹤而且和 HEAD 相同的程式不用確認，其他的要在頁面上確認一次；每支程式只拿到固定的幾個環境變數。看板不知道 home 在哪台機器上。
- **first mate 的設定檔**讓兩支程式都是 `bin/fm-board.sh`，由 `fm-board.sh setup`、`bind` 或 session start 寫。
- **first mate 的 `fm-board.sh feed`** 照 home 跑每個 home 都有的唯讀彙整腳本 `bin/fm-topic-board-read.sh`（主 home、同機、經 `fm-on.sh` 到遠端）；`deliver` 跑 `fm-inbox.sh`、`fm-send.sh`、`fm-captain-hold.sh` 與 `fm-board.sh tag`（[adapter](../../fm-board/spec/adapter.markdown) 第 3 節）。
- **遠端 home** 只需要 `fm-topic-board-read.sh`、`fm-board.sh`、帳本旗標與 `jq`。

## 不變的原則

1. 不修改上游任何既有檔案，只新增；例外見 [contracts](contracts.markdown) 第 2 節。
2. 看板執行的外部指令只有 [contracts](contracts.markdown) 第 7 節的那張表。
3. 看板不執行合併、捨棄、清理，不碰 backlog；它只記下答覆並通知 first mate。
4. first mate 不重讀 agent 對話來分類；能用腳本做的不交給模型。
5. 威脅模型：擋瀏覽器裡的其他網站（CSRF、DNS rebinding、WebSocket 劫持）與同機的其他使用者。同一個使用者帳號下的程序不防：它們不靠看板也能直接跑 firstmate 的指令、讀憑證。
6. 看板出問題不能讓整個 fleet 停派：`order` 壞掉時放行，`tag` 不依賴服務。

## 在哪裡、怎麼實作

- 由一般的 Claude Code session 實作，不經 firstmate 派工，不設 `config/firstmate-role`。
- 在另一個 clone 裡做：只有一個 remote，`origin` 指向 fork（`https://github.com/guybeju/firstmate.git`）。不在運作中的主 home 裡做。
- **session 不要把那個 clone 當成專案目錄開**。上游的 `CLAUDE.md` 會匯入 `AGENTS.md`，`.claude/settings.json` 又掛了 hook，在 clone 裡直接開會讓 session 自認是 first mate。從別的目錄開，用絕對路徑改檔、用 `git -C <clone>` 下指令。
- 開工前讀 clone 裡的 `CONTRIBUTING.md` 與 `.agents/skills/firstmate-coding-guidelines/SKILL.md`。
- 每一段從 `carry` 開功能分支，PR 用 `gh pr create --repo guybeju/firstmate --base carry` 開回 fork。fork 的預設分支是 `main`，不寫 `--base` 會開錯。不對上游開 PR、issue、留言。
- 合併由使用者點頭。`carry` 跟上游同步只用合併，不 rebase。
- 測試不能碰運作中的主 home：每個測試用自己的暫存 home（看板的指令是 `MYSHAPE_HOME`，first mate 這一側的指令是 `FM_HOME`）。
- **上游的 CI 不會在這些 PR 上跑**（它只認 `main`）。驗收全靠各段列出的本機指令，結果貼進 PR。
- 要平行跑好幾個 session 時，每個用那個 clone 的一個 linked worktree，一樣從外面的目錄開。六段有先後相依，通常不需要平行。

## 這次彙整補定的五件事

| 事 | 定案 | 寫在 |
| --- | --- | --- |
| 原始碼放哪 | 頂層新目錄 `myshape/`：`src/`、`dist/`、`public/`、`rules/`、`spec/`、`test/`。Bash 入口在 `bin/`（`fm-on.sh` 只認那裡） | [contracts](contracts.markdown) 第 2 節 |
| TypeScript 怎麼變成能跑的東西 | 用釘死版本的 `tsc` 編成 `.js` 提交進 git，執行期只跑 `dist/`。原因：這台的 `node` 沒有 TypeScript 支援（實測） | [第二段](stage-2-service.markdown) |
| 規則範本放哪 | `fm-board/rules/*.md.tmpl`（原本在 `myshape/rules/`，規則是 first mate 的，後來搬到 first mate 這一側）。不能是 `.md`，也不能放 `config/` 或 `data/` | [adapter](../../fm-board/spec/adapter.markdown) 第 6 節 |
| 頁面上改名、改目標、封存、議題併議題放哪 | 都在議題頁：標題與目標旁的「編輯」鈕；標題列的「⋯」選單放「封存」與「併入其他議題…」 | [第五段](stage-5-browser.markdown) |
| 執行期的 npm 相依 | 沒有。只用 Node 的內建模組；開發期只有 `typescript` 與 `@types/node` | [第二段](stage-2-service.markdown) |

另外定了 spec 自己的位置：`myshape/spec/*.markdown`，由第一段的 PR 帶進 fork。

## 不在範圍內

- 議題與 agent 的真正多對多。
- 高優先插隊、暫停進行中的工作。
- 手機或對外存取。
- 修改上游既有檔案，包含派工腳本與 `AGENTS.md`（例外見 contracts 第 2 節）。
- 由獨立 agent 定期改寫議題摘要。
- 貢獻回 firstmate 上游。
- 整理 `events.jsonl`、`summaries.jsonl`、`audit.jsonl`（第一版不整理，`status` 印出大小）。
- 退回上游的步驟。
