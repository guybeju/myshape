# first mate 這一側：看板的轉接指令

看板（`myshape/` 與 `bin/myshape*.sh`）是使用者派工的方式和 agent 之間的轉接層，不綁 first mate。
凡是讀寫 first mate 自己的檔、用 first mate 函式庫的事，都放在這一側；看板的程式不 source 這一側的任何檔。
依賴只有一個方向：這一側可以讀看板的檔、跑看板的指令，看板不讀這一側。

看板的契約在 [contracts](../../myshape/spec/contracts.markdown)；這一頁只寫 first mate 這一側。

## 1. 檔案

| 路徑 | 內容 |
| --- | --- |
| `bin/fm-board.sh` | 轉接指令：看板執行的 `feed` 與 `deliver`（第 3 節），寫看板設定檔的 `bind`（第 3 節），`tag`、`setup`、帶 task 的 `split`、`--in-home`、`install-rules`、`rules` |
| `bin/fm-board-io-lib.sh` | `feed` 與 `deliver` 的程式；只有 `fm-board.sh` source 它 |
| `bin/fm-board-lib.sh` | 找同機 secondmate 的 home、在那個 home 執行指令，彙整腳本讀之前的能力檢查 `tb_capability_gap`（第 3.1 節）；`fm-board.sh` 與 `fm-topic-board-read.sh` source 它 |
| `bin/fm-board-vendor.sh` | 把看板與這一側從 guybeju/myshape 的一個 commit 複製進 fork（`vendor <commit>`），或檢查 fork 裡的副本與 `myshape.lock` 記的 commit 相同（`--check`）；不 source 任何檔，用法寫在檔頭 |
| `bin/fm-queue-source-lib.sh` | second mate 的 home 去哪裡讀主 home 的議題清單、副本能不能用；`fm-dispatch-plan.sh` 與 `fm-board.sh tag`（只在 subshell 裡）source 它 |
| `bin/fm-dispatch-plan.sh` | `order`：照看板的佇列排出該派、該 hold、該解除的 backlog 項目，其餘的列在「先不派」並附原因，在每個 home；`queues-in`、`queues-push`：把佇列副本送到遠端的 second mate（[dispatch-plan](../../dispatch-plan/spec/dispatch-plan.markdown)） |
| `bin/fm-backlog-archive-lib.sh` | tasks-axi 的 Done 保留把完成的項目搬去的封存檔在哪裡、裡面有哪些完成的 id；上游的 `fm-fleet-snapshot.sh` source 它（見下面）。它是 fork 自己的檔，不在這個 repo、不在 `fm-board/vendor-files`，vendor 不會帶來 |
| `fm-board/rules/` | 三個規則範本，副檔名 `.md.tmpl`（fork 不能新增追蹤的 `.md`） |
| `fm-board/vendor-files` | fork 要 vendor 的這一側的檔，一行一個 fork 裡的路徑，來源是 myshape 的 `adapters/firstmate/<那一行>`；看板的檔列在 `myshape/vendor-files` |
| `fm-board/test/` | `run.sh` 與這一側的測試：`feed`（`stage-1-feed.sh`），`deliver`（`stage-2-deliver.sh`），`tag`、`setup`、`bind`、`--in-home`（`stage-1-tag.sh`），帶 task 的 `split`（`stage-3-split.sh`），看板存項目之前的要你動手，與舊版搬上來的項目換到新程式之後（`stage-3-handson-holds.sh`，第 3.3 節），設定檔、session start 與群組能寫的 checkout（`stage-4-binding.sh`），規則（`stage-6-rules.sh`），vendor 腳本（`stage-8-vendor.sh`）；彙整腳本（`stage-1-read.sh`），session start 的檢查（`stage-2-startup.sh`），看板改過的議題接上 `tag`（`stage-2-topics-tag.sh`），看板接上真的 `fm-board.sh` 的第三到五段（`stage-3-data.sh`、`stage-4-writes.sh`、`stage-5-http.sh`、`stage-5-page.sh`），跨 fork 歷史的升級（`stage-7-upgrade.sh`）；建 first mate 的 home 與替身的 `helpers.sh`，它先載入看板的測試套件 `myshape/test/kit/helpers.sh` |
| `dispatch-plan/test/` | `run.sh` 與 `fm-dispatch-plan.sh` 的測試（`stage-1` 到 `stage-4`） |
| `dispatch-plan/spec/` | `fm-dispatch-plan.sh` 的說明 |
| `fm-board/spec/` | 這一頁、[rollout](rollout.markdown)（上線）、[handover](handover.markdown)（這一側的測試與交接之後的分工） |

`bin/` 底下的七支和看板的指令一樣，要通過 `bin/fm-lint.sh <檔>` 與 bash 3.2 的語法檢查。
`fm-board.sh` 與 `fm-dispatch-plan.sh` 要在 git 裡是可執行的：遠端 home 的 `tag`、`setup`、`order` 與 `queues-in` 經 `fm-on.sh` 跑，它只執行追蹤、可執行的 `bin/fm-*.sh`。
上游的 `bin/fm-backlog-handoff.sh` 在 fork 上多一行：把 backlog 項目交給遠端 second mate 之前跑 `fm-dispatch-plan.sh queues-push --to <id>`（[dispatch-plan](../../dispatch-plan/spec/dispatch-plan.markdown) 第 5 節）。
上游的 `bin/fm-fleet-snapshot.sh` 在 fork 上多讀封存檔：source `bin/fm-backlog-archive-lib.sh`，`unresolved_blocker_ids` 把 backlog 裡沒有、但在封存檔裡是完成的 id 算成已解決（dispatch-plan 第 2 節），檔頭說明那一句跟著改；它的測試是上游既有的 `tests/fm-fleet-snapshot-view.test.sh` 多的 `test_archived_done_blockers_resolve`。
彙整腳本讀之前檢查這個修正在不在（第 3.1 節「能力檢查」），不在就不回報。
合併上游時保留這兩處；衝突時先保留上游的改動，再把這幾行加回去。

## 2. 舊的寫法

這些子命令在改名（[open-issues](../../myshape/spec/open-issues.markdown) C57）之前的看板指令 `fm-topic.sh` 裡，下表是它們現在在哪裡。
那個名字留下的提示 `bin/fm-topic.sh` 在每個 home 都搬完之後拿掉了；看板的 `myshape.sh` 也不再替帶 task 的 `split` 指路，它照一般的用法錯回 2，其餘六種在那裡是不認得的子命令。

