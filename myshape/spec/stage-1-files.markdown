# 第一段：只讀寫檔的指令

這一段的 `tag`、`setup`、`--in-home` 與 `order` 後來搬到 first mate 這一側（`bin/fm-board.sh`、`bin/fm-dispatch-plan.sh`），現在的用法與檔案見 [adapter](../../fm-board/spec/adapter.markdown)；下面照當時的樣子保留。

全是 Bash，不需要看板服務，不需要 `node`。做完之後 first mate 就能標記 task、看派工順序，遠端 home 也已經有它需要的全部程式碼。

## 先驗再做

| # | 要驗的事 | 怎麼驗 | 假設不成立時 |
| --- | --- | --- | --- |
| 1-1 | 主 home 每輪 snapshot 抓遠端摘要的成本。`FM_SNAPSHOT_SECONDMATES=0` 是「取消數量上限」，不是跳過（已讀原始碼確認，`bin/fm-fleet-snapshot.sh:158,260,1773`）；上游沒有關掉跨 home 收集的開關 | 在有遠端 secondmate 的主 home：`time FM_SNAPSHOT_SECONDMATES=1 FM_SNAPSHOT_BUDGET=1 FM_CREW_STATE_NO_FORGE=1 bin/fm-fleet-snapshot.sh --json >/dev/null`，每 10 秒一次、連跑五分鐘。失敗的條件有兩個：遠端的 reply listener 長輪詢被這個 job 搶佔（遠端 job 的紀錄出現 exit 76），或同一段時間內 `bin/fm-on.sh <id> fm-board.sh setup` 的往返時間明顯變長（lane 在排隊） | 彙整腳本先照 `FM_SNAPSHOT_SECONDMATES=1`、`FM_SNAPSHOT_BUDGET=1` 實作（採建議 C1）。兩個失敗條件有任何一個成立，**沒有現成的退路**：拉長輪詢間隔只會降低頻率，解決不了搶佔。那時要回頭開一個決定，見 C1 列的候選 |
| 1-2 | task 多時一次 snapshot 要跑多久（crew-state 每個 task 逾時 10 秒、並行 8） | 在有十個以上 task 的 home：`time bin/fm-topic-board-read.sh 0 -` | 10 秒的本機頻率改成「上一輪結束後 10 秒」；本來就規定同一 home 不重疊 |
| 1-3 | `fm-tasks-axi.sh hold <id> --reason …`（不帶 `--kind captain`）之後，snapshot 的 `hold_kind`、`hold_reason` 長什麼樣；解除的指令確切名稱 | 暫時的 `FM_HOME` 加上裝好的 `tasks-axi`：建一個項目、hold、跑 `fm-fleet-snapshot.sh --json \| jq '.backlog.records[]'`、unhold | `order` 認「自己下的 hold」的依據是 `hold_reason` 以 `看板佇列：` 開頭；欄位名不同就改讀對的欄位，規則不變 |
| 1-4 | `backlog.records[]` 的欄位足以判斷「可派」 | 同上，另建有 blocker、有 `hold_until` 的項目 | 已讀原始碼確認欄位存在（`state`、`hold_kind`、`hold_until`、`unresolved_blocker_ids`、`current_role`，`bin/fm-fleet-snapshot.sh:490-580`）；只差實際的值 |
| 1-5 | hold 內文裡 `Captain hold origin:` 那一行的確切格式 | 用 `fm-captain-hold.sh hold` 開一個帶 origin 的 hold，看 snapshot 的 `hold_reason` | 取不到就當空字串，那個 hold 歸未分類。不影響別的功能 |
| 1-6 | `fm-on.sh` 經遠端 lane 執行彙整腳本的排隊延遲、job 逾時（預設 360 秒）是否夠 | 在有遠端 secondmate 的主 home：`time bin/fm-on.sh <id> fm-topic-board-read.sh 0 -` | 60 秒的遠端頻率拉長；規定不變 |
| 1-7 | 遠端 job 的環境裡 snapshot 讀不讀得到 pane | 同上，看 `tasks[].source` | 讀不到時，遠端只靠 pane 判斷的 task 顯示「未知」。這是已接受的退路 |
| 1-8 | 用主 home 的程式碼加 `FM_HOME=<同機 secondmate home>` 跑 `fm-captain-hold.sh answers`，行為正確，往 parent channel 發的 `resolved` 那一行找得到對的 channel | 有同機 secondmate 時：在它的 home 開一個測試用的 hold，從主 home 跑 `printf '<id>\tx\tx\trelease\n' \| bin/fm-board.sh --in-home <sm> answers` | 改成執行該 home 自己的那份 `bin/fm-captain-hold.sh`（路徑由 registry 查到的 home 組出來），白名單的 argv 不變 |

