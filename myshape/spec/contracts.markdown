# 共用契約

六段都會用到的格式與規則只寫在這裡，各段的檔案只引用。實作時改到這裡的任何一條，要在同一個 PR 改這個檔。

標「（採建議 Cn）」的地方，是各票互相矛盾或沒接上、這份 spec 先照建議寫的；清單與理由在 [open-issues](open-issues.markdown)。

## 1. 名詞

- **議題**：看板上的一張卡。有名稱、一行目標、所在佇列與順序。一建立就排在佇列最後，不等誰確認（C52）。可以沒有任何 agent。
- **議題 id**：議題成立時給的穩定識別碼，改名不變。所有指向議題的地方都用它。
- **hashtag**：有人刻意貼在議題上的標記，只描述議題的內容（例如 `AI_INFRA` 表示這是 AI 基礎設施的事）。一個議題零到多個；task 不另存 hashtag，算它所屬議題的。hashtag 不改任何議題的佇列、順序或派工，看板也不因 hashtag 送任何通知或交付。存在 `data/myshape/hashtags.json`（第 3.8 節）。
- **視圖**：頁面上的一組篩選（hashtag 按鈕、關鍵字、「（沒標）」），只改頁面上看到什麼；使用者可以把它存成有名字的視圖（第 3.8 節）。
- **task**：firstmate 原意，一個 worker 跑的一件事。**agent** 是執行某個 task 的 worker，一個 agent 只屬於一個議題。
  home 還有紀錄的 task 照它的 `kind` 判斷（secondmate 自己不是 agent）；home 已經沒有的 task，只有帳本記過它的 worker 生命週期（`task.dispatched`、`task.pr_ready`、`task.merged`、`task.cleaned_up` 任一筆），而且最近一次派工不是 secondmate 時，才算已經結束的 agent。
  所以退役 secondmate 自己的事件、遠端 secondmate 的回報通道（`parent-replies`，只有狀態行）都不是 agent；它們的事件仍在更新裡，有標記就歸那個議題（C53）。
- **home**：aggregator 給看板讀的一組工作，名字由 aggregator 給（第 4 節）。根 home 記作 `main`；first mate 的 secondmate home 用它的 secondmate id。看板不知道 home 在哪台機器上。task id 只在單一 home 內唯一，所以指 task 一律用 (home, task id)。
- **aggregator**：看板另一邊的 agent，餵資料給看板、收頁面上的動作（第 4、7 節）；今天是 first mate。頁面用它在回報裡給的 `label` 稱呼它。
- **議題標記**：某個 home 裡一個 task 屬於哪個議題的紀錄，建立 backlog 項目時寫下，最晚在派工前；每個 home 只對自己的 task 持有正本。
- **歸併**：把一個 agent 歸到一個議題，或把一個議題併進另一個議題。對 agent 而言就是在它所在的 home 補寫一筆議題標記。
- **未分類區**：還需要一個議題的東西：沒有有效標記、還在跑的 agent，沒有歸屬的待決事項、worker 提問與這些 agent 的摘要，沒標議題的排隊項目。
  已經結束、沒有有效標記的 agent 與它們的摘要摺在最後的「已結束、沒標議題 N」，仍可歸併（C53）。
- **要你動手的項目**：要使用者親手做的事（sudo 指令、登入）。看板自己存在 `data/myshape/todos.json`（第 3.6 節）：要做什麼（一行）、可以沒有的說明（不是指令，沒有複製鈕），與零到多個指令，每個原樣保存（C54）。aggregator 用 `myshape.sh todo add` 放上看板，每個項目在一個議題底下。
  看板存項目之前，first mate 的項目是主 home 原因以 `動手：` 開頭的 captain hold；舊版的 first mate 那一側把它們搬上看板，現在這種 hold 和其他 captain hold 一樣是待決事項（[adapter](../../fm-board/spec/adapter.markdown) 第 3.3 節）。看板自己不讀 hold 的文字。
- **排程**：掛在一個議題上的時間規則：每天或每週某幾天的 `HH:MM`，加一個 IANA 時區。一個議題最多一筆排程；有排程的議題存在「待辦」（第 3.1、3.9 節）。看板自己存在 `data/myshape/schedules.json`，aggregator 用 `myshape.sh schedule …` 建立與回報，使用者的設定、上鎖與撤回只在頁面上（第 6.1 節）。
- **一場**：排程規則算出的一個時刻 T，鍵是排程 id 加 T 的 UTC 時刻，例如 `weekly-sync:20261130T0200Z`。看板的時鐘在 T 減提前分鐘數時開這一場、送「快到了」，在 T 送「到了」，開著的一場到 `closes_by` 一定結束（第 3.9 節）。
- **待決事項**：等使用者回答的 captain hold。**worker 提問**是狀態行裡的 `needs-decision`，對象是 first mate，看板只列出、不能作答。
- **燈號**：待你決定、卡住、進行中、完成、未知，共五種。
- **直送**：從看板把訊息送給某一個 agent，不經主 first mate。
- **里程碑**：`ready`、`report`、`failed`、`landed` 四種結果。**里程碑摘要**是 first mate 在里程碑發生時寫的一到三句。
- **系統紀錄**：看板自己寫的一行紀錄，不經模型。看板的每一個改動都寫至少一筆，和改動存在同一次存檔裡（第 3.3 節）；在看板作答、歸併送到之後也各寫一筆；讀到一個 home 的待決事項開了、關了，也各寫一筆。每筆記下誰做的：使用者（頁面）、aggregator（指令）或看板自己（啟動時、讀取時，與排程的時鐘）。
- **結果不明**：寫入已送出、不知道有沒有生效、重送可能重複。**未送達**：可以安全重送，但重試次數用完。**失敗**：確定沒生效。

## 2. fork 裡新增的檔案

fork 裡看板新增的檔案、改到上游檔案的三處例外與 fork 的硬性限制，在 first mate 這一側的 [adapter](../../fm-board/spec/adapter.markdown) 第 8 節。

## 3. 執行期的檔案（都在主 home，不進 git）

| 路徑 | 權限 | 內容 | 誰寫 |
| --- | --- | --- | --- |
| `data/topics.json` | 0644 | 沒封存的議題 | 只有看板服務 |
| `data/topics-archive.json` | 0644 | 已封存的議題 | 只有看板服務 |
| `data/myshape/events.jsonl` | 0644 | 各 home 的帳本事件加系統紀錄，只追加 | 只有看板服務 |
| `data/myshape/summaries.jsonl` | 0644 | 里程碑摘要，只追加 | 只有看板服務 |
| `data/myshape/offsets.json` | 0644 | 每個 home 的帳本游標 | 只有看板服務 |
| `data/myshape/notify-pending.json` | 0644 | 等著發「議題變成可派」通知的議題與到期時間（第 7 節） | 只有看板服務 |
| `data/myshape/aggregator.json` | 0644 | 最近一次根 home 回報裡的 `aggregator`，讓看板在下一次讀到之前寫的字也用對名字 | 只有看板服務 |
| `data/myshape/todos.json` | 0644 | 要你動手的項目（第 3.6 節） | 只有看板服務 |
| `data/myshape/decisions.json` | 0644 | 每個 home 上一次讀到的待決事項與已關的待決事項的游標（第 3.7 節） | 只有看板服務 |
| `data/myshape/hashtags.json` | 0644 | hashtag、每個議題貼了哪些、命名視圖與 hashtag 設定（第 3.8 節） | 只有看板服務 |
| `data/myshape/schedules.json` | 0644 | 排程、開著的場次、每個排程最近十場、使用者的排程設定，與刪掉 30 天內的排程（第 3.9 節） | 只有看板服務 |
| `data/myshape/confirmations.json` | 0644 | 使用者在頁面上確認過的程式：每支程式一筆，完整路徑、程式內容與設定檔內容的 SHA-256、時間，加上一次改動的 `outbox`（第 7 節） | 只有看板服務，只在頁面上的確認動作 |
| `data/<task-id>/topic` | 0644 | 議題標記，每個 home 各自一份 | `fm-board.sh tag`（first mate 這一側；看板經 feed 讀） |
| `state/myshape/` | 0700 | 下面這些檔的目錄 | 服務 |
| `state/myshape/board.sock` | 0600 | Unix socket | 服務 |
| `state/myshape/token` | 0600 | 瀏覽器用的 token | 服務 |
| `state/myshape/port`、`pid` | 0600 | 實際的埠、服務的 pid | 服務 |
| `state/myshape/startup-error` | 0600 | 上一次啟動失敗的原因，一行 JSON；啟動成功就刪掉 | 服務 |
| `state/myshape/start.lock/` | — | 啟動鎖（目錄），裡面記持有它的 client 的 pid | node client |
| `state/myshape/service.log`、`service.log.1` | 0600 | 服務的 stdio | 服務 |
| `state/myshape/audit.jsonl` | 0600 | 稽核紀錄，只追加 | 服務 |
| `config/myshape-port` | — | 選用，一行埠號 | 使用者 |
| `config/myshape-aggregator.json` | 0644，別的帳號不能寫 | 看板接哪個 aggregator：名稱與 feed、deliver 兩支程式的路徑（第 7 節）；看板只讀 | 使用者，或 aggregator 照使用者的意思寫（first mate 是 `fm-board.sh setup`、`bind` 與 session start） |
| `config/fleet-ledger` | — | 上游的帳本旗標，每個 home 各一 | `fm-board.sh setup`（first mate 這一側） |

每次改寫整個檔（`topics.json`、`topics-archive.json`、`offsets.json`、`notify-pending.json`、`aggregator.json`、`todos.json`、`decisions.json`、`confirmations.json`、`hashtags.json`、`schedules.json`、`token`、`port`、`pid`）都用同目錄的暫存檔 `<檔名>.tmp-<pid>` 加 rename。

### 3.1 `data/topics.json`

```json
{
  "v": 1,
  "next_seq": 3,
  "queues": { "high": ["billing"], "normal": ["t2"], "later": [] },
  "topics": {
    "billing": {
      "name": "帳務重構", "goal": "把扣款流程搬到新服務",
      "status": "confirmed", "created_at": "2026-11-16T02:00:00Z",
      "close_proposal": { "at": "2026-11-17T01:00:00Z", "reason": "三個 PR 都已合併" }
    }
  },
  "merged": { "old-id": "billing" },
  "history": [
    { "at": "2026-11-18T01:00:00Z", "kind": "renamed", "topic": "reports", "name": "帳務報表", "from_name": "報表" },
    { "at": "2026-11-20T01:00:00Z", "kind": "merged", "topic": "billing", "name": "帳務重構",
      "from": "reports", "from_name": "帳務報表", "reason": "和帳務是同一件事", "by": "command" }
  ],
  "todos": {
    "mac-todo-xcode": { "state": "claimed", "at": "2026-11-17T03:00:00Z" },
    "mac-todo-tailscale": { "state": "rejected", "at": "2026-11-17T03:10:00Z", "reason": "服務沒起來" }
  }
}
```

- `queues` 的陣列順序就是顯示與派工順序。
- `status` 一律是 `confirmed`：議題一建立就已確認，這個欄位留著只是讓還在讀它的舊版程式讀得懂（C52）。
  舊版程式留下的 `status: "proposed"` 議題，看板啟動時照建立時間排到它提議時的佇列（`suggested_queue`，沒有就是 `normal`）最後，立刻寫回檔案，每一個寫一筆系統紀錄並通知主 first mate；封存檔裡的同樣改成 `confirmed`，仍然留在封存。
  舊檔的 `proposed_by`、`suggested_queue` 讀了不用，下一次存檔就不再寫。