| 舊的 | 新的 |
| --- | --- |
| `fm-topic.sh tag …` | `fm-board.sh tag <task-id> <議題 id>`、`tag <新 id> --from <舊 id>` |
| `fm-topic.sh --in-home <id> …` | `fm-board.sh --in-home <id> tag\|answers\|setup` |
| `fm-topic.sh setup` | `fm-board.sh setup` |
| `fm-topic.sh split … <task>…` | `fm-board.sh split <議題 id> <新名稱> --goal <一行> <task>…`；不帶 task 的 `split` 還是看板的 |
| `fm-topic.sh install-rules` | `fm-board.sh install-rules` |
| `fm-topic.sh status` 的「規則：」那一行 | `fm-board.sh rules` |
| `fm-topic.sh order` | `fm-dispatch-plan.sh order` |
| 其他的 `fm-topic.sh …` | `myshape.sh`，參數相同 |

## 3. 看板怎麼用到這一側

看板服務執行 home 的 `config/myshape-aggregator.json` 寫的兩支程式（contracts 第 7 節）。
first mate 的設定檔是 `{"v":1,"name":"firstmate","feed":"bin/fm-board.sh","deliver":"bin/fm-board.sh"}`：兩支都是 `bin/fm-board.sh`，看板加上 `feed`、`topics` 或 `deliver`；`topics` 讀主 home 或同機 secondmate 的 `data/<task>/topic`，遠端的 secondmate 回 exit 2，看板改讀整個 home；它們的程式在 `bin/fm-board-io-lib.sh`，檔頭寫明每一種跑什麼。
寫這個設定檔的只有 `fm-board.sh` 裡一個函式：`setup` 與 `bind` 用它；session start（`bin/fm-topic-session-start.sh`）在用看板的主 home 少了它時經 `bind` 寫，然後跑 `myshape.sh open`，把沒有設定檔就啟動的看板換掉；`tag`、`split` 在用看板的 home（不是 secondmate 的 home，而且有 `state/myshape/token`）少了它時先寫好，在 stderr 印一行「看板的 aggregator 設定原本不在，已寫好：firstmate（config/myshape-aggregator.json）」。
session start 只要 `bind` 寫了設定檔，就印一次 `看板服務：已接上 firstmate，換上新的看板`：看板原本在跑時只印這一行，原本沒在跑或沒有回應時接在啟動的那一行後面，啟動失敗時排在 `看板服務：無法啟動：<原因>` 前面。
看板自己跑的 `feed` 與 `deliver`（包括 `deliver` 為歸併跑的 `tag`，看板給它們 `MYSHAPE_HOME`）、`bin/myshape.sh` 與看板服務都不寫。
它只寫上面那一行內容、不收參數，路徑上已經有的檔或連結不管寫什麼都不換掉；secondmate 的 home 不跑看板，不寫。
所以只刪掉設定檔不會讓看板一直不接：下一次 session start 或下一個這些指令會寫回來；要一直不接，在那個路徑放一個別的內容的檔（例如空檔），看板把它當成沒有程式。
`bin/fm-board.sh` 是 git 追蹤、和 HEAD 相同的 `bin/` 底下的檔，所以看板不用在頁面上確認就執行它，群組能寫也一樣；在 checkout 裡改了它、還沒提交，下一次看板啟動時就要確認，而在群組能寫的 checkout 上（例如這台 PC）要確認的程式會被拒絕，看板就接不上，直到改動提交或還原。
看板只給程式五個環境變數：`MYSHAPE_HOME`（它的 home）、`PATH`、`HOME`、`LANG`、`TMPDIR`。
這三個子命令把 `MYSHAPE_HOME` 當成 `FM_HOME`；它們跑的框架指令要的其他設定都從 `HOME` 底下的檔或預設值來：遠端 home 經 `fm-on.sh` 用 `~/.ssh` 的設定與金鑰檔連，不經 `SSH_AUTH_SOCK`，終端機 backend 用預設的 socket。

### 3.1 `feed <home> <offset> <sha> [<closed-offset> <closed-sha>]`

| `<home>` | 跑 |
| --- | --- |
| `main` | `fm-topic-board-read.sh <offset> <sha>` |
| 登記的同機 secondmate | `fm-topic-board-read.sh --in-home <id> <offset> <sha>` |
| 登記的遠端 secondmate | `fm-on.sh <id> fm-topic-board-read.sh <offset> <sha>`；`fm-on.sh` 說那邊沒有這支追蹤的程式時，exit 4，stderr 一行「還沒換到 fork：…再回主 home 跑 /updatefirstmate。它的 agent 不會顯示。」 |
| 其他 | exit 2，什麼都不跑 |

看板給了已關的待決事項的游標（contracts 第 4 節）時，三種都在 `<offset>` 前面加 `--closed-since <closed-offset> <closed-sha>`；沒給時參數和以前一樣，所以舊版的遠端照樣讀得到。
彙整腳本自己的 exit code 原樣交回：0 是回報，4 是下面的能力檢查，其他是讀取失敗；遠端的 exit 4 與它的 stderr 經 `fm-on.sh` 原樣交回。

**能力檢查。** 彙整腳本檢查完參數、讀任何東西之前，先看它要跑的框架指令有沒有這一側要的、上游 `main` 沒有的能力（`bin/fm-board-lib.sh` 的 `tb_capability_gap`）。
它只讀那些腳本的文字，不執行任何框架指令、不寫任何檔，也不讀事件紀錄的內容，所以看板每次讀都可以跑。
看的是彙整腳本自己旁邊的 `bin/`：主 home 與同機的 secondmate 是主 home 的 code root（同機的 secondmate 用主 home 的彙整腳本與 snapshot 讀），遠端的 secondmate 是那台自己的 code root。
缺了一項就不讀，stderr 一行說缺什麼、exit 4；看板把那個 home 標成 `無法回報`，那一行當成它的橫幅（contracts C11，頁面上是 `home <id>：<那一行>`），不採用它的資料。
參數錯照舊是 exit 2，所以看板照舊在那時忘掉已關的待決事項的游標。

