# 第三段：輪詢與資料

做完之後：服務會定時叫各 home 的彙整腳本、把帳本事件存下來、算出每個議題底下有哪些 agent、燈號與待決事項；`summary` 與 `which` 可用。頁面還沒有，資料先經 socket 上只給測試用的 `op`（`dump`，只在 `MYSHAPE_TEST=1` 時註冊，回完整的看板狀態 JSON）驗證；第五段的 `GET /api/state` 回的就是同一份。

> 這一段的指令編號（R1 到 R3、W1 到 W9）與它們的結果怎麼判，是看板直接執行 first mate 的指令時的設計。
> 現在看板只執行 `bin/fm-board.sh feed` 與 `deliver`（[contracts](contracts.markdown) 第 4、7 節），原本的指令與結果對應搬到 first mate 這一側（[adapter](../../fm-board/spec/adapter.markdown) 第 3 節）；這一段其餘的行為不變。
> 「還沒換到 fork」現在是 first mate 的 feed 以 exit 4 給的那一行橫幅，`status` 對那種 home 印「無法回報」。

## 先驗再做

| # | 要驗的事 | 怎麼驗 | 假設不成立時 |
| --- | --- | --- | --- |
| 3-1 | parent channel 上的每一行都帶著子 task 的 id，主 first mate 能直接拿來當 `summary --home <id>` 的參數 | 有 secondmate 時，讓它底下的 worker 走到 PR 就緒，看主 home 收到的那一行 | 沒帶 id 的話，主 first mate 無法替 secondmate 的 worker 寫摘要。那些 task 就只有帳本事件，沒有摘要；功能其餘部分不受影響 |
| 3-2 | 主 first mate 處理 parent channel 的喚醒時，手上的文字夠寫一到三句 | 同上，看那個回合實際寫出的摘要 | 摘要會比較空泛。不影響機制 |
| 3-3 | 遠端 home 沒有彙整腳本時，`fm-on.sh` 的 stderr 含 `command is not tracked by the configured remote root` 或 `command is not a genuine executable in the configured remote root` | 對一台還沒換到 fork 的遠端跑 `bin/fm-on.sh <id> fm-topic-board-read.sh 0 -; echo $?` | 兩種字串都認；都對不上時把那個 home 標成「讀取失敗」並附 stderr 原文，不標「還沒換到 fork」 |
| 3-4 | `events.jsonl` 的大小估計（一千個 task 約 10 MB、一秒內讀完） | 用腳本產生 30 000 行、每行約 300 位元組的假檔，量啟動到 socket 可連的時間 | 超過 5 秒就在這一段加啟動時的進度 log，並在 [open-issues](open-issues.markdown) 開一條整理檔案的後續工作 |

3-1、3-2 需要 secondmate，這台沒有；不擋這一段的 PR。3-3 的兩個字串都來自讀原始碼（`bin/fm-remote-entrypoint.sh:134-145`），實作時兩個都認。3-4 已量（2026-11-16）：30 000 筆、9.9 MB 的 `events.jsonl`，從下指令到服務可連共 0.6 秒。

實作時另外確認了 C1 的現象：主 home 每次讀取，上游的 snapshot 都會自己經 `fm-on.sh` 去抓一台遠端的 `home-summary.json`（測試裡假的 `fm-on.sh` 記到了這些呼叫）。

## 要做的事

### 輪詢

- 輪詢只在「最近 2 分鐘內有人要過看板狀態」時進行。這一段的觸發來源是 `dump`；第五段接上頁面的輪詢。停了之後服務照常留著，下次從存好的 offset 接續。後來（C62）沒有人要狀態時改成慢慢讀：每個 home 上一次讀完後 900 秒、遠端的 3600 秒（[contracts](contracts.markdown) 第 10 節），讓沒有人看頁面時生命週期照常判斷。
- 主 home：每 10 秒執行白名單的 R1。它的 `secondmates[]` 決定還有哪些 home。
- 同機的 secondmate home：每 10 秒執行 R2。
- 遠端 home：每 60 秒執行 R3，各 home 錯開起始時間。
- 同一個 home 不重疊：上一次還沒回來就跳過這一輪。每次執行的逾時：本機 60 秒，遠端 400 秒（比 `fm-on.sh` 預設的 job 逾時 360 秒長一點）。
- 回傳的 `ledger.more` 是 true 就馬上再讀一次，直到追上。
- 「立刻更新」：對所有 home 馬上各跑一輪（仍然不重疊）。
- 這一段只執行 R1 到 R3。執行外部指令的那一層做成單一模組，只接受 [contracts](contracts.markdown) 第 7 節表裡的形狀，參數不合就丟錯；第四段的寫入也走同一層。