- `merged` 是「舊 id → 新 id」，可以串接；讀到舊 id 的地方一律走到底。各 home 的標記檔不重寫。
- `history` 是來歷紀錄，舊的在前，和議題的變動寫在同一次存檔裡。`kind` 是 `merged`、`renamed`、`split`、`archived`、`reopened`、`moved`、`goal`；`moved` 另記移到的 `queue` 與從 1 起算的 `position`，`goal` 另記新的 `goal`，這兩種 `find` 只在 `--all` 時印；`topic` 與 `name` 是變動之後留下來的議題，合併另記被併掉的 `from` 與 `from_name`，改名另記舊名字 `from_name`，拆分的 `topic` 是新議題、`from` 是它拆出來的來源。另有兩個可省略的欄位：`reason` 是原因（`merge`、`split` 帶的 `--reason`，或封存之前的關閉提議），`by` 是在哪裡做的，`page` 或 `command`（C50）。搬了哪些 task 不記在這裡，各 task 的標記檔本來就有每次標記的時間。沒有這個欄位的舊檔當成空的；讀不懂的項目略過。`myshape.sh find` 讀它。
- `todos` 記要你動手的項目在「還沒做」之外的狀態，鍵是項目 id：`claimed`（使用者按了做完了，等 aggregator 驗證）、`rejected`（驗證沒過，附 `reason`）、`obsolete`（不再需要，附 `reason`，等使用者撤下）。項目本身在 `data/myshape/todos.json`（第 3.6 節）；看板每次改項目都在同一次把這一欄改寫成那裡每個不是「還沒做」的項目的狀態，加上還在等搬上看板的舊狀態，所以讀這個檔的程式（與退回之前的舊版看板）照樣讀得到。沒有這個欄位的舊檔當成空的；讀不懂的項目略過。
- `outbox` 是最後一次經這個檔存的議題改動寫的系統紀錄（第 3.3 節），和改動在同一次改名裡存下；看板每次改動前與每次啟動時，把 `events.jsonl` 還沒有的補寫進去。要你動手的改動只改寫這個檔的 `todos`，`outbox` 照舊留著。沒有這個欄位的舊檔當成空的；舊版程式存檔時會丟掉它，已經寫進 `events.jsonl` 的紀錄不受影響。
- `close_proposal` 沒有就省略。
- 有排程的議題（第 3.9 節）一直存在 `later`（待辦）：`move` 只拒絕把它移出待辦（「這個議題有排程，位置由時間決定；要移出「待辦」，先刪掉排程。」），在待辦裡移動照舊；`reopen` 一律把它放回待辦，不排「現在可派」；兩個都有排程的議題不能合併（「先刪掉其中一筆排程」），只有一邊有排程時，排程跟著到新的議題，新議題移到待辦最後，另記一筆 `schedule.merged`；封存它時排程暫停、開著的一場結束，各記一筆。要它變回一般議題，先刪掉排程。
- `next_seq` 是 `t<流水號>` 的下一個號碼，只增不減（採建議 C14）。
- `data/topics-archive.json`：`{"v":1,"topics":{<id>:{…同上…,"archived_at":…}}}`。

**議題 id**：文法 `[A-Za-z0-9._-]`，不以 `.` 或 `-` 開頭，最長 64 字元。建立時由名稱產生 slug（小寫、非 `[a-z0-9]` 的連續字元換成 `-`、去頭尾的 `-`）；slug 是空的（例如純中文）就用 `t<next_seq>`；和既有的 id 重複就加 `-2`、`-3`。「既有」包含 `topics`、封存檔與 `merged` 的鍵：封存或併掉的 id 永不重用。`--id` 可以自行指定，一樣要通過這些檢查。

### 3.2 議題標記 `data/<task-id>/topic`

只追加，每行 `<議題 id> <UTC ISO 8601 時間>`。最後一行是目前的議題。看板把每筆帳本事件歸給「事件時間之前最近的一行」的議題；task id 被重用時，舊事件留在舊議題。

### 3.3 `data/myshape/events.jsonl`

每行一個 JSON：

- 帳本事件：`{"src":"ledger","home":"<home>","raw":"<上游帳本的那一行，原樣的字串>"}`。存原始字串而不是解析後的物件，重啟後才能用同樣的位元組去重。上游的事件有 `v`、`ts`（epoch 秒）、`event`、`task`，五種 `event`：`task.dispatched`、`task.status`、`task.pr_ready`、`task.merged`、`task.cleaned_up`。
- 系統紀錄（`ts` 也是 epoch 秒）：`{"src":"board","rid":"r-<boot_id>-<n>","ts":…,"kind":"…","topic":"<id>","home":…,"task":…,"by":"captain|aggregator|board","label":"<當時 aggregator 的名稱>","text":"<顯示用的一行>"}`。議題層級的紀錄沒有 `home` 與 `task`。
  使用者可能要看或撤回的改動另帶 `before` 與 `after`（改之前與之後，第 3.8 節），撤回另一筆的紀錄帶 `ref`（被撤回那一筆的 `rid`）。
  `rid` 是這筆紀錄的 id，補寫時用它去重；`by` 是看板能證明的做的人：`captain` 是頁面上拿著 token 的人做的，`aggregator` 是經 socket 的指令做的，`board` 是看板自己做的：啟動時、讀取時，以及排程的時鐘寫的（開場、到了、照時間結束、錯過，與沒送出就過期的通知）。這兩個欄位之前寫下的紀錄沒有。
  排程的 `kind`，都在排程議題底下（設定與全部暫停沒有議題）：`schedule.created`、`schedule.edited`、`schedule.paused`、`schedule.resumed`、`schedule.skipped`（跳過下一場）、`schedule.rt_changed`、`schedule.deleted`、`schedule.merged`（排程跟著議題合併過去，存在 `topics.json`）、`schedule.locked`（上鎖或解鎖排程或它的 rt）、`schedule.seen`（使用者看過 aggregator 到那時為止的排程改動，沒有議題）、`schedule.reverted`（帶 `ref`：撤回的那一筆的 `rid`）、`schedule.settings_changed`、`schedule.all_paused`；一場的 `occurrence.opened`（時鐘開了這一場）、`occurrence.due`（時鐘：時間到了；排程暫停中時寫明沒有送通知）、`occurrence.taken`（aggregator 接下）、`occurrence.closed`（結束，`outcome` 是 `done` 或 `skipped`；時鐘照時間結束的是 `untaken`（沒有人接）或 `timed_out`（接了沒回報結束，到 `closes_by`），`by` 是 `board`）與 `occurrence.missed`（時鐘：看板沒在跑時整個時段都過去了，`outcome` 是 `missed`）。改排程的紀錄另帶 `before` 與 `after`：改前改後那筆排程的 JSON 字串（`{"id":…,"series":…,"skips":[…]}`，`series` 去掉 `seen` 與 `checked_through`，`skips` 是事先跳過的場次），設定的紀錄是改前改後的設定；頁面的撤回從這兩個欄位做。`by` 照上面的意思：頁面上做的是 `captain`，`myshape.sh schedule` 是 `aggregator`。
  議題的 `kind`：`topic.created`、`topic.confirmed`、`topic.merged`、`topic.split`、`topic.close_proposed`、`topic.kept`（使用者按了先不關）、`topic.archived`、`topic.reopened`、`topic.moved`、`topic.renamed`、`topic.goal_changed`。頁面上做的 `text` 結尾是「（你在頁面上）」，指令做的是「（<aggregator 的名稱> 用指令）」。
  頁面上的寫入送到之後：`agent.tagged`（歸併）、`hold.answered`（在看板作答，`outcome` 是答案的選項）；作答時那個待決事項已經在別處結束（結果是 `handled_elsewhere`）寫 `hold.closed`，`outcome` 是 `elsewhere`。
- 要你動手的項目每一步都寫一筆系統紀錄，在項目的議題底下（沒有議題的項目 `topic` 是 `null`），`home` 與 `task` 都是 `null`，標題寫在 `text` 裡。另帶 `item`（項目 id），關掉的另帶 `outcome`（`done`、`dropped`、`taken_down`），帶原因的另帶 `reason`。
  `kind`：`todo.opened`（放上看板）、`todo.rewritten`（內容改寫，回到還沒做）、`todo.claimed`（使用者按了做完了）、`todo.rejected`（驗證沒過）、`todo.obsolete`（不再需要，等使用者撤下）、`todo.done`（做完了，驗證過）、`todo.dropped`（使用者按了不做了）、`todo.taken_down`（撤下：aggregator 撤下不再需要的，或使用者按了好，撤下）。
  另有一種沒有議題的紀錄：`todo.marks_carried`（看板第一次自己存項目時，從 `topics.json` 帶過來舊狀態）。
  較早的看板還寫過 `todo.adopted`（從看板存項目之前的紀錄搬上來）、`outcome` 是 `elsewhere` 的 `todo.taken_down`（搬上來的項目的 hold 已在別處關掉），與沒有議題的 `todo.forgotten`、`todo.settled`；存下的這些紀錄照樣讀、照樣顯示它們的 `text`。
  `text` 例：「要你動手「登入 VPN」已關：做完了，first mate 已驗證（first mate 用指令）」、「要你動手「登入 VPN」：你按了做完了（你在頁面上）」。
  `topic.confirmed` 只在看板啟動時確認舊版留下的提議時寫，封存檔裡的也寫（第 3.1 節）；更早寫下的照樣顯示。
- hashtag 的每一個改動都寫一筆系統紀錄（第 3.8 節），帶 `before` 與 `after`。在一個議題上的帶那個議題的 `topic`，`before`、`after` 是那個議題改前改後的 hashtag，用一個空白隔開：`hashtag.added`（貼上；開了新的 hashtag 另帶 `outcome: "created"`）、`hashtag.removed`（撕掉）、`hashtag.carried`（議題合併或拆分時帶過來的）、`hashtag.reverted`（使用者撤回 aggregator 的一筆改動，帶 `ref`）。整個 hashtag 的沒有議題：`hashtag.renamed`、`hashtag.merged`、`hashtag.deleted`（`before` 與 `after` 是名稱，刪掉的 `after` 是空字串）、`hashtag.lock_changed`、`hashtag.color_changed`、`hashtag.settings_changed`（`before` 與 `after` 是設定的 JSON）、`hashtag.view_saved`、`hashtag.view_deleted`（視圖的 JSON），與沒有 `before`、`after` 的 `hashtag.seen`（使用者按了「看過了」）。
  `text` 例：「議題「GPU 叢集」貼上 #AI_INFRA（新開的 hashtag：#AI_INFRA）（first mate 用指令）」、「hashtag #AI_INFA 併入 #AI_INFRA（2 個議題）（你在頁面上）」。