| 上游 `main` 沒有的能力 | 檢查 | 缺了時 |
| --- | --- | --- |
| `bin/fm-fleet-snapshot.sh` 的封存 blocker 修正（第 1 節） | 有：它的文字裡有 `fm_backlog_archived_done_ids`（那個修正呼叫 `bin/fm-backlog-archive-lib.sh` 的這個函式）；檔案不在或讀不了不算缺，讀取照舊失敗 | exit 4。Done 的保留搬進封存檔的 blocker 被當成沒完成：`holds[].unresolved_blocker_ids`、`hold_bucket` 的 `blocked`、`queued[].blockers` 會說項目在等已經做完的事，這是錯的資料 |
| `fm-captain-hold.sh hold --on-answer` 寫的 `Captain hold on answer:` 那一行 | 不檢查 | 照常回報：`holds[].on_answer` 是 `null`，contracts 第 4 節允許的值，完整的 fork 上沒帶這個旗標開的 hold 也是 `null`；頁面當成沒有記下，照預設處理 |
| `fm-captain-hold.sh` 寫的 `state/captain-hold-events.jsonl` | 不檢查 | 照常回報：`closed_holds[]` 照樣取自 backlog 與封存檔的 Resolution 紀錄，只有 `opened_at`、`closed_at` 是 `null`（C13 的「不知道」）；看板用讀到的時間，兩次讀取之間開了又關的待決事項不補記開啟 |
| `bin/fm-session-start.sh` 裡的呼叫點（第 9 節） | 不檢查 | 和讀取無關：開 session 時不啟動看板；看板在跑、在讀時，回報不受影響 |

缺封存 blocker 修正時的那一行（`<path>` 是那個 code root 的 `bin/fm-fleet-snapshot.sh` 的絕對路徑）：

```
這個 home 的 first mate 缺少封存 blocker 的修正：<path> 會把已搬進 Done 封存的 blocker 當成沒完成，項目會看起來卡住，所以先不回報。把 fork 的這個修正（bin/fm-fleet-snapshot.sh 呼叫 bin/fm-backlog-archive-lib.sh 的 fm_backlog_archived_done_ids）移植到那個 code root，再更新。
```

fork 補上的方法：把 `carry` 的這個修正移植過去，也就是 `bin/fm-backlog-archive-lib.sh` 整支（fork 自己的檔，不在 `fm-board/vendor-files`，vendor 不會帶來）與 `bin/fm-fleet-snapshot.sh` 裡 source 它、呼叫 `fm_backlog_archived_done_ids` 的那幾行（第 1 節），提交後更新那個 home；下一次讀取就照常回報。
不跟 `carry` 的 fork 照 [port kit](port-to-a-fork.markdown) 第 2.2 節移植這個修正與其他 hook 點。
這個修正以別的寫法進到上游或 fork 時（例如函式改名），檢查找的字要在 guybeju/myshape 的 `tb_capability_gap` 跟著改，否則有修正的 home 也會顯示缺少。

讀到的回報原樣交給看板，另外加上：

- 主 home 的回報加 `aggregator`：`{"name":"firstmate","label":"first mate","update_hint":"請在主 home 跑 /updatefirstmate。"}`。
- `ledger_enabled` 是 `false` 的 home 加 `ledger_hint`，一行「home <id> 的帳本未開，它的 task 不會有更新。在主 home 的終端機跑 <指令>」；指令是 `bin/fm-board.sh setup`（主 home）、`bin/fm-board.sh --in-home <id> setup`（同機）或 `bin/fm-on.sh <id> fm-board.sh setup`（遠端）。
- `secondmates[]` 裡遠端的 secondmate 加 `read_every_s: 60`、`read_timeout_s: 400`，所以遠端的 home 讀得和以前一樣慢；`remote` 與 `home` 兩個欄位照舊留著，給還在直接讀彙整腳本的舊版看板。

彙整腳本 `fm-topic-board-read.sh` 的輸出（contracts 第 4 節的形狀）：

- `tasks[]`、`holds[]` 取自 `fm-fleet-snapshot.sh`：它的參數解析有 `--board-input` 這個 case 標籤時（某一行以 `--board-input)` 或 `--json|--board-input)` 這樣的標籤開頭；只出現在註解或 usage 文字裡不算）用 `--board-input`，沒有時用 `--json`（`fm-board-lib.sh` 的 `tb_snapshot_mode`）；`tasks` 與 `backlog.records[]`。`holds[]` 只收 `hold_kind` 是 captain 的紀錄，原因以 `動手：` 開頭的也收（第 3.3 節）。`origin` 從 hold 內文的 `Captain hold origin:` 那一行取出，取不到就是空字串。`on_answer` 取自 `Captain hold on answer:` 那一行（`fm-captain-hold.sh hold --on-answer` 寫的），沒有那一行或值不是 `close`、`release` 就是 `null`。
- `holds[].hold_set` 取自 snapshot 的 `hold_set`（`Captain hold set:` 那一行）。
- `closed_holds[]` 是每一筆最新的 Resolution 紀錄（`Resolution recorded by fm-captain-hold.`，或已經退役的 `fm-decision-hold` 寫的），來自 snapshot 的每一筆 backlog 項目（放行的還在佇列裡，也算），加上 `--closed-since` 的游標之後 Done 的保留搬進封存檔的。
  封存檔是 backlog 根目錄的 `.tasks.toml` 的 `[markdown] archive`，沒寫就是 backlog 旁的 `done-archive.md`；backend 不是 markdown 時沒有封存（`absent`）。
  `mode`、`digest` 取自 `Resolution mode:`、`Decision digest:`；`Captain decision:` 下第一行是 `Captain answered this call through <來源>.` 時，`source`、`answer`、`label` 取自那一行與 `Answer:`、`Answer as shown to the captain:`，其他的 `source` 是空字串，`answer` 是第一行（最多 300 字）。`occurrence` 是那一筆的 Resolution 紀錄數。
  `opened_at`、`closed_at` 取自 `state/captain-hold-events.jsonl`（第 5 節）裡同一個 task、同一個 `occurrence` 最早的 `held`、`resolved` 那一行；還在舊程式上、沒有這個檔的 home 是 `null`。
  主 home 原因以 `動手：` 開頭的不收（第 3.3 節）。
- `closed_cursor` 是封存檔的游標，和帳本一樣是位元組與前綴雜湊；沒給游標時是 `start`，停在封存檔的尾端；每次最多讀 256 KiB，切在兩筆之間，還有就 `more: true`。這一段讀不到（檔案讀不了、不是一般檔）時兩個欄位都不出現，整個回報照樣交出，不會被當成沒有已關的待決事項。
- `ledger.lines` 從 offset 起、每次最多 256 KiB 的完整行；還有沒讀完的就 `more: true`。offset 超過檔案長度、或前綴雜湊對不上，回 `continuity-broken`。沒有帳本檔回 `absent`。`fm-on.sh` 每個 job 的輸出上限是 1 MiB。
- `secondmates[]` 只在主 home 的輸出裡有，資料取自上游的 `fm-secondmate-registry-lib.sh` 逐行解析 `data/secondmates.md`。
- 腳本自己設 `FM_CREW_STATE_NO_FORGE=1`。

