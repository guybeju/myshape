# 第六段：`install-rules` 與規則範本

`install-rules`、`status` 的規則那一行與三個範本後來搬到 first mate 這一側：指令是 `bin/fm-board.sh install-rules` 與 `bin/fm-board.sh rules`，範本在 `fm-board/rules/`，備份在 `state/fm-board/rules-backup/`，測試在 `fm-board/test/`（[adapter](../../fm-board/spec/adapter.markdown)）；下面照當時的樣子保留。
這一頁用的是改名（[open-issues](open-issues.markdown) C57）之前的名字 `topic-board` 與 `fm-topic`；新舊名字的對照在 C57。

做完之後：使用者可以用一個指令把看板的規則裝進偏好檔，`status` 會說規則是不是最新的。這是程式的最後一段；裝規則本身是[上線](../../fm-board/spec/rollout.markdown)的最後一步。

## 先驗再做

| # | 要驗的事 | 怎麼驗 | 假設不成立時 |
| --- | --- | --- | --- |
| 6-1 | 新建的 `data/captain-shared.md` 檔頭通過上游的傳播驗證 | 在暫時的 `FM_HOME` 跑 `install-rules`，然後對那個檔跑上游驗證用的函式（`bin/fm-config-inherit-lib.sh:360-368`，在測試裡 source 它） | 檔頭照上游要求的五個詞修到通過為止；這是這一段的測試，不過就不能合併 |
| 6-2 | first mate 讀了這兩段之後，在對的時機真的會跑 `order`、`summary`、`which`、`tag` | 上線後觀察一週：對照帳本的 `task.pr_ready`、`task.merged` 事件數與 `summaries.jsonl` 的行數；看未分類區有多少沒標記的 agent | 漏得多就調規則的文字（改範本、重跑 `install-rules`）。機制上的安全網已經有：沒標記的進未分類區、沒摘要的仍有帳本事件、已 hold 的項目派不出去 |
| 6-3 | 壓縮之後 Claude Code 確實重印了含偏好檔的啟動摘要 | 在主 home 的 session 手動 `/compact`，看重印的內容有沒有「議題看板」那一段 | 沒有的話，長 session 後段規則會掉。退路是把最關鍵的一條（建立項目時 `tag`）靠未分類區兜住，其餘接受；不另做提醒機制 |
| 6-4 | 上游的 stow 跑過一輪之後，區塊的起訖標記還在 | 裝好規則後跑一次 stow，再跑 `bin/fm-topic.sh status` | 標記不見時 `status` 顯示「未裝」或「和範本不同」，重跑 `install-rules`；只剩一個標記時它會拒絕並指出位置，由使用者手動清掉 |

6-1 已驗（2026-11-16）：測試直接 source 上游的 `fm-config-inherit-lib.sh`，對新建的 `data/captain-shared.md` 跑 `shared_captain_header_valid`，通過；`install-rules` 自己也用同一個函式檢查既有的檔。6-2 到 6-4 要等主 home 的 firstmate 能用。

## 要做的事

### 範本

三個範本放在 `topic-board/rules/`，內容從規劃目錄的 `templates/` 原樣搬過來，只改檔名：

| fork 裡的檔名 | 來源 | 大小 |
| --- | --- | --- |
| `captain.block.md.tmpl` | `templates/captain.block.md` | 約 1061 token |
| `captain-shared.block.md.tmpl` | `templates/captain-shared.block.md` | 約 303 token（v2，加了 `--on-answer` 那一句） |
| `captain-shared.header.md.tmpl` | `templates/captain-shared.header.md` | 約 81 token |

副檔名不能是 `.md`（[contracts](contracts.markdown) 第 2 節的限制）。token 用上游的算法：UTF-8 位元組數除以 3 無條件進位；三者合計約 1445，預設預算是 7500。

內容照搬，這一段不改任何字。之後要改規則，改的是 fork 裡的範本，然後重跑 `install-rules`；標記那一行的 `vN` 跟著加一。

### `install-rules`