- 看板接上 aggregator 的兩種紀錄，都沒有議題，`home` 與 `task` 是 `null`（第 7 節）：`program.confirmed`（使用者在頁面上確認看板可以執行一支程式，`by` 是 `captain`，`text` 寫出完整路徑、角色與 SHA-256，例如「確認看板可以執行 /opt/agg/plain（feed、deliver；SHA-256 …）（你在頁面上）」），與 `writes.released`（等著的寫入交給 deliver 的程式之前，`by` 是 `board`，`text` 寫出依序放行的 id，例如「接上 plain，依序送出等著的 2 筆：w-…、w-…」）。排程的通知過期沒送出時另寫一筆 `writes.expired`，在那個議題底下，`by` 是 `board`，`text` 寫出為什麼沒送與通知的全文，例如「沒送：已過期限 …（期限 11-30（一）10:00）：排程「週會」…」。
- 待決事項從讀取資料記下的開與關（C59），`by` 是 `board`，在待決事項的議題底下（它自己的標記，沒有就是來源 task 的），帶 `home` 與 `task`：
  - `hold.opened`：一次讀取的 `holds[]` 裡有、上一次讀取沒有的 hold。同一個 `code_commit` 之間以 task 與 `hold_set` 認一個 hold；`code_commit` 換了的那一次只以 task 認，因為不同的讀取程式可能把同一個 hold 寫成不同的樣子（較舊的沒有 `hold_set`），而且只有 `hold_set` 是確切時間、不早於那個 home 的 `seen_at`（第 3.7 節）的才寫開啟：比那更早的 hold 本來就開著，只是新的讀取程式才報出來（例如不再略過主 home 的 `動手：` hold）。`ts` 是它的 `hold_set`；`hold_set` 只有日期或沒有時是這次讀取的時間，`text` 結尾加「（最晚 MM-DD HH:mm）」。`closed_holds[]` 裡一個上一次讀取時還沒開的、帶 `opened_at` 的待決事項，也先寫一筆，`ts` 是 `opened_at`。
  - `hold.closed`：`closed_holds[]` 裡上一次讀取沒有的一筆。`ts` 是它的 `closed_at`，沒有時是這次讀取的時間，加「（最晚 …）」。`outcome` 是 Resolution mode（`answered`、`released`、`repaired`、`reconciled`、`forge-closed`、`forge-released`，空的記成 `answered`），`answer` 是答案，`source` 是經哪裡（`chat` 是 first mate 直接記下的話）。在看板作答的（`source` 是 `myshape`）有看板自己的 `hold.answered`（`outcome` 是那個答案或它顯示的字）時不另寫，那一筆就是它的關閉；看板的那個作答還在送出中、等待或重試時先不寫，也不記成看過，游標留在原處，下一次讀再看；兩者都不是（送出的結果不是已送達，或有人用同一個入口手動作答）時照一般的關閉寫，「經看板」。
  - 兩種都帶 `key`：`hold.opened\t<home>\t<task>\t<hold_set>`（從 `closed_holds[]` 先寫的是 `…\t#<digest>`）與 `hold.closed\t<home>\t<task>\t<digest>`。看板啟動時從這個檔重建 key 的集合，同一個 key 只寫一次。
  - 從什麼時候開始看：看板第一次讀到一個 home 的那一次不寫開啟；那個 home 的回報還沒給過 `closed_cursor`，或看板還沒交給它游標的那一次，不寫關閉。那時已經開著、已經關掉的都不補記。`code_commit` 換了（每一次更新程式都是）不是重新開始：看板接著上一次成功讀取時記下的比，所以更新前最後一次讀取之後、更新後第一次讀取之前開的待決事項有它的開啟，之前就開著的不再寫一次。照舊不寫開啟的情形：同一個 task 在那段空檔裡關掉又重新 hold（新的那一輪只以 task 認，當成已經看過）；`hold_set` 不是確切時間的 hold；看板記下的那一筆是較舊的看板寫的、沒有 `seen_at` 的那一次（換上這一版的那次更新就是）。讀取失敗、回 4、版本不對或不是合法的回報時什麼都不寫，也不當成每個待決事項都關了。
  `text` 例：「待決事項「NAS 兩步驗證」已開：NAS 要不要開兩步驗證？」、「待決事項「NAS 兩步驗證」已回答：要（經聊天）」、「待決事項「X」已回答並放行，工作繼續：好（經聊天）」、「待決事項「X」已對帳結束，不必再答：…」、「待決事項「X」隨 PR 結束而關閉」。
- 每一個改動都有一個存它的檔：議題的改動是 `topics.json`，要你動手的改動是 `data/myshape/todos.json`，確認程式是 `data/myshape/confirmations.json`，hashtag 的改動是 `data/myshape/hashtags.json`，排程的改動是 `data/myshape/schedules.json`；只存紀錄的改動（例如 `writes.released`）經 `topics.json`。看板先把五個檔 `outbox` 裡 `events.jsonl` 還沒有的紀錄補寫進去（寫不進去就拒絕這次改動，回「看板寫不進紀錄（原因），這次的修改沒有做」），再把改動和它的紀錄一起寫進那個檔的 `outbox`、用同一次改名存下，然後把紀錄追加到這裡並 fsync。追加失敗時改動已經生效，紀錄留在 `outbox`，下一次改動或下一次啟動補寫；啟動時補寫不進去，看板就不啟動。
  建立帶 hashtag 的議題、合併與拆分議題，是一個議題的改動加上它在 `hashtags.json` 的後續：`topics.json`（帶議題的紀錄）先存，`hashtags.json`（帶 hashtag 的紀錄）緊接著存，所以中途當掉時議題的改動已經生效並有紀錄，hashtag 的後續沒做也沒有紀錄：只會有一個少了 hashtag 的議題，不會有貼在不存在的議題上的 hashtag。
  封存一個有排程的議題時，排程那一份先寫進 `schedules.json`（帶它自己的紀錄），再寫議題的檔；中途當掉時排程已暫停、有紀錄，議題還沒封存，再封存一次不會再動排程。
  封存時封存檔先寫、`topics.json` 後寫，重開時反過來，所以中途當掉時議題留在 `topics.json`、沒有紀錄，或兩邊都有、`topics.json` 為準、紀錄由 `outbox` 補寫。要你動手的改動先寫 `topics.json` 的 `todos`，再寫 `todos.json`；看板啟動時從 `todos.json` 重算 `todos`。

帳本事件去重的鍵是 (home, 帳本那一行的原始位元組)，系統紀錄的是 `rid`。啟動時讀完整個檔重建兩個去重集合；最後一行沒有換行字元就截掉。
看板保留每一筆系統紀錄；帳本事件每個議題留最新的 500 筆、沒有議題的另留 500 筆。

### 3.4 `data/myshape/summaries.jsonl`

每行 `{"ts":…,"home":"<home>","task":"<task-id>","kind":"ready|report|failed|landed","text":"…"}`。屬於哪個議題在顯示時才依議題標記與 `merged` 算。去重的鍵是 (home, task, kind, text)。`text` 上限 600 個 Unicode 碼位（採建議 C13），超過就拒收。

### 3.5 `state/myshape/audit.jsonl`

每次狀態轉換一行，用同一個 `write_id` 串起來：

```json
{"ts":"…","write_id":"w-…","state":"sending","attempt":0,
 "sending":{"id":"w-…","channel":"browser|socket|auto","home":"main","task":"…","topic":"…",
            "text":"<全文>","action":{"kind":"message|direct|answer|tag|notice", …},"createdAt":…}}
```

- `state`：`waiting`（等 aggregator 接上，第 7 節）、`sending`（送出中）、`retrying`（重試中，另帶 `attempt`、`next_at`、`error`）、`delivered`（已送達）、`handled_elsewhere`（已由別處處理）、`failed`（失敗，帶 `error`）、`undelivered`（未送達）、`unknown`（結果不明）、`ignored`（使用者按了忽略）、`expired`（排程的通知過了期限、被同一場的「到了」取代，或那一場已經結束，沒有交出去；帶 `error` 寫原因，不能重送）。
- 整筆寫入（全文、對象、`action` 也就是 7.1 的動作紀錄去掉 `v`、`id`、`attempt`）只在第一行的 `sending` 寫一次。排程的通知用時鐘給的固定 id（第 3.9 節），同一個 id 再交一次什麼都不做，所以每個 id 只有一個第一行；過了期限才交的，第一行是 `waiting`，下一行就是 `expired`。看板改版前寫的行在那裡是 `plan`，看板照 7.1 換算。
- 被拒絕的瀏覽器請求另記 `{"ts":…,"rejected":"<原因>","host":…,"origin":…,"path":…}`。`path` 只記路徑、不記查詢字串（有人可能把 token 貼在網址裡），所以紀錄裡不會有 token。

### 3.6 `data/myshape/todos.json`

```json
{
  "v": 1,
  "items": {
    "vpn-login": {
      "title": "登入 VPN", "topic": "solo", "action": "用公司帳號登入 VPN",
      "guidance": "只在公司網路外", "commands": ["sudo openconnect vpn.example.com"],
      "state": "open", "reason": null, "at": "2026-11-20T02:00:00Z",
      "by": "firstmate", "ref": "", "captain_closes": false,
      "created_at": "2026-11-20T02:00:00Z"
    }
  },
  "marks": { "old-id": { "state": "claimed", "at": "2026-11-17T03:00:00Z" } }
}
```

- `items` 是還在看板上的項目，鍵是項目 id（議題 id 的文法，最長 128 字元，由放上看板的一方選）。`title`（一行，最多 200 字）、`action`（一行，最多 1000 字）、`commands`（最多 50 個）一定有，一行的欄位不能有控制字元或改變文字方向的字元；`guidance` 可以是空字串，`commands` 可以是空陣列，每個指令原樣保存。`topic` 是放上看板時的議題 id（合併後顯示時跟到新的 id），只有較早的看板搬上來、原本沒有議題的項目是 `null`。`state` 是 `open`、`claimed`、`rejected`、`obsolete`；`reason` 是 `rejected` 與 `obsolete` 的一行原因。`by` 是放上看板時 aggregator 的名字。`ref` 是 aggregator 自己選的不透明文字，最長 128 字元，看板只在通知裡原樣交回。`captain_closes` 是 `true` 的項目不再需要時要等使用者按「好，撤下」，不會直接撤下。
- 項目關掉就從 `items` 拿掉；它的每一步都在 `events.jsonl` 有紀錄（第 3.3 節）。
- `marks` 是看板第一次以這個格式啟動時，從 `topics.json` 的 `todos` 帶過來、還沒有項目的狀態；`topics.json` 的 `todos` 照樣發布它們，同一個 id 放上看板時拿掉。
- 較早的看板寫的檔另有項目的 `adopted` 與最上層的 `closed`：讀的一方略過，下一次寫這個檔時就沒有了；那樣的項目照一般的項目顯示、關掉。
- `outbox` 是最後一次要你動手的改動寫的系統紀錄，和 `topics.json` 的 `outbox` 一樣（第 3.1、3.3 節）。
- `v` 是 1 的期間，上面列的欄位意思不變；讀的一方略過不認得的欄位。沒有這個檔的看板第一次啟動時，`topics.json` 有狀態就立刻建立它，寫一筆 `todo.marks_carried`；沒有的話第一次改項目時才建立，和看板其他的檔一樣，只是啟動不會在 home 裡多出檔。

### 3.7 `data/myshape/decisions.json`

```json
{"v": 1, "homes": {"main": {"code_commit": "…", "cursor": {"offset": 4096, "sha": "<64 位十六進位>"},
  "open_seen": ["nas-2fa\t2026-11-20T06:10:00Z"], "closed_seen": ["call-1\t<digest>"],
  "seen_at": 1795300000}}}
```

- 每個 home 上一次讀取成功時看到的：回報的 `code_commit`（下一次回報的不同時，開著的 hold 只以 task 比對，第 3.3 節）、`seen_at`（最後一次改了這一筆的那次讀取開始的時間，epoch 秒；這一筆沒變時不動，所以檔不會每讀一次就重寫；較舊的看板寫的沒有）、`closed_cursor` 的 `to_offset` 與 `to_prefix_sha256`（回報沒有時是 `null`）、每個開著的 hold（`<task>\t<hold_set>`）、每個已關的待決事項（`<task>\t<digest>`）。
- 看板寫完一次讀取的紀錄之後才寫這個檔，中途當掉時下一次讀同一段，紀錄的 `key` 讓它只記一次（第 3.3 節）。讀取失敗、回報不合法時不動它。
- 沒有這個檔、讀不懂，就當成每個 home 都還沒看過；一個 home 用帶游標的讀取回 2（不認得這些參數）時，看板忘掉那個 home 的這一筆，下一次不帶游標讀。

### 3.8 `data/myshape/hashtags.json`