測試：`fm-board/test/stage-1-feed.sh`（每個欄位、和 `myshape/test/contract/report-main.json` 一樣的欄位結構、三種 home、exit 4、`test_a_missing_capability_is_exit_4` 的三種 home 缺封存 blocker 修正、`test_closed_decisions` 的游標與封存）；彙整腳本的能力檢查不執行 snapshot、不寫 home：`stage-1-read.sh` 的 `test_a_snapshot_without_the_archive_fix_is_exit_4`。

### 3.2 `deliver`

從 stdin 讀一行動作紀錄（contracts 7.1），跑下面的指令，在 stdout 印一行結果，印了結果就以 0 結束。

| `kind` | home | 跑 | 結果 |
| --- | --- | --- | --- |
| `message` | — | `fm-inbox.sh note --request-id tb-<id> -`，stdin「［議題：<名稱>（<id>）］」換行後接文字 | exit 0 已送達；3 重試（存了但沒叫醒 first mate，同一個 id 重放會補叫醒）；其他失敗 |
| `notice` | — | 同上，stdin 是 `text` | 同上 |
| `notice`，`event` 是 `todo.closed` | — | 使用者按的照 `notice`；aggregator 自己關的什麼都不跑；不看 `item.ref` | 使用者按的照 `notice`；aggregator 自己關的已送達；`item.id` 格式不對是失敗 |
| `direct` | `main` | `fm-send.sh <task> <文字>` | 0 已送達；輸出有 `is not resolvable` 是失敗「這個 worker 已經結束或找不到，訊息沒有送出。」；其他失敗 |
| `direct` | secondmate | `fm-send.sh <id> --fire-and-forget <id 的 SHA-256 前 16 位> 轉給 <task>：<文字>` | 0 已送達；3 而且是遠端的是重試；其他失敗 |
| `answer` | `main` | `fm-captain-hold.sh answers --source myshape`，stdin `<task>\t<answer>\t<label>\t<mode>` | 見下 |
| `answer` | 同機 | `fm-board.sh --in-home <id> answers` | 見下 |
| `answer` | 遠端 | `fm-on.sh --stdin <id> fm-captain-hold.sh answers --source myshape` | 見下；exit 255 是重試 |
| `tag` | `main`／同機／遠端 | `fm-board.sh tag`／`fm-board.sh --in-home <id> tag`／`fm-on.sh <id> fm-board.sh tag`，參數 `<task> <議題 id>`；遠端的先跑 `fm-dispatch-plan.sh queues-push --to <id>`，不看它的結果 | 0 已送達；遠端 255 重試；其他失敗 |

- 作答逐行讀 stdout：`closed: <task>` 之後接著送通知 `fm-inbox.sh note --request-id tb-<id>-note -`，內容「［議題：<名稱>］已在看板回答 <home>/<task>：<答案>」（沒有議題是「未分類」），結果照 `message`；`skipped: <task> (already closed)`、`(… records a different captain decision …)`、`(not held for the captain)` 是已由別處處理；其他的 `skipped:`、`refused:` 是失敗。同樣的答案重放一次，`answers` 回 `closed:`、什麼都不改，所以作答到一半重來是安全的。
- `home` 不是 `main` 也不是登記的 secondmate、紀錄不是合法的 JSON、`kind` 不認得、欄位不完整：結果都是失敗。
- 給 worker 的文字以 `/`、`$`、`!` 或 `-` 開頭也是失敗；看板本來就擋，這裡再擋一次，因為 `fm-send.sh` 不收 `--` 終止符。

這些通知的內容和改版前一樣（contracts 第 7 節改版前是看板自己跑這些指令）；差別只有「議題變成可派」的通知改成說發生了什麼（「議題「X」離開「待辦」，排在「一般」第 3，現在可派」，規則第 5 行「看板通知議題可派時也重新評估」照樣適用），不再寫「請跑 order 重新評估」，和每一個頁面上的決定各送一則。

測試：`fm-board/test/stage-2-deliver.sh`（每一種紀錄對三種 home 跑的指令、參數、stdin 與 `FM_HOME`，每一種結果，通知的內容逐位元組；裝了 `tasks-axi` 時用真的 `fm-captain-hold.sh` 作答一次）；第三到五段的看板測試經 `tb_make_fake_root` 跑真的 `fm-board.sh`。

### 3.3 看板存項目之前的要你動手

看板自己存項目（contracts 第 3.6 節）之前，first mate 的要你動手是主 home 原因以 `動手：` 開頭的 captain hold。
舊版的這一側把還開著的這種 hold 搬上看板，成為 `ref` 是 `hold` 的項目，項目關掉時也關掉它的 hold；這兩件事都拿掉了。
現在沒有程式開這種 hold：要你動手是 `myshape.sh todo add` 直接放上看板的項目，規則範本也這樣寫。

- 還開著的這種 hold 和其他 captain hold 一樣，在 `holds[]` 與 `queued[]` 裡，看板把它顯示成待決事項。
- 舊版搬上來、還在看板上的項目照舊顯示、照舊關。關掉時 `deliver` 只照第 3.2 節處理，不碰它的 hold，所以那個 hold 還開著、在看板上是一個待決事項，要另外回答或關掉。
- `closed_holds[]` 仍然不收主 home 原因以 `動手：` 開頭的：這種 hold 是舊版跟著項目關掉的，看板已經把那一次關閉記成項目自己的紀錄，再收一次會在更新裡多出一筆重複的「待決事項…已回答」。

### 3.4 `tag` 檢查議題 id