只讀寫檔，不經服務，不需要 `node`。歸在「使用者明講才跑」。

1. **只在主 home 跑**。在 secondmate home（`fm_root_is_secondmate_home` 為真），或 home 的路徑解析不出來時，拒絕並說明，什麼都不寫。secondmate home 的共用檔是上游傳播過來的唯讀複本，改了會被當成漂移隔離掉。
2. 處理兩個檔：`data/captain.md`（主 home 段）與 `data/captain-shared.md`（共用段）。每個檔各自：
   - 找 `<!-- topic-board:begin` 開頭的行與 `<!-- topic-board:end -->` 那一行。
   - 兩個都有、而且 begin 在 end 之前、各只出現一次：整段替換（含這兩行）。
   - 兩個都沒有：加在檔尾，前面補一個空行。
   - 其他情況（只找到一個、出現多次、順序顛倒）：拒絕，印出行號，這個檔不動。
   - 標記以外的內容一個位元組都不動。
   - 新內容和現有的區塊相同就不寫檔。
3. `data/captain-shared.md` 不存在：先寫檔頭範本，再寫共用段。已存在但檔頭不合上游的要求：不碰這個檔，印出缺的詞。`data/captain.md` 不存在：直接建立，內容只有那一段。
4. 寫之前把原檔複製到 `state/topic-board/rules-backup/<檔名>.<UTC 時間>`。`state/topic-board/`（0700）不存在就自己建。寫入用暫存檔加 rename。
5. 印出：
   - 每個檔是「新增（vN）」「已更新（<原本的狀態> → vN）」還是「已是最新（vN）」（版本號取自標記那一行的 `vN`，只是給人看的）。
   - 已註冊的 secondmate 清單，並提醒「共用段會叫每個 secondmate 跑 fm-topic.sh；還沒換到 fork 的 home 沒有這支指令」。
   - 什麼時候生效：主 first mate 是下一次 session 開始或下一次壓縮後；secondmate 是主 home 下一次 bootstrap 傳播共用檔之後、它下次啟動時。
   - `bin/fm-startup-memory-budget.sh report` 的輸出。超過預算只警告，不退回。
6. 兩個檔之中有一個被拒絕時，另一個照常處理，最後 exit 1。

### `status` 的規則狀態

`status` 多印一行，由 `fm-topic.sh` 自己讀檔算，不經服務（服務沒跑、沒有 `node` 時也印）：

```
規則：captain.md <狀態>；captain-shared.md <狀態>
```

狀態四種：`未裝`、`和範本相同（vN）`、`和範本不同（vN）`，以及標記不成對時的 `標記不完整`。比的是區塊的內容，不是版本號（採建議 C7）。

## 驗收

1. `<clone>/topic-board/test/run.sh 1 2 3 4 5 6` 回 0。第六段的測試都在暫存的 `FM_HOME`，至少涵蓋：
   - 兩個檔都不存在：建立後 `captain-shared.md` 的檔頭通過 6-1 的驗證。
   - 檔案已有使用者自己的內容：區塊加在檔尾，原內容逐位元組不變（比對備份）。
   - 已有舊版區塊：整段替換，區塊前後的內容不變。
   - 再跑一次：印「已是最新」，檔案的 mtime 不變。
   - 只有 begin、只有 end、兩個 begin：被拒、檔案不變、exit 1。
   - 檔頭不合格的 `captain-shared.md`：不動。
   - 在 secondmate home：被拒，什麼都沒寫。
   - 備份檔存在，`rules-backup/` 是 0700。
   - `status` 的三種規則狀態；手動改掉區塊裡一個字之後顯示「和範本不同」。
   - 三個範本合計的 token 數（位元組數除以 3 進位）小於 1450，防止之後不小心寫胖。
2. `diff` 三個範本與規劃目錄的 `templates/` 原檔，沒有差異。
3. 前五段的驗收再跑一次，特別是 `bin/fm-doc-audience-check.sh` 仍回 `ok`（範本沒有被當成 `.md`）。