```json
{
  "v": 1,
  "hashtags": {
    "AI_INFRA": { "key": "ai_infra", "created_at": "2026-11-26T02:00:00Z", "created_by": "aggregator",
                  "color": "c3", "locked": false }
  },
  "topics": { "quota-routing": ["AI_INFRA", "URGENT"] },
  "views": { "work": { "name": "工作", "any": [], "none": ["AI_INFRA"], "text": "", "untagged": false } },
  "settings": { "aggregator_may_tag": true, "aggregator_may_create": true, "per_topic_max": 8,
                "board_max": 50, "aggregator_hourly_max": 20, "default_view": "all" }
}
```

- 另開一個檔，不放在 `topics.json`：看板讀 `topics.json` 時只照已知的欄位重建議題，退回舊版時下一次存檔會丟掉新欄位；舊版不讀這個檔，也不會去動它。
- `hashtags` 的鍵是 hashtag 第一次建立時的寫法，就是顯示的寫法。名稱是文字（任何文字，含中文與組合記號）、數字與底線，1 到 32 個碼位，開頭的 `#` 不算；沒有保留字。`key` 是名稱先做 NFKC 再轉小寫，用來判斷是不是同一個 hashtag，所以 `AI_INFRA`、`ai_infra`、全形的 `ＡＩ_INFRA` 是同一個，顯示 `AI_INFRA`。讀的一方沒有 NFKC 時比對 `key` 就好。同一個 `key` 出現兩次時留建立得最早的那一個。
  `created_by` 是 `captain` 或 `aggregator`；`color` 是 `c1` 到 `c8`，頁面上是固定色票的 class（第 6.2 節的 CSP 擋 `style` 屬性）；`locked` 的 hashtag 只有使用者能在頁面上貼撕。
- `topics` 是議題 id 到它貼的 hashtag（顯示的寫法，照貼上的順序）。合併掉的議題 id 的 hashtag 算在它併進去的議題上（較舊的看板合併時就是這樣留下的），看板不認得的議題 id 讀的時候就丟掉，所以沒有貼在不存在的議題上的 hashtag；封存的議題留著它的 hashtag，重開時還在。
- `views` 是使用者存下的命名視圖，鍵是視圖 id（議題 id 的文法，`all` 留給「全部」）：`any` 是有其中任何一個（空的是不限），`none` 是一個都沒有，`text` 是關鍵字，`untagged` 是只要沒有任何 hashtag 的議題；四者用「而且」合起來。
- `settings` 是使用者在頁面「hashtag 設定」調的值，沒有或不合法的項目用預設：

  | 設定 | 預設 | 範圍與意思 |
  | --- | --- | --- |
  | `aggregator_may_tag` | `true` | aggregator 可以在議題上貼撕 hashtag |
  | `aggregator_may_create` | `true` | aggregator 可以開新的 hashtag；新開的在頁面上標「新」，直到使用者按「看過了」 |
  | `per_topic_max` | 8 | 1 到 32。一個議題最多幾個，使用者也受它管。合併取聯集可以超過，頁面標出，減到上限以下之前誰都不能再貼新的 |
  | `board_max` | 50 | 1 到 500。aggregator 開新的時整個看板最多幾個；使用者在頁面上仍可開 |
  | `aggregator_hourly_max` | 20 | 0 到 1000。aggregator 一小時內最多改幾次（`hashtag.added`、`hashtag.removed` 的紀錄，從 `events.jsonl` 算），超過的拒絕並說使用者可以在頁面上調高 |
  | `default_view` | `"all"` | 打開看板預設看哪個視圖：`all` 或一個視圖 id |

  單一 hashtag 的鎖預設不鎖（`locked: false`）。
- `outbox` 是最後一次 hashtag 改動寫的系統紀錄，和 `topics.json` 的一樣（第 3.3 節）。
- 誰能做什麼：在一個議題上貼、撕（`hashtag-add`、`hashtag-remove`）兩條通道都能用，socket 上一次只動一個議題；第一次用到的名稱就開新的 hashtag。改名、合併兩個 hashtag、刪掉整個 hashtag（都要兩步確認，第 8 節）、改設定、上鎖解鎖、換顏色、撤回 aggregator 的改動、「看過了」與存、刪視圖只在頁面上（第 6.1 節）。
  拆分議題時新議題複製來源的 hashtag；合併議題時取聯集，第二步確認畫面寫出會多哪些。這兩種是議題操作的後續，不算 aggregator 的 hashtag 改動，不受鎖與每小時上限管。
- 撤回：頁面列出 aggregator 在上一次「看過了」之後的 `hashtag.added`、`hashtag.removed`，每一筆可以撤回一次：它貼上的撕掉、撕掉的貼回去，它新開、現在沒有議題貼著、使用者還沒看過的 hashtag 一起拿掉；它撕掉的 hashtag 已經不在（改名、合併或刪掉了）就拒絕。
- 這些鎖、上限與只在頁面上的操作，是防 aggregator 一時不小心或被誤導的護欄，不是界線：socket 不驗證身分（第 6.1 節），瀏覽器的 token 是同一個帳號的一個檔，同一個帳號下存心的程式擋不住，和確認紀錄（第 7 節）一樣。
- 讀的一方：aggregator 可以直接讀這個檔（設定與鎖也在裡面，才不會白送會被拒絕的要求），但只經 socket 的操作改它。`myshape.sh list --hashtag` 用 jq 讀它，服務沒在跑也能用。
- `v` 是 1 的期間，上面列的欄位意思不變；讀的一方略過不認得的欄位。沒有這個檔時當成沒有任何 hashtag，第一次改 hashtag 時才建立。

### 3.9 `data/myshape/schedules.json`

```json
{
  "v": 1,
  "settings": {"lead_min": 15, "duration_min": 60, "max_open_min": 180, "missed": "notice",
               "late_after_min": 5, "aggregator_may_create": true, "aggregator_needs_enable": false,
               "first_bell_min_ahead": 60, "captain_locks_by_default": true, "max_active": 20,
               "aggregator_changes_per_hour": 10, "aggregator_may_set_rt": true, "default_rt": "none",
               "default_tz": null, "all_paused": false},
  "series": {
    "weekly-sync": {"topic": "weekly-sync", "title": "週會", "rule": "weekly mon 10:00", "tz": "Asia/Taipei",
                    "duration_min": 60, "lead_min": null, "rt": "hard-rt", "rt_locked": false,
                    "state": "on", "locked": true, "by": "captain", "created_at": "2026-11-26T06:00:00Z"}
  },
  "occurrences": {
    "weekly-sync:20261207T0200Z": {"series": "weekly-sync", "at": "2026-12-07T02:00:00Z", "state": "taken",
      "opened_at": "2026-12-07T01:45:03Z", "taken_at": "2026-12-07T02:02:10Z", "note": "10:40 有空位再開",
      "closes_by": "2026-12-07T05:00:00Z"}
  },
  "recent": {"weekly-sync": [{"key": "weekly-sync:20261130T0200Z", "outcome": "done", "by": "aggregator",
                              "note": "會議紀錄已整理", "closed_at": "2026-11-30T03:20:00Z"}]},
  "removed": {}
}
```

- `series` 的鍵是排程 id：議題 id 的文法，最長 64 字元，建立時用議題 id，用過的（`series` 或 `removed` 裡有的）加 `-2`、`-3`。看板之後的通知 id `w-s-<排程 id>-<UTC>-<pre|start|missed>` 與 first mate 收件匣的 request id 靠這個長度與字元。不合文法的鍵讀的時候略過。
- `topic` 是建立時的議題 id；議題被合併時不改寫，讀的一方（看板與 `list`）照 `merged` 走到底。`title` 是建立時的議題名稱。`rule` 是 `daily HH:MM` 或 `weekly <星期> HH:MM`，星期是 `sun,mon,tue,wed,thu,fri,sat` 裡的幾個，照這個順序用逗號連起來。`tz` 是 IANA 時區，建立時沒指定就用 `settings.default_tz`，那是 `null` 時用這台機器的時區。
- `duration_min`（5 到 480）與 `lead_min`（0 到 120，0 表示不送「快到了」）是 `null` 時用設定的值。`rt` 是 `none`、`soft-rt`、`hard-rt`；`rt_locked` 是 `true` 時 aggregator 不能改 rt。`state` 是 `on` 或 `paused`。`locked` 是 `true` 時 aggregator 不能改、暫停、恢復、跳過或刪除它；使用者在頁面上建的照 `captain_locks_by_default` 上鎖，aggregator 建的不上鎖。`by` 是 `captain` 或 `aggregator`；aggregator 建的另有 `seen`，使用者在頁面上看過之前是 `false`（頁面標「新」）；頁面的「看過」同一次改動寫一筆 `schedule.seen`，並把每一筆 aggregator 建的設成 `true`。`aggregator_needs_enable` 打開時，aggregator 建的排程要等 `seen` 是 `true` 才響（之後的時鐘照這個欄位），aggregator 自己也不能恢復它。`checked_through` 是看板的時鐘檢查到哪一刻：時鐘只在開場、到了、結束或錯過時把它存成那一刻，不是每次檢查都存；恢復、全部恢復、使用者按啟用（或關掉「要先按啟用」）、改規則或時間或時區或提前分鐘數，以及撤回，也把它設成那一刻。它只往後走。時鐘找的是 `checked_through`（沒有時是 `created_at`）與 `recent` 裡最晚那一場之後的場次，所以暫停中、改時間之前與時鐘往回跳的時段都不會算成錯過。
- 一場的時刻：一個當地日期最多一場；日光節約調回、同一個當地時間出現兩次時只算第一次，跳過的當地時間往後順延同樣的長度（02:00 跳到 03:00 時，02:30 是 03:30）。時鐘往回跳時，已經處理過（在 `recent` 或開著）的場次不會再出現；改規則時開著的那一場照舊，新規則的下一場在它的 `closes_by` 之後才開。
- `occurrences` 只放開著的場次，鍵是一場的鍵。`state` 是 `upcoming`（快到了）、`due`（到了）或 `taken`（aggregator 接了）；每一場一定帶 `closes_by`，任何讀的一方都把超過 `closes_by` 的當成已結束，不管檔裡還寫著什麼。aggregator 接下時，`closes_by` 改成 T 加 `max_open_min` 與時段長度較長的那個。`notices` 是時鐘交出的通知的固定 id：`pre`（快到了）與 `start`（到了），`w-s-<排程 id>-<T 的 UTC>-<pre|start>`。看板先把 id 存進這裡，再交給寫入引擎；中途當掉時，下一次檢查看到有 id、寫入引擎裡沒有，就用同一個 id 補交。
- `recent` 是每個排程最近十場：結束的（`outcome` 是 `done` 或 `skipped`，`by` 是結束的人，另有 `note`、`closed_at`，開著時的 `notices` 跟著搬過來）、事先跳過的（跳過下一場：`by` 是要跳過的人；aggregator 建立或改時間後 `first_bell_min_ahead` 分鐘內會響的場次：`by` 是 `board`，`note` 寫原因），時鐘照時間結束的（`outcome` 是 `untaken` 或 `timed_out`，`by` 是 `board`），以及時鐘寫的錯過（`outcome` 是 `missed`，`by` 是 `board`，`key` 是最近錯過的那一場，送了錯過通知時 `notice` 是它的固定 id `w-s-<排程 id>-<UTC>-missed`；不只一場時另有 `count` 與 `from`、`to`，是最早與最晚那一場的 UTC 時刻）。`closed_at` 早於那一場的時刻的 `skipped` 就是事先跳過的；改規則時，新規則沒有的那幾筆拿掉。
- `removed` 是刪掉的排程，多 `removed_at` 與 `removed_by`，留 30 天，頁面上可以撤回；下一次寫 `removed` 時拿掉超過 30 天的。
- `settings` 的每一項、範圍與預設在設計的第 5.1 節：`lead_min` 0 到 120、`duration_min` 5 到 480、`max_open_min` 15 到 1440、`missed` 是 `notice`／`due`／`record`、`late_after_min` 1 到 60、`first_bell_min_ahead` 0 到 1440、`max_active` 1 到 100、`aggregator_changes_per_hour` 1 到 100、`default_rt`、`default_tz`（IANA 或 `null`）、四個是非題與 `all_paused`。讀到沒有或超出範圍的值就用預設。任何一筆排程的提前分鐘數加上時段長度與 `max_open_min` 較長的那個，都不能超過它兩場之間最短的間隔（每天是 22 小時，因為一天最多可以少 2 小時；每週照選的星期算），所以同一筆排程不會同時開著兩場；設定與排程改動違反這一條就拒絕。
- `outbox` 是最後一次排程改動寫的系統紀錄，和 `todos.json` 的一樣（第 3.3 節）。
- 讀的一方略過不認得的欄位；不合格的排程、場次與紀錄略過。沒有這個檔時當成沒有排程、設定都是預設，第一次改排程時才建立。