### 存帳本事件

每次讀到 `ledger.lines`：

1. 過濾掉 (home, 原始行) 已經見過的。
2. 把剩下的追加到 `data/myshape/events.jsonl`。
3. 然後才用暫存檔加 rename 把該 home 的 `to_offset` 與 `to_prefix_sha256` 寫進 `offsets.json`。

兩步之間當掉，下次重拉同一段，靠去重消掉重複。遇到 `continuity-broken`，就把該 home 的 offset 歸零重讀。看板從不截斷任何 home 的帳本。

### 每個 home 的狀態

服務對每個 home 記：最後一次成功的彙整結果與時間、最後一次的錯誤、`schema`、`code_commit`。由此算出：

| 顯示 | 條件 | 處理 |
| --- | --- | --- |
| 還沒換到 fork | R3 失敗，stderr 符合 3-3 的字串 | 不顯示這個 home 的 agent；附上要做的設定（[rollout](../../fm-board/spec/rollout.markdown) 的第 2 步）與 `/updatefirstmate` |
| 版本不相容 | `schema` 和服務認得的不同 | 不使用這份輸出；附「在主 home 跑 `/updatefirstmate`」 |
| 版本不同 | `schema` 相同，`code_commit` 和主 home 的不同 | 資料照常使用，在 home 的標籤旁標出 |
| 帳本未開 | `ledger_enabled` 是 false | 附上要跑的指令：主 home `bin/fm-board.sh setup`、同機 `bin/fm-board.sh --in-home <id> setup`、遠端 `bin/fm-on.sh <id> fm-board.sh setup` |
| 過期 | 最後一次成功超過 3 分鐘 | 該 home 的燈全部轉成「未知」，保留最後已知的狀態文字與「最後更新 N 分鐘前」；待決事項標「可能已過時」；更新區塊照常 |

`code_commit` 取的是那個 home 自己的 checkout（home 本身是 git checkout 時用它的 `HEAD`，否則用 code root 的）。同機的 secondmate home 是由主 home 的腳本切過去讀的，不這樣取就永遠回主 home 的 commit、永遠顯示「相同」。

`myshape.sh status` 多列出每個 home 的版本狀態（相同、版本不同、版本不相容、還沒換到 fork）。服務沒跑時不列。

### 算出看板狀態

每次有新資料，重算一份完整的看板狀態，版本號加一：

- **議題與 agent 的關聯**：對每個 (home, task)，取議題標記最後一行的議題 id，過 `merged`。結果是沒封存的議題就歸給它；封存的歸給那個封存議題；其他情況（沒有標記、id 對不上）進未分類區，並帶原因。
- **每個議題的更新**：帳本事件依「事件時間之前最近的一行標記」歸議題；系統紀錄用自己的 `topic`；里程碑摘要依 (home, task) 目前的議題歸。依時間排，新的在上。
- **PR 連結**：`task.pr_ready`、`task.merged` 事件自己帶的網址。`ready` 與 `landed` 的摘要接上同一個 (home, task) 在摘要時間之前最近一筆 `task.pr_ready` 或 `task.merged` 的連結；`report` 與 `failed` 不接。
- **燈號**：照 [contracts](contracts.markdown) 第 5 節。
  什麼算 agent 照 contracts 第 1 節：secondmate 自己不列為 agent，只列它派出的 worker，並標明所在的 home；home 已經沒有的 task 標成已結束（`finished`）。
- **待決事項**：每個 hold 屬於哪個議題：先看被 hold 的 task 自己的標記，沒有就看 `origin` 那個 task 的標記，都沒有就是未分類。排序：`live` 在前，`aged` 與日期已到的 `dated` 也算在這一組（卡上標「已放超過 14 天」「延到 …，日期到了」），還沒到的 `dated`、`blocked` 與讀不懂的（合稱暫緩）在後；同一組裡依議題的佇列順序（高、一般、待辦，同佇列照陣列順序），同一議題內最舊的在前，未分類排最後。暫緩的寫出原因：「延到 YYYY-MM-DD」「等 <id> 完成」「讀不懂的分類：<讀到的字>」。等看板看不到的工作的 `blocked` 過了期限也進前一組（[lifecycle](lifecycle.markdown) D5）。
  這一組之後是 aggregator 的提議關閉、看板的「沒人處理的議題」與「沒人接」卡，合成一條佇列（[lifecycle](lifecycle.markdown) 第 4 節）。根 home 回報的 `aggregator.decisions_at_once`（[contracts](contracts.markdown) C10）設了時，照這個順序的前那麼多張在前面，其他的標成在排隊（`waits_turn`），暫緩的不算；跨所有 home 一起算。沒有設時待決事項都在前面，後三種一次一張。有一個在排隊的待決事項、而 backlog 項目在等它時，那個項目寫「決定排隊」，不寫「等你決定」。