`tag <task> <議題 id>` 寫入之前先確認那個 id 是看板上還開著的議題：合併過的 id 記成它現在指到的議題，封存的與不認得的拒絕（exit 1），stderr 列出能用的議題，什麼都不寫。
主 home 查自己的 `data/topics.json`；`--in-home` 先在主 home 查過再到 second mate 的 home 寫。
second mate 的 home 查 `fm-dispatch-plan.sh order` 排的那一份（`bin/fm-queue-source-lib.sh`）：同機的是主 home 的 `data/topics.json`，現讀；遠端的是主 home 推來的副本，拒絕時多說副本的時間，並說議題如果是之後才建的，等下一份副本再跑一次。
second mate 的 home 讀不到那一份時（沒有檔或副本、讀不懂、副本 60 分鐘以上沒更新、沒有 `jq`）不擋：照給的 id 寫入，stderr 一行說沒有檢查和原因。
`order` 照一小時以上的副本仍然排，`tag` 卻不再拿它擋，因為這段時間裡新建的議題不在副本裡。
`tag <新 id> --from <舊 id>` 取舊 task 現在的議題，在跑的那個 home 照上面同一套檢查：合併過的記成它指到的議題；封存的、不認得的拒絕（exit 1），訊息與直接 `tag` 一樣，再多一行說新 task 沒有標記、改用 `tag <新 id> <議題 id>` 標一個還開著的；讀不到清單時照寫並說沒有檢查。
舊 task 沒有標記（或沒有這個 task）照舊 exit 1。
確切的字在 `fm-board.sh --help`；測試在 `stage-1-tag.sh`。

## 4. `fm-board.sh` 的 exit code

| 碼 | 意思 |
| --- | --- |
| 0 | 成功，含原樣重做 |
| 1 | 被拒絕或失敗，確定沒寫入 |
| 2 | 用法錯 |

例外：`feed` 與 `deliver` 照第 3 節；`--in-home <id> answers` 原樣傳回 `fm-captain-hold.sh` 的 exit code 與輸出；`split` 在看板拒絕或連不上時傳回 `myshape.sh` 的 exit code（3、69 的意思見 contracts 第 9 節）。

## 5. 寫的檔

| 路徑 | 權限 | 誰寫 |
| --- | --- | --- |
| `data/<task-id>/topic` | 0644 | `tag`；每個 home 各自一份，看板經彙整腳本讀 |
| `state/dispatch-plan/` | 0700 | `fm-dispatch-plan.sh`：遠端 second mate 的 `queues.json`（`queues-in`），主 home 的 `pushed/`（`queues-push`） |
| `config/fleet-ledger` | — | `setup`；上游的帳本旗標 |
| `state/captain-hold-events.jsonl` | — | 上游的 `bin/fm-captain-hold.sh`（fork 加的 `record_hold_line`，第 8 節）：每次 hold 一行 `held`、每次作答、放行、對帳、PR 結算一行 `resolved`，`{"v":1,"ts":<epoch>,"task":…,"occurrence":<n>,"event":…}`，只追加；重做時再寫一行，讀的一方取最早的。寫不進去時那支指令照常完成，stderr 多一行 `actionable:` |
| `data/captain.md`、`data/captain-shared.md` 裡的標記區塊 | — | `install-rules` |
| `state/fm-board/rules-backup/` | 0700 | `install-rules` 寫入前的備份 |

`state/myshape/`、`data/myshape/` 與 `config/myshape-port` 由看板自己寫（contracts 第 3 節），這一側不寫。

## 6. 規則範本

- 標記行的開頭是 `<!-- myshape:begin`、結尾是 `<!-- myshape:end -->`：`install-rules` 以這個開頭（容許前面的空白）找區塊，所以裝過的區塊會原地換掉，不會多出第二份。
- 第一行的 `vN` 給人看，內容才決定是不是最新；改了範本就升版本號，`fm-board/test/stage-6-rules.sh` 裡的版本、`FORK-SETUP.markdown` 寫的版本跟著改（fork 自己的安裝說明檢查會檢查後者）。
- 三個範本合計的 token 上限在 `stage-6-rules.sh`（`(位元組 + 2) / 3`）。
- 真的 home 要由使用者明講之後重跑 `bin/fm-board.sh install-rules`；有 second mate 時先確認每個 home 都在同一版（[FORK-SETUP](../../FORK-SETUP.markdown) 第 8 節）。

## 7. 依賴的框架介面

框架改到下面任何一項，就可能在不碰這些檔的情況下弄壞它們。

| 框架的東西 | 誰用 | 靠的是 | 測試 |
| --- | --- | --- | --- |
| `bin/fm-primary-scope-lib.sh` 的 `fm_root_is_secondmate_home <home>` | `fm-board.sh`、`fm-dispatch-plan.sh` | 回傳值分辨 secondmate home | `fm-board/test/stage-1-tag.sh` 的 `test_mate_tag_without_a_source_tags_and_says_why`；`dispatch-plan/test/stage-2-sources.sh` 的 `test_remote_mate_falls_open_without_a_usable_copy` |
| `bin/fm-secondmate-registry-lib.sh` 的 `secondmate_registry_field`、`secondmate_registry_parse_line` | `fm-board-lib.sh`、`fm-board.sh install-rules`、`fm-dispatch-plan.sh queues-push` | `data/secondmates.md` 解析出 id、home、是不是遠端 | `stage-1-tag.sh` 的 `test_in_home_routes_to_a_local_secondmate`；`dispatch-plan/test/stage-4-queues-push.sh` 的 `test_pushes_once_per_mate_whose_copy_differs` |
| `bin/fm-wake-lib.sh` 的 `fm_firstmate_root_home <home>`，與它讀的 `.fm-secondmate-parent`（`fm-secondmate-parent.v1`） | `bin/fm-queue-source-lib.sh`，也就是 `fm-dispatch-plan.sh order` 與 second mate 的 `fm-board.sh tag`，在 subshell 裡載入 | 同機的上層一路往上找到這台機器最上層的 home；遠端的上層停在自己 | `stage-2-sources.sh` 的 `test_local_mate_reads_the_main_homes_queues`、`test_local_child_of_a_remote_mate_reads_its_copy`；`stage-1-tag.sh` 的 `test_local_mate_tag_checks_the_main_homes_file`、`test_local_child_of_a_remote_mate_checks_its_copy` |
| `bin/fm-on.sh --stdin <id> <指令> …` | `fm-dispatch-plan.sh queues-push`（含 `--to`） | 把 stdin 交給遠端的指令；遠端的 stdout 與 exit code 原樣回來，255 表示連不到 | `stage-4-queues-push.sh` 用假的 `fm-on.sh`；真的那一條沒有測 |
| `bin/fm-check-register.sh <id>` 與 watcher 的檢查（`bin/fm-watch.sh`：每 5 分鐘、最多 30 秒、印出的第一行變成通知、丟掉 exit code 與 stderr） | 主 home 的 `state/dispatch-queues.check.sh` | 登記的是位元組，所以檢查只呼叫 `fm-dispatch-plan.sh queues-push --check` | 沒有測：設定在 [FORK-SETUP](../../FORK-SETUP.markdown) 第 8 節第 6 點 |
| `bin/fm-config-inherit-lib.sh` 的 `shared_captain_header_valid <檔>` | `fm-board.sh install-rules` | 共用檔的檔頭上游收不收 | `stage-6-rules.sh` 的 `test_creates_both_files`、`test_refuses_a_shared_file_with_a_bad_header` |
| `bin/fm-startup-memory-budget.sh report` | `fm-board.sh install-rules` | 只印它的輸出；失敗時印一句替代的話 | `stage-6-rules.sh` 的 `test_creates_both_files` |
| `bin/fm-fleet-snapshot.sh --board-input`（它的參數解析有這個 case 標籤時），否則 `--json` | `fm-dispatch-plan.sh order` | 和彙整腳本相同（contracts 第 11.1 節） | `dispatch-plan/test/stage-1-order.sh` 全部 |
| `bin/fm-tasks-axi.sh hold <id> --reason <文字>`、`unhold <id>` | `order` 只印成給 first mate 照著跑的指令 | 指令的形狀 | `stage-1-order.sh` 的 `test_sections` 只檢查印出來的字串 |
| `bin/fm-captain-hold.sh answers --source myshape` | `fm-board.sh --in-home <id> answers` | 在那個 home 執行並原樣傳回 | `stage-1-tag.sh` 的 `test_in_home_answers_passes_through`（替身） |
| `bin/fm-tasks-axi-lib.sh` 的 `fm_tasks_axi_backend <目錄>` | `fm-topic-board-read.sh` | backlog 根目錄的 backend；不是 `markdown` 就沒有封存檔 | 真的：`stage-1-feed.sh` 的 `test_closed_decisions` |