實作第一段時（2026-11-16）用真的 `fm-fleet-snapshot.sh` 加手寫的 `data/backlog.md` 驗到的：不帶 `hold-kind` 的 hold 在 snapshot 裡是 `hold_kind: null`、`hold_reason` 原樣回傳（1-3 的前半）；`state`、`hold_until`、`unresolved_blocker_ids` 的值足以判斷可派（1-4）；origin 在 `body_lines` 裡，格式是 `Captain hold origin: <task-id>`（1-5）。這三項還沒經過真的 `tasks-axi` 寫入，`unhold` 的確切名稱也還沒驗。測試直接跑真的 snapshot，不用假腳本。

這台已經驗過的（細節在 [verification](verification.markdown)）：空的暫時 `FM_HOME` 沒有 `tasks-axi` 時，`fm-fleet-snapshot.sh --json` 仍回 0（251 毫秒），不寫任何檔；缺 `jq` 才會失敗。

1-1、1-6、1-7、1-8 需要 secondmate，這台沒有。它們不擋這一段的 PR：先照「假設不成立時」那一欄的保守做法實作，等上線時在真機驗。

## 要做的事

### `bin/myshape.sh` 的骨架

- `set -euo pipefail`；`--help` 印用法；不認得的子命令 exit 2。
- 取得 home：照上游的慣例讀 `FM_HOME`，沒設就用腳本所在的 checkout。
- 判斷自己在哪種 home：source 上游的 `bin/fm-primary-scope-lib.sh`，用 `fm_root_is_secondmate_home "$home"`（看 `.fm-secondmate-home` 標記檔；source 沒有副作用）。這一段先做判斷，之後的段會用它拒絕不該在 secondmate home 跑的子命令。
- `--in-home <secondmate-id>` 是放在子命令之前的全域旗標，只接受 `tag`、`answers`、`setup`。它用上游的 `fm-secondmate-registry-lib.sh`（`secondmate_registry_field <reg> <id> remote` 與 `… home`）查出該 home；`remote` 是 1、或查不到，就 exit 1。查到後以 `FM_HOME=<該 home>` 執行對應的動作。這條路徑永遠不碰 socket。

### `tag`

- `tag <task-id> <議題 id>`：在這個 home 的 `data/<task-id>/topic` 追加一行。目錄不存在就建。
- `tag <新 id> --from <舊 id>`：讀舊 id 標記的最後一行，照下面同一套檢查之後寫給新 id。舊 id 沒有標記就 exit 1；那個議題被拒時新 id 不寫，並多一行說新 id 還沒有標記。
- 檢查：
  - 兩個 id 的格式（[contracts](contracts.markdown) 第 3.1 節）。
  - 在主 home：議題 id 先過 `merged` 表，結果必須在 `topics.json` 的 `topics` 裡（也就是不在封存檔）；否則 exit 1，並列出可用的議題。
  - 在 secondmate home：照 `fm-dispatch-plan.sh order` 讀的那一份主 home 議題清單檢查，同上；讀不到那一份時照寫，stderr 一行說沒有檢查與原因（[fm-board adapter](../../fm-board/spec/adapter.markdown) 第 3.4 節）。
  - 沒有 `jq`：跳過「議題在不在」的檢查，照寫，並在 stderr 印警告。
- 最後一行已經是同一個議題 id 就不再追加，回 0。
- 印 `ok <task-id> 已標記為 <議題 id>`。

### `list`