- **選項**：問題最後一行裡最後一個 `選項：`（全形冒號）之後的文字，以 ` | ` 分隔，至少兩個、每個都不是空的，才解析成按鈕；否則沒有按鈕。文字框一律有。不要求 `選項：` 在行首：上游把 hold reason 存在 backlog 項目的標題行，寫成多行的 reason 到看板時可能已經是一行。
- **worker 提問**：`status_decisions[]`（彙整腳本只收 `needs-decision`，不收 `blocked`）依 task 的議題歸位，標「first mate 處理中」，不能作答。
  `kind` 是 secondmate 的 task 的那一行是 secondmate 給 first mate 的回報，不算 worker 提問（C53）。
- **提議關閉**：有 `close_proposal` 的議題（只有 aggregator 提的）。
- **生命週期**：每次讀好一個 home 之後，看板照 [lifecycle](lifecycle.markdown) 判斷每張卡的狀態、存下計時、把過了期限的卡放到使用者面前。

### `summary` 與 `which`

- `summary [--home <secondmate-id>] <task-id> <ready|report|failed|landed> -`：本文走 stdin。
  1. 檢查 kind、本文是 1 到 600 個碼位、去頭尾空白後不是空的。
  2. `--home` 的值必須在 `secondmates[]` 裡。服務還沒有任何主 home 的彙整結果時（剛啟動、從沒輪詢過），先同步跑一次 R1 再檢查，最多等 10 秒（採建議 C10）。
  3. 和既有的 (home, task, kind, text) 相同就不再追加。否則追加到 `summaries.jsonl`。
  4. 存好之後才查議題，查不到不影響存檔。
  5. 印出可以直接當聊天提醒開頭的那一行，見下。
- `which [--home <secondmate-id>] <task-id>`：唯讀，只做第 2 與第 5 步。

第 5 步怎麼決定印什麼：

| 情況 | 印出 |
| --- | --- |
| 查到議題 | `<議題名稱>：` |
| 服務不認得這個 task 的標記 → 對那個 home 補跑一次讀取（R1、R2 或 R3），最多等 10 秒 → 讀到了、確實沒有標記 | `未分類：` |
| 補讀失敗或逾時，之前讀到過這個 task 的標記 | 照那個標記回答，和上面兩列一樣 |
| 補讀失敗或逾時，從沒讀到過這個 task 的標記 | `議題待查（<task-id>）：` |

不能把連不上說成未分類。「議題待查」的意思是議題還要再查，不是查詢壞了：之前讀到這個 task 時它沒有標記，或從沒讀到過它，看板都只知道還沒看過它的標記。補讀必須是「在這個要求之後才開始」的讀取：已經有一次讀取在進行時，先等它結束再讀一次，不能直接沿用（它可能在 task 被標記之前就開始了）。

### 系統紀錄

第二段已經在議題操作時寫系統紀錄。這一段確認它們和帳本事件一起出現在議題的更新裡。`agent.tagged` 與 `hold.answered` 兩種由第四段寫。

## 驗收

1. `<clone>/myshape/test/run.sh 1 2 3` 回 0。第三段的測試用假的 `bin/`：`fm-topic-board-read.sh` 換成會依參數回固定 JSON 的假腳本，`fm-on.sh` 換成會轉呼叫或回指定錯誤的假腳本。至少涵蓋：
   - 全量、delta、`more: true` 的連續讀取、`continuity-broken` 後重讀且不產生重複事件。
   - 「先追加事件、再寫 offset」之間殺掉服務，重啟後沒有重複也沒有遺漏。
   - 五種 home 狀態各一例。
   - 關聯：有效標記、沒有標記、對不上的 id、`merged` 的舊 id、task id 重用時舊事件留在舊議題。
   - 燈號五種，含「已清理的 task 由最後一筆事件推出」與「有 live hold 時優先」。
   - 待決事項的歸屬（自己的標記、origin 的標記、未分類）與排序；選項行的解析（符合、少一個空白、不在最後一行）。
   - `summary`：存檔、去重、超過 600 碼位被拒、三種回印；`--home` 不在 `secondmates[]` 被拒；冷啟動時會先讀一次主 home。
   - 2 分鐘沒有人要狀態之後不再照各 home 的間隔讀取（後來改成慢讀，C62）；再要一次就恢復。
   - 執行層拒絕白名單以外的 argv。
2. 第二段的驗收第 2 到 4 條、第一段的第 2 到 5 條再跑一次。
3. 先驗項目 3-4 的數字寫進 PR。