時鐘（`myshape/src/schedule-clock.ts`）：看板服務啟動時檢查一次，之後每 30 秒一次；`myshape.sh schedule tick` 立刻跑同一段檢查一次。它只看時間和存著的資料，不讀任何 home。改動和它的紀錄經 `commitChange` 存（`by` 是 `board`），存好了才把通知交給寫入引擎；存不了就什麼都不交，下一次檢查再來。

- 響不響：排程是 `on`、沒有全部暫停、不是在等使用者按啟用的 aggregator 排程時才響。不響的排程不開新場次、不送通知；開著的那一場照樣到 T 變成「到了」（不送通知，之後也不補送）、到 `closes_by` 結束。
- 開場：T 減提前分鐘數一到就開，`state` 是 `upcoming`、`closes_by` 是 T 加時段長度，送 `schedule.upcoming`。提前分鐘數是 0，或開的時候已經過了 T，就直接是 `due`，只送 `schedule.due`。同一個排程有一場開著時不開下一場。
- 到了：`upcoming` 的那一場在 T 變成 `due`，送 `schedule.due`；還沒交出去的 `schedule.upcoming` 同時作廢。aggregator 在 T 之前就接下（`taken`）的那一場不送 `schedule.due`。
- 結束：到 `closes_by` 結束，沒人接的記 `untaken`，接了的記 `timed_out`，搬進 `recent`。一場不論怎麼結束，它還沒交出去的通知都作廢。
- 看板回來時：每個排程只看最近的那一場。還在時段裡的照常開，通知寫明晚了多久（晚超過 `late_after_min` 才寫，例如「（晚了 7 分鐘）」）；更早整個錯過的只記一筆。時段整個過去了的，照 `missed` 設定：`notice` 記一筆錯過並送一則 `schedule.missed`（每個排程只有最近那一場一則，更早的算進同一筆的 `count`），`record` 只記下來，`due` 把最近那一場重新開成 `due`、從現在算時段長度並送晚了的 `schedule.due`。錯過先記進 `recent`（帶 `notice` 的 id）再交出，所以看板一天重啟幾次都只送一次。
- 時鐘往回跳時，`recent` 裡或開著的場次不會再開，`checked_through` 不往回寫。

## 4. 讀取契約（feed）

看板讀每一個 home 都用同一個程式、同一種形狀（第 7 節）：`<feed> feed <home> <offset> <prefix-sha256> [<closed-offset> <closed-sha256>]`，`<feed>` 是設定檔寫的那支程式。
`<home>` 是 `main`（根 home），或根 home 的回報在 `secondmates[]` 裡列出的 id；home 只是 aggregator 給的名字，看板不分本機或遠端，怎麼到那個 home 是 aggregator 的事。
`<offset>` 與 `<prefix-sha256>` 是看板替那個 home 存在 `data/myshape/offsets.json` 的帳本游標，第一次是 `0 -`。
後兩個是已關的待決事項的游標（C13），存在 `data/myshape/decisions.json`；只有那個 home 上一次的回報帶了 `closed_cursor` 才給，所以還在舊程式上的 home 永遠只收到三個參數。

`summary`、`which`、`find <task>` 與頁面寫入前的對帳只要一個 task 的議題標記，看板先用同一支程式、同一個角色問：`<feed> topics <home> <task>…`。task id 照看板一向的檢查（`[A-Za-z0-9_][A-Za-z0-9._-]*`）。
成功是 exit 0、stdout 一個 JSON 物件 `{"topics": {"<task-id>": "<議題標記的原文>"}}`，意思和回報的 `topics{}` 一樣（C7）；沒有標記檔的 task 不列。
這個呼叫在請求之後才開始，所以讀到的是請求當時的標記。
同一個 home 的讀取（F）還在跑時，這個呼叫等它結束才開始；這個呼叫還在跑時，那個 home 的讀取也等它結束。所有 home 合起來同時最多跑 2 個這種呼叫，多的排隊；排到時請求的補讀期限已經過了，就不跑。
其他任何結果（非 0 的 exit，或 stdout 不是這個形狀）都當成「不支援或失敗」，看板改讀整個 home（上面的 `feed`）；exit 2 之後看板不再對那個 home 問這個呼叫，直到它回報的 `code_commit` 變了。
不認得 `topics` 的 aggregator 照舊能用。

| exit code | 意思 | 看板怎麼做 |
| --- | --- | --- |
| 0 | stdout 是一份回報 | 採用 |
| 4 | 這個 home 現在無法回報，stderr 第一行說明 | 丟掉這個 home 的資料，那一行當成它的橫幅 |
| 其他 | 讀取失敗，stderr 是原因 | 保留上一份回報，直到它過期 |

回報（schema 1）：

```json
{
  "schema": 1,
  "code_commit": "<這個 home 的程式版本>",
  "ledger_enabled": true,
  "tasks": [ { "id": "…", "kind": "…", "state": "working", "source": "…", "detail": "…", "unstarted": false } ],
  "queued": [ { "id": "…", "kind": "…", "title": "…", "hold": "<停住的原因或 null>",
                "captain": false, "blockers": [], "topic_hint": "<議題 id 或 null>" } ],
  "holds": [ { "id": "…", "title": "…", "question": "<問題全文>", "hold_bucket": "live",
               "hold_until": null, "unresolved_blocker_ids": [], "hold_age_days": 0,
               "origin": "<來源 task id 或空字串>", "on_answer": "close|release|null",
               "hold_set": "<UTC ISO 時間、日期或 null>" } ],
  "status_decisions": [ { "id": "…", "key": "…", "summary": "…" } ],
  "topics": { "<task-id>": "<議題標記的原文>" },
  "ledger": { "status": "delta|continuity-broken|absent",
              "to_offset": 0, "to_prefix_sha256": "-", "more": false, "lines": ["<一行事件>"] },
  "ledger_hint": "<選用：帳本沒開時要顯示的一行>",
  "aggregator": { "name": "…", "label": "<頁面怎麼稱呼它>", "update_hint": "<選用：版本橫幅後面的一句>",
                  "decisions_at_once": 1 },
  "secondmates": [ { "id": "…", "read_every_s": 60, "read_timeout_s": 400 } ],
  "closed_holds": [ { "id": "…", "title": "…", "origin": "…", "mode": "answered", "answer": "…", "label": "…",
                     "source": "<經哪裡，直接記下的話是空字串>", "digest": "…", "occurrence": 1,
                     "opened_at": 1795400000, "closed_at": 1795400600 } ],
  "closed_cursor": { "status": "start|delta|continuity-broken|absent", "to_offset": 0,
                     "to_prefix_sha256": "-", "more": false }
}
```

寫 aggregator 的人要知道的，每一條都由 `myshape/test/stage-7-aggregator.sh` 的 `stub-plain` 照著寫（它只讀這一節與第 4 節的 `topics` 呼叫）：

- **C1** `ledger` 一定要有。`status` 是 `delta`、`continuity-broken` 或 `absent`；`to_offset` 是 ≥ 0 的整數，`to_prefix_sha256` 是 `-` 或 64 位十六進位。看板把兩者當成不透明的值，下一次讀取原樣交回；`continuity-broken` 讓看板從 `0 -` 重讀。`absent` 可以一直是，意思是沒有帳本。
- **C2** `holds[].hold_bucket`：`live` 是現在就要答；`aged`、`dated`（帶 `hold_until`）、`blocked`（帶 `unresolved_blocker_ids`）是延後並寫明原因；沒有這個欄位當成 `live`；其他的字讓那個待決事項不顯示。
- **C3** `tasks[].state`：`working`、`parked`、`paused` 是進行中；`blocked`、`failed` 是卡住；`done` 是完成；其他的字是未知，並照原樣顯示。有 `live` 待決事項的 task 是待你決定。
- **C4** `tasks[].kind` 的 `secondmate` 保留給「這個 home 自己的紀錄」，那樣的 task 不算 worker。
  `tasks[].unstarted` 是 `true` 時，那個 worker 顯示成「還沒開始」；省略就是 `false`。
- **C5** 選項按鈕取自問題的最後一行「選項：A | B」，至少兩個不空的選項，用 ` | ` 分開。
- **C6** 帳本的一行是一個 JSON 物件，帶數字 `ts`、字串 `event`、字串 `task`。看板認得 `task.dispatched`、`task.status`（帶 `state`、`text`）、`task.pr_ready`、`task.merged`（帶 `pr`）、`task.cleaned_up`；其他 `event` 用它自己的名字顯示。
- **C7** `topics{}` 是 task 到它的議題標記，每行 `<議題 id> <ISO 時間>`，最後一行有效（第 3.2 節）；還沒有標記的排隊項目用 `queued[].topic_hint` 放到議題底下。
- **C8** 根 home 是 `main`；其他的 home 只從根 home 回報的 `secondmates[]` 來，用 `feed <id> <offset> <sha>` 讀。`summary`、`which` 的 `--home` 一定要是其中之一。
- **C9** 其他 home 的 `code_commit` 和根 home 不同時，看板顯示「版本和主 home 不同」，它的資料照用。
- **C10** 根 home 回報裡的 `aggregator{name, label, update_hint, decisions_at_once}` 與每個 home 的 `ledger_hint` 都可以省略。沒有 `label` 時頁面稱它「aggregator」；`ledger_enabled` 是 `false` 而且有 `ledger_hint` 時，頁面把那一行當成橫幅，沒有就不顯示。
  `decisions_at_once` 是頁面一次顯示幾個 live 的待決事項，要是正整數；省略或不是正整數就是不設上限，每一個 live 的都顯示（設這個欄位之前的樣子）。設了時，跨所有 home 照[第三段](stage-3-data.markdown)的順序，前面這麼多個照常顯示、可以作答，其他 live 的是「決定排隊」：頁面只寫有幾個，不顯示問題、沒有作答鈕，輪到時才顯示；暫緩的（`aged`、`dated`、`blocked`）不算在內。輪到一個排隊中的待決事項時，看板送一則 `decision.front` 通知（第 7.1 節）。哪些事算待決事項、上限設多少，由 aggregator 決定。
- **C11** exit 0 印一份回報；exit 4 是這個 home 無法回報，stderr 一行當它的橫幅；其他 exit 保留上一份回報直到過期。
- **C12** `holds[].hold_set` 是 hold 開始的時間，看板用它當 `hold.opened` 的時間（第 3.3 節）；沒有或只有日期時看板用讀到的時間。
- **C13** `closed_holds[]` 是這個 home 已關的待決事項：backlog 裡還在的每一筆，加上上一次給的游標之後才搬進封存的。每一筆用 (`id`, `digest`) 認；`mode`、`answer`、`label`、`source` 是怎麼關的，`occurrence` 是那個 task 的第幾次 hold，`opened_at`、`closed_at` 是 epoch 秒，不知道時是 `null`。
  `closed_cursor` 是下一次要原樣交回的游標：`start` 是沒給游標時從現在開始、不報封存裡的；`delta` 是游標之後的；`continuity-broken` 是對不上，從現在重新開始；`absent` 是沒有封存可讀。`more` 是 `true` 時還有沒讀完的，看板立刻再讀一次。
  兩個欄位都沒有，就是這個 home 不報已關的待決事項：看板不記它們的關閉，也不給它游標。只有其中一個讀不懂時那一個當成沒有。