「真的」是測試執行 checkout 裡真的那支指令；「替身」是測試用自己寫的假指令取代它，只檢查送出去的參數與 stdin，並照劇本回應。替身的那幾列，框架改了輸出或 exit code，測試不會失敗，要靠人對照這兩張表。

### 7.1 `feed` 讀的

| 框架的東西 | 誰用 | 這一側靠的是 | 測試 |
| --- | --- | --- | --- |
| `bin/fm-fleet-snapshot.sh --board-input`（它的參數解析有這個 case 標籤時），否則 `--json`，環境變數 `FM_SNAPSHOT_SECONDMATES=1`、`FM_SNAPSHOT_BUDGET=1`、`FM_CREW_STATE_NO_FORGE=1`、`FM_HOME` | `fm-topic-board-read.sh` | exit 0 並在 stdout 印一個 JSON 物件；失敗時非 0。用到的欄位見下一張表。執行之前，它的文字裡要有 `fm_backlog_archived_done_ids`（第 3.1 節「能力檢查」） | 真的：`fm-board/test/stage-1-feed.sh`、`stage-1-read.sh` 全部、`stage-3-data.sh` 全部；沒有修正的替身：`stage-1-feed.sh` 的 `test_a_missing_capability_is_exit_4`、`stage-1-read.sh` 的 `test_a_snapshot_without_the_archive_fix_is_exit_4` |
| `state/fleet-ledger.jsonl` | `fm-topic-board-read.sh` 逐位元組分段讀；服務解析每一行 | 只會從尾端增加的 JSONL。每行是物件，有字串 `event`、字串 `task`、數字 `ts`；另外用到 `kind`、`pr`、`text`、`state`。`event` 認得 `task.dispatched`、`task.status`、`task.pr_ready`、`task.merged`、`task.cleaned_up`，其他的照原樣顯示 | `stage-1-read.sh` 的 `test_ledger_delta_and_continuity`；`stage-3-data.sh` 的 `test_updates_and_topics`、`test_ledger_is_stored_once_and_survives_rewrites`（帳本是測試自己寫的固定內容，不是框架產生的） |
| `config/fleet-ledger` 存在與否 | `fm-topic-board-read.sh` | 檔案存在就是這個 home 的帳本開著（由 first mate 這一側的 `fm-board.sh setup` 建立） | `stage-3-data.sh` 的 `test_home_status` |
| `bin/fm-primary-scope-lib.sh` 的 `fm_root_is_secondmate_home <home>` | `fm-topic-board-read.sh`、`fm-topic-session-start.sh` | 回傳值分辨 secondmate home（標記檔 `.fm-secondmate-home`） | 真的：`stage-1-read.sh` 的 `test_secondmates_and_in_home`；`stage-2-startup.sh` 的 `test_secondmate_home_gets_nothing` |
| `bin/fm-secondmate-registry-lib.sh` 的 `secondmate_registry_parse_line`（設 `SECONDMATE_REGISTRY_ID`、`_HOME`、`_REMOTE`）與 `secondmate_registry_field <登記檔> <id> remote\|home` | `fm-topic-board-read.sh`，經 `fm-board-lib.sh` | `data/secondmates.md` 每個 `- ` 開頭的行解析出 id、home、是不是遠端 | 真的：`stage-1-read.sh` 的 `test_secondmates_and_in_home` |
| `bin/fm-timeout-lib.sh` 的 `fm_run_timed <秒> <指令…>` 與 `fm_timed_out <exit code>` | `fm-topic-session-start.sh` | 指令超過秒數就被停下，回 `fm_timed_out` 認得的 exit code；其他時候回指令自己的 exit code | 真的：`stage-2-startup.sh` 全部（沒有逾時的情況） |
| `data/backlog.md` 的項目行格式 | 經 snapshot 間接讀；看板自己不解析 | 測試的 backlog 是照這個格式手寫的；hold 的原因用 `fm-hold-v1:<base64>` 編碼時由 snapshot 解回原文 | `stage-4-writes.sh` 的 `test_hands_on_items`（編碼過的原因）；`stage-5-page.sh` |

snapshot 的 JSON 裡用到的欄位（少了哪一個，對應的東西就從看板上消失或顯示成未知，不會報錯；`fm-topic-board-read.sh` 讀它們）：