`list [--all] [--json] [--hashtag <名稱>]`：讀 `data/topics.json`（`--all` 加讀封存檔），每行印 id、狀態、佇列、位置、名稱。`--hashtag` 只列貼著那個 hashtag 的議題，用 jq 讀 `data/myshape/hashtags.json`（[contracts](contracts.markdown) 第 3.8 節），比對的方式和 `fm-dispatch-plan.sh order --hashtag` 相同；沒有一個議題貼著時印「沒有議題貼著 #<名稱>。」並回 0。唯讀，不經服務。沒有議題檔時印「還沒有議題」並回 0。在 secondmate home 印「議題檔只在主 home」，exit 1。沒有 `jq` 時印原因與安裝方式（文字比照上游 `bin/fm-bootstrap.sh:872`），exit 1。

### `order`

唯讀，不改 backlog，不經服務。讀三樣：議題檔與封存檔、這個 home 的 `data/*/topic`、`fm-fleet-snapshot.sh --json` 的 `backlog.records[]`（設 `FM_CREW_STATE_NO_FORGE=1`，`FM_SNAPSHOT_SECONDMATES` 同彙整腳本）。只看 `state` 是 `queued` 的紀錄。輸出五段，每行 `<task-id> <議題名稱> <佇列>`：

- **可派**：「高」佇列的議題、「一般」佇列的議題、沒有標記的項目，依序。同一佇列照陣列順序，同一議題內照 backlog 的順序。被別的 hold 擋住、有未解的 blocker、`hold_until` 還沒到的，不列。
- **該 hold**：議題在「待辦」或已封存、還沒被 hold 的項目。每行後面附要跑的指令：`bin/fm-tasks-axi.sh hold <id> --reason "看板佇列：議題 <議題 id> 在待辦"`。
- **該解除**：`hold_reason` 以 `看板佇列：` 開頭、但議題已經不在待辦也沒封存的項目。每行附 `bin/fm-tasks-axi.sh unhold <id>`（確切名稱依 1-3）。
- **停著**：已經照上面 hold 住、議題仍在待辦或封存的項目。
- **先不派**：不在上面四段的其他排隊項目，照 backlog 的順序，每行附原因（[dispatch-plan](../../dispatch-plan/spec/dispatch-plan.markdown) 第 2 節）。

壞掉時放行，一律 exit 0：

- 議題檔不存在或讀不懂，或在 secondmate home：印一行說明，把排隊中、沒被 hold 的項目照 backlog 順序全列為可派，不列「該 hold」。
- snapshot 失敗或逾時（上限 30 秒）：印「讀不到 backlog，照平常的方式派工」。
- 沒有 `jq`：印原因與安裝方式，exit 1（唯一的例外）。

標記的議題不在任何佇列（例如舊版留下、看板還沒啟動來確認的提議）的項目，和沒標記的一樣排在一般之後。

另外三件（2026-11-16 用真的 `tasks-axi` 0.2.6 試過之後定的）：

- 「該解除」的項目同時列在「可派」，那一行後面標明「還被看板的 hold 擋著，先照『該解除』解除」。這樣一次就看得到它解除之後排在哪裡。
- 被別的東西擋住的項目（captain hold、別的 hold、未解的 blocker）不列在任何一段：那些由上游自己的閘門決定。
- 沒有可用的議題檔時，之前由看板 hold 住的項目仍列在「停著」，免得殘留的 hold 被忘掉。

### `setup`

在自己的 home 建立 `config/fleet-ledger`（空檔），已存在就不動。印 `ok setup 帳本已開` 或 `ok setup 帳本本來就開著`。不需要 `jq`。不寫偏好檔。同機的 secondmate home 由主 home 跑 `bin/fm-board.sh --in-home <id> setup`（採建議 C15）；遠端跑 `bin/fm-on.sh <id> fm-board.sh setup`。

### `--in-home <id> answers`

讀 stdin 的一行，執行 `FM_HOME=<該 home> bin/fm-captain-hold.sh answers --source myshape`，stdout、stderr、exit code 原樣傳回。

### `bin/fm-topic-board-read.sh`