- `secondmates[]` 的 `read_every_s` 是多久讀一次，`read_timeout_s` 是一次讀取最多等多久，單位是秒，都可以省略（第 10 節的預設值），範圍是 1 到 3600，超出就用最接近的邊界，不是數字就用預設。

欄位的穩定：`schema` 是 1 的期間，上面列的欄位意思不變；讀的一方略過不認得的欄位；改了意思或拿掉欄位就升成 2。
看板讀到 `schema` 不是 1 的回報，把那個 home 標成版本不相容、不用它的資料。

first mate 這一側怎麼產生這份回報（`fm-topic-board-read.sh` 讀 backlog、snapshot 與 secondmate 登記檔，再加上 `aggregator`、`ledger_hint` 與遠端 home 的讀取間隔），在 [adapter](../../fm-board/spec/adapter.markdown) 第 3 節。

## 5. 燈號

| 燈號 | 條件 |
| --- | --- |
| 待你決定 | 該 task 有 `hold_bucket: live` 的 captain hold。優先於其他四種 |
| 卡住 | crew-state 是 `blocked`、`failed` |
| 進行中 | `working`、`parked`、`paused` |
| 完成 | `done` |
| 未知 | `unknown`、讀不到，或該 home 的彙整結果超過 3 分鐘沒更新 |

燈旁另列 crew-state 的原始狀態與 detail。已清理的 task 不在 snapshot 裡：最後一筆帳本事件是 `task.merged` 或 `task.cleaned_up` 就顯示「完成」，其他顯示「未知」。例外：`kind` 是 `ship` 的 task 被清理、而且從最近一次派出之後沒有 `task.merged`，顯示「未知」，狀態寫 `discarded`、說明寫「已收掉，帳本裡沒有落地紀錄」。上游的 teardown 不分落地或捨棄都記同一筆事件，所以要靠有沒有合併紀錄來分。

## 6. 兩條通道

### 6.1 Unix socket（`myshape.sh` 用）

`state/myshape/board.sock`，0600，不帶 token。一條連線一個要求：client 送一行 JSON `{"v":1,"op":"<名稱>","args":{…}}`，服務回一行 JSON `{"ok":true,"line":"<要印的那一行>",…}` 或 `{"ok":false,"code":"refused|usage|…","line":"<原因與修法>"}`，然後關閉連線。

`op` 的清單：`health`、`status`、`stop`、`create`、`merge`、`close-propose`、`move`、`rename`、`split`、`goal`、`archive`、`reopen`、`summary`、`which`、`find`、`todo-add`、`todo-done`、`todo-failed`、`todo-obsolete`、`hashtag-add`、`hashtag-remove`、`schedule-add`、`schedule-edit`、`schedule-pause`、`schedule-resume`、`schedule-skip`、`schedule-rt`、`schedule-delete`、`schedule-take`、`schedule-close`、`schedule-tick`、`reset-token`。`create` 另收 `hashtags`（名稱的清單）。`schedule-tick` 不在操作表裡：它跑一次排程的時鐘（第 3.9 節），改動記成 `board` 的，不先等讀取，回「ok schedule tick：…」寫這次做了什麼。
改動看板的操作全部列在一張表裡（`myshape/src/ops.ts` 的 `OPERATIONS`）：哪條通道可以用、經哪個檔存（第 3.3 節）。socket 與頁面都只經這張表改看板，每一個改動都至少寫一筆系統紀錄，沒有紀錄的改動編譯不過。
`keep`（頁面的「先不關」）、`todo-claim`（「做完了」）、`todo-drop`（「不做了」）與 `todo-takedown`（「好，撤下」）是使用者自己按的，socket 收到就拒絕，什麼都不改；它們只在頁面的 API 上。hashtag 的 `hashtag-rename`、`hashtag-merge`、`hashtag-delete`、`hashtag-settings`、`hashtag-lock`、`hashtag-color`、`hashtag-revert`、`hashtag-seen`、`view-save`、`view-delete` 也是（第 3.8 節）。
`schedule-settings`、`schedule-lock`、`schedule-pause-all`、`schedule-revert`、`schedule-seen` 也是使用者自己按的，socket 收到就拒絕，什麼都不改；它們和使用者在頁面上的建立、修改、暫停、恢復、跳過、rt、刪除與結束一場，都在頁面的 API 上（`/api/schedules/…`，[第五段](stage-5-browser.markdown)）。`schedule-take` 是 aggregator 的回報，只從 socket 收，頁面沒有它的路由；`schedule-tick` 也沒有。
aggregator 經 socket 改排程時：上了鎖的排程（rt 另有自己的鎖）不能改、暫停、恢復、跳過或刪除，只能刪自己建的；`aggregator_may_create`、`max_active`（啟用中的筆數，恢復也算）、`aggregator_may_set_rt` 與 `aggregator_changes_per_hour`（`events.jsonl` 裡一小時內 aggregator 的 `schedule.created`、`edited`、`paused`、`resumed`、`skipped`、`rt_changed`、`deleted` 紀錄）擋得住就拒絕；建立或改規則、時間、時區、提前分鐘數之後，`first_bell_min_ahead` 分鐘內會響第一則的場次事先跳過，回話寫「最快的一場是 …」。接下與結束一場是回報，上鎖的排程也可以。這些是擋 aggregator 一時不小心或被誤導的護欄，不是界線：socket 不驗證身分，擋不住同一個帳號下存心的程式。頁面上的撤回只撤 aggregator 的改動，而且只在那筆排程還是那次改動留下的樣子時；刪掉的排程只在 `removed` 還留著它時（30 天內）撤得回來；撤回過的再撤一次什麼都不改。每小時上限、撤回與「看過」都由 `myshape/src/oversight.ts` 從系統紀錄算，和 hashtag 用的是同一份。
`todo-*` 的操作不等讀取：aggregator 可能正是在看板讀它的時候送來的。`schedule-*` 和議題的操作一樣，看板還沒讀過根 home 時先等一次讀取，期限和 `summary` 的補讀相同（第 10 節）。
socket 上改議題的操作寫進議題更新的紀錄都註明「<aggregator 的名稱> 用指令」，頁面做的註明「你在頁面上」；`move`、`rename`、`goal` 也寫紀錄，`move` 與 `goal` 另記進來歷（第 3.1 節）。`open` 與 `restart` 由 client 用 `health` 與 `stop` 組出來。另有只給測試用的 `dump`、`test-write`、`test-resend`、`test-ignore`，只在服務的環境變數 `MYSHAPE_TEST=1` 時註冊，平常送這些 `op` 會得到「不認得的 op」。

`health` 回 `{"ok":true,"pid":…,"port":…,"code_commit":…,"boot_id":…,"started_at":…}`。

### 6.2 TCP（瀏覽器用）

只綁 `127.0.0.1:<埠>`。預設埠 47819，可用主 home 的 `config/myshape-port` 改。每個請求都過下面的檢查，任何一項不過就回 4xx 並記入稽核紀錄，不讓服務當掉：

1. `Host` 精確等於 `127.0.0.1:<埠>` 或 `localhost:<埠>`。
2. `/api/` 底下的所有請求（含讀取）都要 `Authorization: Bearer <token>`，用固定時間比較。
3. 改變狀態的請求（非 GET）要求 `Origin` 精確等於 `http://127.0.0.1:<埠>` 或 `http://localhost:<埠>`；缺少或是 `null` 一律拒絕。
4. 改變狀態的請求 `Content-Type` 只收 `application/json`，body 上限 64 KiB，解析失敗回 400。
5. 靜態頁面不需要 token，但仍檢查 `Host`，而且不內嵌任何資料。
6. 每個回應都帶 `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'`、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`。不設任何 CORS header。不回應 `OPTIONS` 預檢（回 405）。
7. 不提供 WebSocket 或 SSE；`Upgrade` 請求回 400。

token 是 32 位元組亂數的十六進位，第一次啟動時產生，之後不變，直到 `reset-token`。`myshape.sh open` 印出 `http://127.0.0.1:<埠>/#t=<token>`；頁面讀到後存進 `sessionStorage`、把 fragment 從網址列拿掉，之後用 header 帶。已經開著的分頁只把 fragment 換成 `#t=<token>` 時（例如 `reset-token` 之後把新網址貼進同一個分頁），頁面重新載入，照第一次載入的方式讀它。

API 的路徑與 body 由第五段定；這裡只定兩件事：

- **輪詢**：`GET /api/state?v=<boot_id>:<版本>`。版本沒變回 `{"changed":false}`；`boot_id` 不同一律回全量。版本是一個字串：一個只在「看得到的東西真的變了」時才加一的計數，加上每個 home 是否過期的旗標，與一段雜湊（含現在開著的排程場次）。輪詢讀到一模一樣的結果不算變；某個 home 跨過過期線算變（那一刻沒有任何讀取會回報它）；一場排程過了 `closes_by` 也算變，就算時鐘還沒存檔（第 3.9 節：超過 `closes_by` 的當成已結束）。
- **兩步確認**：第一個請求回 `{"confirm":"<碼>","expires_at":…}`，碼約 2 分鐘有效、只能用一次、只存在記憶體；第二個請求帶碼才執行。碼綁定當時的對象，對象變了就拒絕。哪些動作要兩步，見第 8 節。

生命週期的操作（`status`、`stop`、`restart`）與 `summary`、`which`、`find` 只在 socket 提供。`reset-token` 也只在 socket 提供。

## 7. 看板執行的程式

看板服務能執行的外部程式只有兩支：home 的 `config/myshape-aggregator.json`（下稱設定檔）指定的 feed 與 deliver。
設定檔只寫程式的路徑，不寫參數：`{"v":1,"name":"<名稱>","feed":"<路徑>","deliver":"<路徑>"}`，`feed`、`topics` 與 `deliver` 這幾個字由看板自己加上（`topics` 跑的是 `feed` 那支程式）。
只能有這四個鍵；`name` 是 1 到 64 個英數字、`.`、`_` 或 `-`，以英數字開頭；路徑是一個字串，不含空白與控制字元。
陣列、帶參數的路徑、多出來的鍵都讓整個設定檔不能用。
設定檔本身要是一般檔、不是符號連結、擁有者是執行看板的帳號、別的帳號不能寫，最多 4096 位元組。
看板只讀設定檔，從不寫它；頁面上也沒有地方能改它。
一律用 `execFile` 傳參數陣列、不經 shell；使用者輸入只進 stdin 的動作紀錄。

| # | argv | stdin | 用在 |
| --- | --- | --- | --- |
| F | `<feed> feed <home> <offset> <sha> [<closed-offset> <closed-sha>]` | — | 讀一個 home（第 4 節） |
| T | `<feed> topics <home> <task>…` | — | 讀一個 home 裡這些 task 的議題標記（第 4 節）；不支援時改用 F |
| D | `<deliver> deliver` | 一行動作紀錄 | 把使用者在頁面上的動作與看板的通知交給 aggregator（7.1） |

參數的檢查：`<home>` 與 `<task>` 符合 `[A-Za-z0-9._-]`、不以 `.` 或 `-` 開頭，`<task>` 至少一個；`<offset>` 是非負整數；`<sha>` 是 64 位十六進位或 `-`；動作紀錄只能是一行。
給 agent 的文字（`message` 不算，`direct` 算）以 `/`、`$`、`!` 或 `-` 開頭就拒收（前面有空白也算），不送出、不改寫，提示「以 /、$、! 或 - 開頭會被當成指令。要跑指令請到終端機，要傳文字請在開頭加字。」任何會把文字打進終端機的接收者都受這一條保護，所以它是看板的規則。