| 路徑 | 用途 |
| --- | --- |
| `generated` | 這次讀取的時間 |
| `tasks[].id`、`.kind`、`.current_state.state`、`.current_state.source`、`.current_state.detail` | agent 的燈號。`state` 是 `working` 且 `detail` 剛好是 `harness busy (fm-spawn)` 時當成「還沒開始」（C32） |
| `tasks[].hints.open_decisions[]` 的 `verb`（只取 `needs-decision`）、`key`、`summary` | worker 提問 |
| `backlog.records[]` 的 `structured`、`state`（`queued`、`done`）、`id`、`title`、`kind` | 排隊中的項目 |
| `backlog.records[]` 的 `hold_kind`（`captain`）、`hold_reason`、`hold_bucket`（`live`、`aged`、`dated`、`blocked`）、`hold_until`、`hold_age_days`、`unresolved_blocker_ids` | 待決事項、排隊項目在等什麼 |
| `backlog.records[].body_lines[]` 裡 `Captain hold origin: <id>` 那一行 | 待決事項沒有自己的議題標記時，跟著來源 task 的議題 |
| `backlog.records[].body_lines[]` 裡 `Captain hold on answer: close\|release` 那一行 | 作答時送 `done` 還是 `release`（第 8 節） |
| `backlog.records[].body_lines[]` 裡 `topic: <議題 id>` 那一行 | 排隊中的項目沒有議題標記時用它（C51）；first mate 轉交項目時寫的 |
| `backlog.records[].hold_set` | `holds[].hold_set` |
| `backlog.records[].body_lines[]` 裡的 Resolution 紀錄（`Resolution recorded by fm-captain-hold.`、`Decision digest:`、`Resolution mode:`、`Captain decision:` 或 `Reconciliation evidence:`，與其後的 `Captain answered this call through …`、`Answer:`、`Answer as shown to the captain:`） | `closed_holds[]`；封存檔裡的同樣格式，項目行是 `- [x] <id> - <標題> (…) (hold: <原因>)`，內文縮兩格 |

### 7.2 `deliver` 跑的

argv 的確切形狀與結果怎麼判在第 3.2 節。

| 框架的指令 | 這一側靠的是 | 測試 |
| --- | --- | --- |
| `bin/fm-inbox.sh note --request-id <id> -` | exit 0 是送到（重放同一個 id 也是 0）；exit 3 是存了但沒叫醒 first mate，用同一個 id 重放會補叫醒；其他是失敗 | 替身：`fm-board/test/stage-2-deliver.sh`；`stage-4-writes.sh` 的 `test_message_to_firstmate`、`test_answer_notice_survives_a_restart`、`test_dispatchable_notice`、`test_decisions_made_on_the_page_reach_firstmate` |
| `bin/fm-send.sh <task-id> <文字>` 與 `<sm> --fire-and-forget <16 位十六進位> <文字>` | exit 0 是送到；exit 3 是自己重試後仍未確認；不接受 `--` 終止符，所以開頭是 `/`、`$`、`!`、`-` 的文字由看板擋下 | 替身：`fm-board/test/stage-2-deliver.sh`；`stage-4-writes.sh` 的 `test_direct_message`、`test_retries_run_out` |
| `bin/fm-on.sh <sm> <指令…>` 與 `--stdin` | 在遠端 home 執行並把 stdout、exit code 傳回；exit 255 是連線層失敗，可以重試 | 替身：`fm-board/test/stage-2-deliver.sh`、`stage-3-data.sh`（遠端 home 是本機的目錄）、`stage-4-writes.sh` 的 `test_answers`、`test_tagging` |
| `bin/fm-captain-hold.sh answers --source myshape`，stdin 一行 `<task-id>\t<answer>\t<label>\t<mode>` | 逐行讀 stdout：`closed: <id>` 是成功；`skipped: <id> (already closed)`、`(… records a different captain decision …)`、`(not held for the captain)` 是別處已處理；其他的 `skipped:`、`refused:` 是失敗。`mode` 是 `done` 或 `release` | 替身：`fm-board/test/stage-2-deliver.sh`；`stage-4-writes.sh` 的 `test_answers`、`stage-5-http.sh` 的 `test_answer_takes_two_steps`。真的：`stage-2-deliver.sh` 的 `test_answer_with_the_real_hold_tool`（`done`）與 `stage-4-writes.sh` 的 `test_hands_on_hold_with_the_real_hold_tool`（`release`），只有裝了 `tasks-axi` 才跑 |

## 8. fork 裡新增的檔案與限制

這一節原本是 [contracts](../../myshape/spec/contracts.markdown) 第 2 節。


看板只新增檔案，不改上游既有的檔案；例外有三處：`bin/fm-session-start.sh` 裡的呼叫點（第 9 節）；[open-issues](../../myshape/spec/open-issues.markdown) C19 的 `bin/fm-captain-hold.sh` `hold --on-answer` 與它在既有的 `tests/fm-captain-hold-lifecycle.test.sh` 裡的測試；以及 C59 的 `bin/fm-captain-hold.sh` `record_hold_line`，每次 hold、作答、放行在 `state/captain-hold-events.jsonl` 寫一行確切的時間（contracts 第 4 節，這一頁第 5 節）。
上游合併進 `carry` 時這些檔可能衝突，衝突時保留這幾行。

| 路徑 | 內容 | 哪一段加入 |
| --- | --- | --- |
| `bin/myshape.sh` | 看板的指令，Bash；只 source `myshape-lib.sh` | 一（之後各段加子命令） |
| `bin/fm-topic-board-read.sh` | 唯讀彙整腳本，Bash | 一 |
| `bin/myshape-lib.sh` | 看板自己的函式（id 檢查、錯誤、議題 id 解析），只被 source，自己不 source 任何檔 | 一 |
| `bin/fm-topic-session-start.sh` | 開 session 時檢查看板服務、沒在跑就啟動，印啟動摘要裡的那一行，Bash | 上線後 |
| `myshape/src/` | TypeScript 原始碼：服務、node client、頁面腳本 | 二起 |
| `myshape/dist/` | `tsc` 的編譯結果，提交進 git；執行期只跑這裡的 `.js` | 二起 |
| `myshape/public/` | 靜態頁面：`index.html`、`board.css`、`icon.svg` | 五 |
| `myshape/spec/` | 這份 spec，副檔名 `.markdown` | 一 |
| `myshape/test/` | 看板自己的測試與 `run.sh`，看板的測試函式庫 `lib.sh`、守門 helper `signal-guard.sh` 與測試套件 `kit/`（看板與 aggregator 的測試都用） | 一起；函式庫、守門 helper 與測試套件是拆 repo 的準備 |
| `myshape/package.json`、`pnpm-lock.yaml`、`tsconfig.json`、`.gitignore` | 只有開發期相依；`.gitignore` 忽略 `node_modules/` 與 `.metrics/` | 二 |
| `FORK-SETUP.markdown`（根目錄） | 新機器從零安裝 fork 與看板的說明；fork 自己的一支檢查腳本檢查它引用的名稱 | 上線後 |