輸出格式在 [contracts](contracts.markdown) 第 4 節。要點：

- `--in-home <id>` 的查法與 `myshape.sh` 相同。
- 內部只呼叫一次 `fm-fleet-snapshot.sh --json`，不自己解析 status log 或 state 檔。唯一的例外是從 hold 內文取 `origin`。
- 帳本：讀 `state/fleet-ledger.jsonl`。先驗證 `[0, offset)` 的 SHA-256 等於傳入的前綴雜湊（offset 是 0、雜湊是 `-` 時跳過），不符或檔案比 offset 短就回 `continuity-broken`。只回完整的行，最多 256 KiB。
- `code_commit`：`git -C <code root> rev-parse HEAD`。
- `secondmates[]`：只在主 home 輸出。
- snapshot 失敗時整支腳本 exit 1，stderr 帶原因；不輸出半個 JSON。
- 需要 `jq`；沒有就 exit 1 並印安裝方式。

### spec 與測試的骨架

- 把這份 spec 放進 `myshape/spec/`。
- 建 `myshape/test/run.sh [段號…]`：依序跑 `myshape/test/stage-<n>-*.sh`，全過才回 0。測試 source 上游的 `tests/lib.sh`（只讀，取用 `pass`、`fail`、`assert_*`、`fm_test_tmproot`），每個測試在自己的暫存 `FM_HOME` 裡跑。
- 從 `tests/` 以外 source `tests/lib.sh` 已實測可行（見 [verification](verification.markdown)）。
- 第一段的測試全部用 fixture：手寫的 `data/topics.json`、`data/backlog.md`、`state/fleet-ledger.jsonl`、`data/secondmates.md`，以及用假的 `bin/` 包裝（上游 `tests/lib.sh` 的 `fm_fakebin`）取代 `fm-fleet-snapshot.sh` 的輸出。這台沒有 `tasks-axi`，測試不能依賴它。

## 驗收

在開發用的 clone 外面開 session，對 clone 跑（`<clone>` 是它的路徑）：

1. `<clone>/myshape/test/run.sh 1` 回 0。至少涵蓋：
   - `tag`：新增、重複不追加、`--from`、格式錯、未確認的議題被拒、`merged` 的舊 id 轉到新 id、沒有 `jq` 時照寫並警告、在 secondmate home 照主 home 的議題清單檢查、`--from` 一樣檢查。
   - `order`：四段各至少一例；議題檔壞掉時放行；snapshot 失敗時放行；議題不在任何佇列的項目排在一般之後。
   - `list`：`--all`、`--json`、在 secondmate home 被拒。
   - `setup`：重複執行結果相同。
   - `--in-home`：id 不存在、id 是遠端的，都被拒；`answers` 的輸出與 exit code 原樣傳回（用假的 `fm-captain-hold.sh`）。
   - 彙整腳本：`0 -` 的全量、接續的 delta、帳本被截斷後的 `continuity-broken`、沒有帳本的 `absent`、超過 256 KiB 時 `more: true`、輸出通過 `jq -e .schema`。
2. `<clone>/bin/fm-lint.sh bin/myshape.sh bin/fm-topic-board-read.sh` 沒有任何訊息。
3. `/bin/bash -n` 兩支腳本都過；`shfmt -d` 沒有差異（縮排照上游既有的腳本）。實作時這兩項沒有做到位：這台的 `/bin/bash` 是 5.3、沒有 docker 權限可以跑 3.2，也沒有裝 `shfmt`。bash 3.2 相容只靠人工避開新語法（沒有關聯陣列、`mapfile`、`${var,,}`），要在 macOS 上補跑一次。
4. `<clone>/bin/fm-doc-audience-check.sh` 回 `ok`；`<clone>/bin/fm-test-run.sh --check-coverage` 回 0。這兩條證明沒有碰到上游的清單。
5. `git -C <clone> diff --stat carry...HEAD` 只有新增的檔（`--diff-filter=A` 之外是空的）。
6. 在暫時的 `FM_HOME` 手動跑一次 `tag`、`list`、`order`、`setup`，輸出貼進 PR。