**相對路徑與 code root。**
相對路徑以看板的 code root 為準，絕對路徑照寫。
code root 是看板的指令 `bin/myshape.sh` 算出來的目錄：它自己所在目錄的上一層，或啟動它的環境裡的 `MYSHAPE_ROOT_OVERRIDE`。
看板放在 aggregator 的 checkout 裡時（例如 first mate），code root 就是那個 checkout。
code root 只從這兩處來，不從設定檔，也不從 `data/`、`state/`、`config/` 底下的任何檔來。
看板的 home 是啟動它的環境裡的 `MYSHAPE_HOME`，沒有就是 `MYSHAPE_ROOT_OVERRIDE`，再沒有就是 code root；`MYSHAPE_DATA_OVERRIDE`、`MYSHAPE_CONFIG_OVERRIDE`、`MYSHAPE_STATE_OVERRIDE` 換掉它的 `data/`、`config/`、`state/`；啟動看板的 aggregator 用這些名字把自己的 home 交過來（first mate 的做法在 [adapter](../../fm-board/spec/adapter.markdown) 第 9 節）。
看板的 home、code root 的路徑與程式版本由啟動服務的 `myshape.sh` 當參數傳入；服務自己不執行 `git`、不猜路徑。

**哪些程式不用確認。**
只有一種：設定檔裡寫成 code root 底下 `bin/` 的相對路徑（每一段以英數字或 `_` 開頭，所以沒有 `.` 與 `..`），git 追蹤那個檔，而且它和 HEAD 相同。
`bin/myshape.sh` 每次啟動或換掉服務時用 git 查這一點（`git ls-files --error-unmatch` 與 `git diff --quiet HEAD --`），把查到的路徑與當時設定檔內容的 SHA-256 交給服務；服務自己不跑 git。
first mate 的 `bin/fm-board.sh` 是這一種。
這和今天是同一個門檻：「追蹤、沒改過」不是「審過」，也不表示經過 pull request；本機的一個 commit 就過得了。
服務啟動之後才改的追蹤檔照改過的內容執行，和今天一樣。
設定檔在服務啟動之後改了（內容的 SHA-256 和 `myshape.sh` 查的時候不同），它寫的程式就不再算不用確認；下一個看板指令會換上新的服務並重新查。
`MYSHAPE_ROOT_OVERRIDE` 指向的目錄，實體路徑（`pwd -P`）和 `bin/myshape.sh` 自己所在目錄的上一層相同時，code root 就是那個比對過的路徑，「不用確認」照上面那樣看。
指向別的目錄、進不去或解析不出實體路徑時，沒有程式不用確認：每一支都要在頁面上確認，群組能寫的照樣拒絕。
這只在 `bin/myshape.sh` 決定 code root 的那一處判定一次，之後只用判定的結果；判定只看啟動它的環境與它自己的位置。
它擋得住一個誤設或繼承來的 `MYSHAPE_ROOT_OVERRIDE` 不經確認就把看板指到另一個 checkout，擋不住啟動看板的人把指令本身放在別處：經過另一個目錄裡的符號連結執行 `bin/myshape.sh`，那個目錄就算它自己的位置。
這和今天的門檻相同，不比這個更多。

**其他每一支程式都要在頁面上確認。**
包括 `bin/` 底下沒有追蹤的檔、追蹤但在啟動時和 HEAD 不同的檔、code root 裡其他地方的檔、home 的 `state/` 底下的檔，以及 code root 外面的檔。
確認分兩步，兩步都寫出程式的完整路徑（第 8 節）；第二步另寫出程式內容的 SHA-256。
確認綁的是程式內容的 SHA-256 與設定檔內容的 SHA-256；每次執行之前兩個都重算，任何一個對不上就不執行，頁面再問一次，寫入等著。
確認紀錄只由頁面上的確認動作寫，存在看板自己的資料 `data/myshape/confirmations.json`（第 3 節），經過和每一個改動一樣的 `commitChange`，帶一筆 `program.confirmed` 紀錄；沒有任何 socket 操作或指令能寫它。
這個紀錄是同一個帳號的一個檔：它擋得住一次不小心或被誤導的寫入（改了設定檔，沒有確認就不會跑別的程式），擋不住同一個帳號下存心偽造確認紀錄或去改 `bin/` 裡程式的人，這和今天一樣。

**每一支程式都要過的檔案檢查**，每次執行之前都做：一般檔、可執行、不是符號連結、擁有者是執行看板的帳號、別的帳號不能寫。
群組能寫的：不用確認的程式照常執行，這是今天 `bin/fm-board.sh` 的門檻，而它已經要求追蹤、等於 HEAD；要確認的程式一律拒絕，確認過也一樣，原因寫出檔名與權限，例如「/opt/agg/feed 的群組也能寫（權限 0775）；需要確認的程式不能讓群組寫，確認了也不執行。要用它，只改這一個檔：chmod g-w /opt/agg/feed」。
符號連結、找不到、不能執行、別的帳號能寫的程式也拒絕，不提供確認。

**固定的環境。**
每一支程式拿到的環境只有這五個名稱：`MYSHAPE_HOME`（看板設成自己的 home）、`PATH`、`HOME`、`LANG`、`TMPDIR`（後四個從啟動看板的那個程序的環境複製，那裡有才給；`PATH` 去掉空的項目與不是絕對路徑的項目）。
名稱寫死在看板的程式裡，確認過的與不用確認的程式拿到的一樣。
這張表固定的是名稱，不是值：`PATH`、`HOME`、`LANG`、`TMPDIR` 的值是啟動看板的人給的。
其他的名稱一個都不傳，包括 `SSH_AUTH_SOCK`、`TMUX`、任何 `FM_*`。
要是有程式需要另一個名稱（例如不在預設位置的終端機 socket），做法是在看板程式的那張表加上那一個名稱，不是改回傳整個環境。
不傳 `SSH_AUTH_SOCK` 並不讓一支確認過的程式到不了另一台機器：它拿得到 `HOME`，金鑰檔不需要 agent；真正的界線是頁面上的確認。

**沒有接上 aggregator。**
沒有設定檔、設定檔不能用，或 feed 的程式現在不能執行時，不讀任何 home。
沒有設定檔、設定檔不能用，或 deliver 的程式既不是不用確認的、也沒有對它現在的內容確認過（或沒過檔案檢查）時，每一筆寫入都記成 `waiting`（等 aggregator 接上），attempt 是 0、不重試、不算失敗、不受接續時限限制，留在稽核紀錄裡跨過重啟；送到一半才發現程式不能執行的寫入也回到 `waiting`。
頁面只顯示一行說明，不是警告：「沒有接上 aggregator（原因）。頁面上的動作照常完成；要送出的會等它接上之後依序送出。」
deliver 的程式能執行之後，`waiting` 的寫入照稽核紀錄的順序（最舊的先）交出去，用原來的 id：在服務啟動時、在頁面上確認 deliver 的程式時、每一次讀好根 home 之後（例如設定檔改回服務啟動時的樣子），以及任何新的寫入送出之前，所以新的不會排到舊的前面。
每一次放行都是看板的一個改動，經過 `commitChange`，先存一筆 `writes.released` 紀錄寫明放行的 id，存不了就不放行。
之後照 7.1 的結果處理。
等著發的「議題變成可派」通知與它們的時間存在 `data/myshape/notify-pending.json`，啟動時讀回來，已經到時間而且還可派的立刻發；這種通知的順序是延遲結束、記下來的那一刻，不是拖曳的那一刻。

**怎麼關掉、怎麼退回。** 要看板不執行任何程式，在 `config/myshape-aggregator.json` 放一個別的內容的檔（例如空檔）再跑 `myshape.sh restart`：空的設定檔讀成「是空的，看板不執行任何程式」，什麼都不執行，寫入等著。
只刪掉設定檔留不久：替 home 寫設定檔的 aggregator 會再寫回來（first mate 在下一次 session start 或下一個會碰看板的 `fm-board.sh` 指令寫，[adapter](../../fm-board/spec/adapter.markdown) 第 3 節），它從不改掉路徑上已經有的檔。
要再接上，換回正確的設定檔（first mate 是刪掉那個檔再跑 `fm-board.sh bind`）再 restart，等著的寫入各送一次。
退回這個改動的 commit：看板又只執行寫死的 `<code root>/bin/fm-board.sh`，設定檔與確認紀錄留著、不被讀。

`myshape.sh status` 寫出 code root（「程式目錄」）、設定檔的名稱與兩個路徑、有沒有接上與原因；設定檔和服務啟動時不同時另寫一行。

看板直接讀寫的檔案只有第 3 節表裡它自己的那些，再加唯讀的 `config/myshape-port`、`config/myshape-aggregator.json`，與 `myshape/` 底下自己的程式與靜態檔。

白名單管的是看板服務這個程序。node client 不是服務：它會啟動服務（`spawn` 同一個 `node` 執行 `dist/board-server.js`），並在服務卡死時跑 `ps -o args= -p <pid>` 與送訊號；`myshape.sh` 自己會跑 `git rev-parse`、上面那兩個 git 檢查、`jq`，與讀設定檔的 `node dist/binding-cli.js`。這些都不經服務，也不受瀏覽器的請求觸發。
`myshape.sh` 不 source 任何 first mate 的函式庫。

不在白名單裡、由 agent 或使用者自己跑的：first mate 這一側的 `fm-board.sh setup`、`bind`、`install-rules`、`rules`、帶 task 的 `split` 與 `fm-dispatch-plan.sh order`（[adapter](../../fm-board/spec/adapter.markdown)）。看板不碰 backlog，不執行合併、捨棄、清理。

### 7.1 動作紀錄與結果（C12）

`deliver` 從 stdin 讀一行 JSON：`{"v":1,"id":"w-…","attempt":0,"kind":"…", …}`。`id` 是寫入的 id，重試與重送都用同一個；`attempt` 是第幾次重試。

| `kind` | 其他欄位 | 什麼時候送 |
| --- | --- | --- |
| `message` | `topic {id, name}`、`text` | 使用者在議題頁寫給 agent |
| `direct` | `home`、`task`、`text` | 使用者寫給某一個 home 的某一個 worker |
| `answer` | `home`、`task`、`answer`、`label`、`mode`（`done` 或 `release`）、`question_sha256`、`topic {id, name}` 或 `null` | 使用者回答一個待決事項（第二步） |
| `tag` | `home`、`task`、`topic`、`last_tag_line` | 使用者把一個 agent 歸到議題 |
| `notice` | `event`、`text`，選用的 `topic {id, name}`、`item {id, title, ref}`、`by`、`words`、`occurrence` | 看板上發生了 aggregator 可能要處理的事 |