first mate 這一側的檔（`bin/fm-board*.sh`、`bin/fm-dispatch-plan.sh`、規則範本 `fm-board/rules/`、它們的測試與說明）不是看板的，列在這一頁第 1 節；這一側改到的上游檔案（`bin/fm-backlog-handoff.sh`、`bin/fm-fleet-snapshot.sh`）也列在那裡。

硬性限制（都實測過，見 [verification](../../myshape/spec/verification.markdown)）：

- fork 裡不能新增任何追蹤的 `*.md`、`*.mdx`、`*.rst`、`*.txt`，也不能在 `docs/examples/` 加檔。上游的 `bin/fm-doc-audience-check.sh` 要求這些檔全部登記在既有的 `docs/documentation-audiences.json`。所以新目錄裡不放 `README.md`。
- 不能追蹤 `data/`、`state/`、`config/`、`projects/`、`.no-mistakes/` 底下的檔（上游 `.gitignore` 與 CI 的 invariants 都擋）。
- 不在 `tests/` 新增任何檔。上游的 `fm-test-run.sh --check-coverage` 限制沒有時間量測的 serial 測試不超過 15%，目前是 44/297，多一個 `tests/*.test.sh` 就超標；量測表在上游的 `bin/fm-test-run.sh` 裡，不能改（採建議 C6）。
- `bin/myshape.sh`、`bin/myshape-lib.sh` 與 `bin/fm-topic-board-read.sh` 要通過上游釘住版本的 ShellCheck（`bin/fm-lint.sh <檔>`）與 bash 3.2 的語法檢查（`/bin/bash -n`，macOS 內建版本），不直接呼叫 `bd`。
- `fm-on.sh` 只執行遠端 code root 裡 git 追蹤、可執行、非 symlink 的 `bin/fm-*.sh`，所以遠端要用到的 `fm-topic-board-read.sh` 與 `fm-board.sh` 都在 `bin/`、都要 `chmod +x` 後提交。

## 9. 看板與框架之間的其他接點

這一節原本是 [contracts](../../myshape/spec/contracts.markdown) 第 11 節。

看板服務只經 [contracts](../../myshape/spec/contracts.markdown) 第 7 節設定檔寫的兩支程式碰到另一邊；first mate 的設定檔讓兩支都是 `bin/fm-board.sh`，它讀寫框架的哪些東西、測試在哪裡，在這一頁第 3 節與第 7 節。
看板自己的測試（`myshape/test/stage-7-*.sh`）用照 contracts 第 4 節與 7.1 寫的替身 aggregator（`myshape/test/stub-aggregator/`），放在看板的 code root 外面、用它自己的名字，經設定檔接上並在頁面上確認，不跑任何框架的程式；比較升級的那些步驟（`fm-board/test/stage-7-upgrade.sh`，它要 fork 的完整歷史）另把替身放在舊版看板唯一會跑的 `bin/fm-board.sh`。兩邊共用的範例在 `myshape/test/contract/`，由看板維護，first mate 這一側的測試讀它們。
first mate 這一側的第三到五段（`fm-board/test/stage-3-data.sh`、`stage-4-writes.sh`、`stage-5-http.sh`、`stage-5-page.sh`）用 `fm-board/test/helpers.sh` 的 `tb_make_fake_root` 跑真的 `fm-board.sh` 與框架的替身：那個 code root 的 `bin/fm-board.sh` 是提交過的一個小包裝，從 `tb-fake.env` 讀替身要的設定再交給真的 `fm-board.sh`，因為看板不再把自己的環境傳給程式；看的是兩邊接起來之後頁面與通知和以前一樣。

- `bin/fm-session-start.sh`：fleet state 那一段的最後，只在拿到 session 鎖、不是 `--reemit` 時，呼叫 `bin/fm-topic-session-start.sh`，它的輸出原樣印進啟動摘要。這是看板在上游檔案裡唯一的呼叫點；合併上游時要留著這幾行。看板的測試靠真的 `fm-session-start.sh` 與 `fm-lock.sh`：拿得到鎖時跑、鎖被一個活著的 harness 程序拿著時是唯讀。測試：真的，`fm-board/test/stage-2-startup.sh` 全部。
- `tests/lib.sh`：first mate 這一側的測試（`fm-board/test`、`dispatch-plan/test`）source 它，用 `fm_test_tmproot`、`fm_test_run`、`fm_test_cleanup`、`fm_git_init_commit`、`fm_write_meta`、`fm_fakebin`、`pass`、`fail`、`assert_equals`、`assert_contains`、`assert_not_contains`、`assert_grep`、`assert_present`、`assert_absent`、`expect_code` 與變數 `ROOT`。改到這些，這一側的每個測試腳本都受影響。看板自己的測試不用它，改 source 看板的 `myshape/test/lib.sh`，名稱與輸出相同。
- 環境變數：看板的指令只讀它自己的名字（`MYSHAPE_HOME` 與三個目錄、一個 code root 的 `MYSHAPE_*_OVERRIDE`，contracts 第 7 節），以前讀的 `FM_HOME`、`FM_ROOT_OVERRIDE` 指到別處時拒絕（contracts 第 9 節）。
  這一側執行 `bin/myshape.sh` 一律經過 `bin/fm-board-lib.sh` 的 `tb_board_env`：先拿掉環境裡已經有的看板名字，再把 `FM_HOME` 當成 `MYSHAPE_HOME`、有設的 `FM_ROOT_OVERRIDE`、`FM_DATA_OVERRIDE`、`FM_CONFIG_OVERRIDE`、`FM_STATE_OVERRIDE` 照原值換成對應的 `MYSHAPE_*` 交給它；今天的呼叫端是 session start（`bin/fm-topic-session-start.sh`）與 `fm-board.sh split`，之後新增的也一樣。
  看板多讀一個名字時，那個函式要清掉的名字跟著加。
  agent 照規則直接打的 `bin/myshape.sh` 不經這個函式：主 home 就是 clone 時，它自己的位置就是那個 home。
- 自我更新：主 home 的 `config/self-update-source` 指向 `carry`。看板的服務在下一個議題指令發現程式的 commit 變了，就換掉自己；開著的頁面看到 `/api/state` 的 `code_commit` 和它載入時不同，就自己重新載入。
- first mate 這一側的指令（`fm-board.sh`、`fm-dispatch-plan.sh`）依賴的框架介面，包括 `install-rules` 在 `data/captain.md`、`data/captain-shared.md` 裡維護的標記區塊，列在這一頁第 7 節。