- `answer` 的 `mode` 照 hold 記下的處理方式（第 8 節），不是使用者選的；`question_sha256` 是問題全文的 SHA-256。
- `tag` 的 `last_tag_line` 是看板送出時看到的那個 task 最後一行議題標記，沒有就是空字串。重試之前看板先重讀那個 home：標記已經是這個議題就算送達，已經被別人改成別的就算別處已處理。
- `notice` 的 `event`：`topic.dispatchable`（議題離開「待辦」或重開，之後 30 秒沒再動）、`topic.merged`、`topic.archived`、`topic.kept`（先不關）、`topic.confirmed`（舊版留下的提議在啟動時確認）、`todo.claimed`（使用者按了做完了）、`todo.closed`（一個要你動手的項目離開看板）、`schedule.upcoming`（一場快到了）、`schedule.due`（一場的時間到了）、`schedule.missed`（看板沒在跑時一場整個過去了）、`schedule.closed`（使用者在頁面上結束或跳過一場已經送過通知的時段）、`decision.front`（看板看到在排隊的一個待決事項輪到了，C10）。`text` 寫的是發生了什麼，例如「議題「帳務」重開，排在「高」最後，現在可派」，不寫要跑什麼。
- 排程的通知：`text` 是固定的句子，填議題現在的名稱與 id、當地時間、這一場的鍵與 rt 的固定詞，不放排程的標題，例如「排程「週會」11-30（一）10:00 開始，還有 15 分鐘（議題 weekly-sync，這一場 weekly-sync:20261130T0200Z）（hard-rt）」、「排程「週會」11-30（一）10:00 時間到了（議題 …，這一場 …）（晚了 7 分鐘）（hard-rt）」、「排程「看信」11-27（五）06:00 錯過了：看板當時沒在跑，這一場沒有通知（議題 …，這一場 …）（soft-rt）」、「排程「週會」11-30（一）10:00 那一場，使用者在看板上結束了，不用準備了（議題 …，這一場 …）」。rt 是 `none` 時不加詞。另帶 `topic {id, name}` 與 `occurrence`：`key`、`at`（UTC）、`local`（例如 `2026-11-30T10:00+08:00`）、`phase`（`pre`、`start`、`missed`、`closed`）、`rt`，時鐘送的另有 `expires_at`，`pre` 與 `start` 另有 `late_min`。first mate 那一側只把 `text` 轉成筆記。
- 時鐘送的三種用固定的 `id` `w-s-<排程 id>-<T 的 UTC>-<pre|start|missed>`，同一個 id 不會交兩次。過期就不交出：`schedule.upcoming` 到 T、`schedule.due` 到那一場的 `closes_by`、`schedule.missed` 到同一個排程下一場的「快到了」（提前分鐘數是 0 時到下一場的 T）；每一次嘗試之前、從等待放行之前、重啟後接續之前與重送之前都檢查，過期的記成 `expired`。
- 輪到一個待決事項的通知：`text` 是固定的句子，填 home/task、議題現在的名稱與 id（沒有議題寫「沒有議題」）與還有幾個在排隊，不放待決事項的標題與問題，例如「看板上輪到 sm1/call-sm 的決定了（議題「帳務重構」，id billing）；還有 2 個決定排隊」，沒有在排隊的就不加分號之後那一段；有議題時另帶 `topic {id, name}`。只有看板這個程序看過它在排隊、現在輪到它時才送，所以待決事項一開就在前面的不送，沒設上限時也不送；看板重啟之前看過的不記得。`id` 是固定的 `w-d-<home、task 與問題全文的 SHA-256 前 16 位>`，同一個待決事項只交一次，重啟之後也一樣。
- 要你動手的通知帶 `item`：項目的 `id`、`title`，與放上看板時給的 `ref`（沒給是空字串）。`todo.closed` 另帶 `by`（`captain` 是使用者在頁面上按的，`aggregator` 是 aggregator 自己的 `todo done` 或 `todo obsolete`）與 `words`（`做完了`、`不做了`、`撤下`）。
- 看板在有動作紀錄之前寫下的寫入（稽核紀錄裡帶 `plan` 而不是 `action` 的那些）不再讀：讀稽核紀錄時略過，不接著送，頁面上也不列，所以不會顯示成沒送完。

`deliver` 在 stdout 印一行結果：

| `outcome` | 看板記成 |
| --- | --- |
| `delivered` | 已送達；`answer` 另記一筆「在看板作答」、`tag` 另記一筆「歸併」的系統紀錄，並重讀那個 home |
| `handled_elsewhere` | 已由別處處理；`answer` 另記一筆 `hold.closed`（待決事項已在別處結束），並重讀那個 home |
| `retry`（帶 `error`） | 重試中，間隔照第 10 節；次數用完是未送達 |
| `failed`（帶 `error`） | 失敗 |

- stdout 最後一行不是上面四種之一、程式跑不起來、逾時被停掉，都算失敗，原因是 stderr。
- 冪等：aggregator 要讓同一個 `id` 重來一次是安全的，`direct` 以外的每一種都要。所以看板重啟時，還沒送完的 `message`、`answer`、`tag`、`notice` 會接著送（30 分鐘內，排程的通知另受它的期限限制），還沒送完的 `direct` 記成結果不明、要使用者確認才重送。
- 從頁面看到的 `id` 與 `attempt`：重試是同一個 `id`、`attempt` 加一；重送是同一個 `id`、`attempt` 從 0 開始。

first mate 這一側的 `deliver` 每一種跑哪個指令、怎麼對應結果，在 [adapter](../../fm-board/spec/adapter.markdown) 第 3 節。

## 8. 哪些動作要兩步確認

| 動作 | 確認碼綁定的對象 |
| --- | --- |
| 作答待決事項（按選項或送出文字） | (home, task id, 問題全文的 SHA-256, 答案, 答了之後的處理方式) |
| 議題併進另一個議題 | (舊 id, 新 id) |
| 重送一筆「結果不明」的寫入 | write id |
| 要你動手的「不做了」「好，撤下」 | (動作, 項目 id) |
| 改名、合併、刪掉整個 hashtag（第 3.8 節） | (動作, 名稱, 另一個名稱, 會動到的議題 id；合併另加併進去的那個 hashtag 的議題 id)，議題清單由服務當下讀出，第一步回給頁面顯示 |
| 使用者在頁面上刪掉一筆排程（第 3.9 節；頁面上撤不回來，撤回只撤 aggregator 的改動） | (動作, 議題 id, 那個議題現在的排程 id)，排程 id 由服務當下讀出；兩步之間排程刪了又建就拒絕 |
| 讓看板執行一支要確認的程式（第 7 節） | (程式的完整路徑, 程式內容的 SHA-256, 設定檔內容的 SHA-256)，兩步都由服務當下讀檔算出，請求只說是 feed 還是 deliver |

作答一律兩步（採建議 C12）：答案送出就會關掉或解除那個 hold，不能收回。
答了之後這一項怎麼處理，由開 hold 的人用 `fm-captain-hold.sh hold --on-answer close|release` 記在 hold 上（第 4 節的 `on_answer`），看板照著送，使用者不選：`close` 送 `done`，被 hold 的項目標成完成；`release` 送 `release`，解除 hold、項目回到排隊中。
沒有記的（較早的 hold、程式還沒更新的 home）送 `release`；原因在 C19。要你動手的項目不是待決事項：「不做了」「好，撤下」是看板自己的操作（第 6.1 節），也是兩步。
第二步的畫面寫明「記成你的答覆並通知 <aggregator 的名稱>」「看板自己不會合併或捨棄」、確認碼的有效時間，以及送出之後這一項會怎樣（沒有記的再註明這是預設），只有一個「送出」鈕與「取消」。
問題全文或處理方式在兩步之間變了（hold 被改寫或已關掉）就拒絕。請求裡帶的 `mode` 不看。

確認程式的第一步寫「要接上 <名稱>，看板得在<讀取與送出>時執行 <完整路徑>。這支程式不是看板程式目錄 bin/ 裡、和 commit 相同的檔，要你確認一次才會執行。」與一個「確認…」鈕；第二步寫「確定讓看板在每次<讀取與送出>時執行 <完整路徑> 嗎？確認的是它現在的內容（SHA-256 <64 位>）與 config/myshape-aggregator.json 現在的內容；之後兩者有一個改了，看板就不執行，再問你一次。」與「確定執行」「取消」。<名稱> 是設定檔的 `name`，<讀取與送出> 依那支程式在設定檔裡的角色是「讀取」「送出」或「讀取與送出」。

封存不用兩步：可以重開。頁面上只做一次畫面內的確認，說明排隊中的項目會被停住、已經在跑的不會停。

## 9. `myshape.sh` 的 exit code 與輸出

| 碼 | 意思 |
| --- | --- |
| 0 | 成功，含原樣重做 |
| 1 | 被拒絕或失敗，確定沒寫入 |
| 2 | 用法錯 |
| 3 | 結果不明：要求已送出，回應前斷線 |
| 69 | 看板服務不可用 |

除了 `open` 與 `--help`，每個子命令在沒有 `state/myshape/token` 的 home（看板從來沒在那裡跑過）都回 1，stderr 是「這裡沒有看板（找不到 state/myshape/token）；要在這裡開看板先跑 myshape.sh open。」，什麼都不寫。
移到 first mate 這一側的舊寫法（`tag`、`--in-home`、`setup`、`install-rules`、`order`）是不認得的子命令，帶 task 的 `split` 是 `split` 的用法錯，都回 2，什麼都不寫（新的指令見 adapter 第 2 節）。
設了看板以前讀的 `FM_HOME` 或 `FM_ROOT_OVERRIDE`、沒設對應的 `MYSHAPE_HOME` 或 `MYSHAPE_ROOT_OVERRIDE`，而且它指的地方和這次用的 home 或 code root 實體路徑（`pwd -P`）不同、或進不去時，除了 `--help` 每個子命令都回 2，什麼都不寫，stderr 是「myshape.sh: 不讀 <舊名字> 了：它指的 <路徑> 和這次用的 <路徑> 不同；要指定請改設 <新名字>（myshape.sh --help 看用法）」；舊名字的值只拿來比對，從不採用。

成功印一行 `ok <id> <做了什麼>`；`summary`、`which`、`find`、`list`、`status`、`open` 各有自己的輸出。錯誤在 stderr 印一行原因與修法。只有 `list` 有 `--json`。

回 69 時 stderr 的那一行固定是「看板服務無法啟動：<原因>。<怎麼修>。這次的要求沒有寫入。」類別見第二段。

## 10. 時間與上限

| 項目 | 值 |
| --- | --- |
| 讀一個 home 的間隔 | 每 10 秒，或那個 home 的 `read_every_s`（1 到 3600 秒）；同一 home 不重疊 |
| 讀一個 home 最多等多久 | 60 秒，或那個 home 的 `read_timeout_s`（1 到 3600 秒） |
| 頁面輪詢 `/api/state` | 每 5 秒，分頁在背景時停 |
| 沒有頁面來輪詢多久後停止輪詢 | 2 分鐘（服務本身不關） |
| 資料多舊算過期 | 3 分鐘 |
| health 逾時 | 3 秒 |
| 啟動後等就緒 | 10 秒 |
| 卡死時 TERM 到 KILL | 5 秒 |
| 確認碼有效 | 約 2 分鐘 |
| 寫入的重試間隔 | 10 秒、30 秒、1 分、5 分、15 分，共 5 次；每次嘗試本身最多 400 秒，所以一筆寫入從第一次到用完，最壞大約 1 小時（排程的通知另有期限，過期就不再試） |
| 排程的時鐘 | 啟動時一次，之後每 30 秒；`myshape.sh schedule tick` 立刻一次 |
| 重啟後接續可去重寫入的時限 | `sending` 寫下後 30 分鐘；`waiting` 的寫入不受限 |
| 議題變成可派後多久發通知 | 30 秒內沒有再被移動 |
| `summary`／`which` 等一次補讀 | 最多 10 秒；同一個請求裡的補讀（`--home` 先讀根 home 再讀那個 home）合起來算 |
| 同時進行的 `topics` 呼叫 | 所有 home 合起來最多 2 個 |
| `myshape.sh` 等一個請求的回應 | 12 秒（補讀的上限再加 2 秒，讓回應在 client 放棄前送到） |
| `service.log` 輪替 | 啟動時超過 1 MiB 就改名成 `service.log.1`，只留一份 |
| 一次讀取的輸出 | 最多 4 MiB |

## 11. 看板依賴的框架介面

看板服務只經第 7 節設定檔寫的兩支程式碰到另一邊。看板與框架之間其餘的接點（上游的呼叫點、測試函式庫、環境變數、自我更新）與兩邊的測試怎麼分工，在 first mate 這一側的 [adapter](../../fm-board/spec/adapter.markdown) 第 9 節。
