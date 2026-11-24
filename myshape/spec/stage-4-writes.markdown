# 第四段：寫入

做完之後：服務能替使用者送訊息給主 first mate、直送 agent、作答待決事項、歸併 agent；每筆寫入有稽核紀錄、七種狀態、重試與重啟後接續。頁面還沒有，寫入先經 socket 上只給測試用的 `op`（`test-write`、`test-resend`、`test-ignore`）觸發；第五段的 HTTP API 呼叫的是同一套函式。這三個 `op` 只在環境變數 `MYSHAPE_TEST=1` 時註冊。

> 這一段的指令編號（R1 到 R3、W1 到 W9）與它們的結果怎麼判，是看板直接執行 first mate 的指令時的設計。
> 現在看板只執行 `bin/fm-board.sh feed` 與 `deliver`（[contracts](contracts.markdown) 第 4、7 節），原本的指令與結果對應搬到 first mate 這一側（[adapter](../../fm-board/spec/adapter.markdown) 第 3 節）；這一段其餘的行為不變。
> 「議題變成可派」的通知現在寫的是發生了什麼（contracts 7.1），每個議題、每個頁面上的決定各一則。

## 先驗再做

| # | 要驗的事 | 怎麼驗 | 假設不成立時 |
| --- | --- | --- | --- |
| 4-1 | `secondmates[]` 裡的 id 能直接當 `fm-send.sh` 的 target | 已讀原始碼確認：target 接受 `<id>` 或 `fm-<id>`，靠主 home 的 `state/<id>.meta` 解析（`bin/fm-backend.sh:973-990`），`--fire-and-forget` 要求它是有紀錄的 secondmate（`bin/fm-send.sh:700-703`）。上線時再實跑一次 `bin/fm-send.sh <id> --fire-and-forget <16 位> 測試` | 主 home 沒有該 secondmate 的 meta 時 `fm-send.sh` 回非 0，那筆寫入記「失敗」並附 stderr。不需要別的退路 |
| 4-2 | secondmate 收到「轉給 <worker-id>：…」會照字面轉給該 worker，轉不出去時會回報 | 裝好規則之後（第六段），從看板直送一則給 secondmate 底下的 worker，到那個 worker 的終端機確認 | 這條靠模型照規則做。不照做時訊息停在 secondmate 的收件匣；看板仍顯示「已送達」（已知限制，見下）。直送按鈕上寫明「經 <secondmate> 轉達」讓使用者知道多了一層 |
| 4-3 | `fm-on.sh --stdin <id> fm-captain-hold.sh answers --source myshape` 能寫進遠端的 hold | 在遠端 home 開一個測試用的 hold，從主 home 送一行答案，看輸出有沒有 `closed: <id>` | 寫不進去就只剩一條路：把答案用 W1 的 note 告訴主 first mate，由它處理。這會改寫作答的流程，要回頭開一張決定 |
| 4-4 | `done` 與 `release` 兩種作答之後，被 hold 的項目各變成什麼狀態；特別是純決定的項目被 `release` 之後會不會被 `order` 列為「可派」 | 在暫時的 `FM_HOME`（要有 `tasks-axi`）開兩個 hold 各試一種，之後跑 `bin/myshape.sh order` | 會被列為可派的話，第二步確認的說明文字要寫明這個項目會回到排隊中。送哪一種照 hold 記下的處理方式（C19） |

4-2、4-3 需要 secondmate；4-4 需要 `tasks-axi`。都不擋這一段的 PR。

## 要做的事

### 寫入的種類

| 種類 | 觸發 | 執行（白名單編號） | 去重的 key | 分類 |
| --- | --- | --- | --- | --- |
| 給主 first mate 的訊息 | 議題頁的輸入框 | W1，本文開頭加一行「［議題：<名稱>（<id>）］」 | request-id | 可去重 |
| 直送主 home 的 worker | agent 列的直送 | W2 | 沒有 | 不可去重，但同步：回 0 就是寫入了 |
| 直送 secondmate 底下的 worker | 同上 | W3，文字是「轉給 <worker-id>：<原文>」 | delivery id（16 位小寫十六進位） | 看 `secondmates[]` 的 `remote`：遠端的可去重；同機的不可去重但同步（採建議 C9） |
| 作答待決事項 | hold 卡片 | 先 W4、W5 或 W6；「已送達」之後再 W1 通知主 first mate | 答案那一行；通知的 request-id 由 write id 推導 | W4、W6 可去重；W5 同步，重放也冪等 |
| 歸併 agent | 未分類區的「歸併到…」 | W7、W8 或 W9 | 議題 id，重試前先對帳 | W7、W8 同步；W9 可去重 |
| 議題變成可派的通知 | 自動 | W1：「議題「<名稱>」已可派工，請跑 order 重新評估」 | request-id | 可去重 |
| 使用者在頁面上做的決定（確認、合併、封存、先不關） | 自動 | W1：「使用者在看板上：<系統紀錄的那一句>（id：<議題 id>）」 | request-id | 可去重 |

共同的規則：

- 執行前先產生 write id 與去重用的 key，寫一行 `sending` 進 `audit.jsonl`，然後才執行。
- 呼叫端立刻拿到 write id 與「送出中」；結果靠看板狀態拿。
- 同一個 home 的指令一次只執行一個，不同 home 之間可以並行。互斥的只有「執行指令」那一段：一筆寫入在等下一次重試時不佔位置，後面的寫入照常送。（原本整筆寫入排隊；實作時的測試發現一筆卡在重試的 note 會把同一個 home 後面的寫入擋住最久 15 分鐘。）
- 作答的答案一行：`<task-id>\t<answer>\t<label>\t<mode>`。`<label>` 是按下的選項文字，用文字框作答時是「文字作答」；`<mode>` 是照 hold 記下的處理方式填的 `done` 或 `release`（C19）。這一行整個存進 `sending`，重放時逐位元組相同（上游用答案與 mode 的 digest 判斷重放）。

### 結果怎麼判

| 指令 | 結果 | 記成 |
| --- | --- | --- |
| W1 | exit 0（含 `replay`） | 已送達 |
| W1 | exit 3（已存但沒叫醒 first mate） | 重試中，用同一個 request-id 重放（上游會補叫醒，`bin/fm-inbox.sh:365-390`） |
| W1 | 其他 | 失敗 |
| W2 | exit 0 | 已送達 |
| W2 | 非 0 | 失敗（確定沒寫入，手動重送安全） |
| W3 | exit 0 | 已送達 |
| W3 | exit 3（`fm-send.sh` 自己重試一次後仍未確認） | 遠端：重試中，同一個 delivery id；同機：失敗 |
| W3 | 其他 | 失敗 |
| W4、W5、W6 | 逐行讀輸出，不只看 exit code：有 `closed: <id>` | 已送達 |
| 同上 | `skipped: <id> (already closed)`、`(task <id> records a different captain decision …)`、`(not held for the captain)`：別處已經回答或解除 | 已由別處處理 |
| 同上 | 其他的 `skipped:`、`refused:` | 失敗，附那一行 |
| W6、W9 | `fm-on.sh` 回 255 | 重試中 |
| W7、W8、W9 | exit 0 | 已送達，並寫一筆 `agent.tagged` 系統紀錄 |
| 任何 | 其他非 0 | 失敗，附 stderr |

`fm-send.sh` 自己有 `FM_SEND_REMOTE_BUDGET`（預設 30 秒）加一次重試，看板不再疊加立即重試。

### 重試

- 只有上表記成「重試中」的會自動重試：間隔 10 秒、30 秒、1 分、5 分、15 分，共 5 次。每次嘗試寫一行 `retrying`。用完寫 `undelivered`。
- 歸併的重試（含重啟後接續）每次都先對帳：對該 home 跑一次讀取（R1、R2 或 R3）。不能沿用輪詢的結果，它可能比上次嘗試還舊。
  - 這次讀取失敗：算這次重試失敗。
  - `data/<task>/topic` 的最後一行已經是目標議題：記「已送達」，不再執行。
  - 比 `sending` 當時記下的最後一行多出了別的議題的行：記「已由別處處理」，不覆蓋。
  - 兩者都不是：執行。

  比的是 `sending` 那時記下的最後一行內容，不比時間。
- 作答不另外對帳，重放本身會回答案。

### 作答的兩步

先執行 `answers`；「已送達」之後才發 W1 通知主 first mate：「［議題：<名稱>］已在看板回答 <home>/<task-id>：<答案>」。通知的 request-id 是 `tb-<write id>-note`，重啟或重送都不會通知兩次。第一步是失敗、未送達或已由別處處理時，不發通知。對外是一筆寫入，狀態取還沒完成的那一步。第一步送達時寫一筆 `hold.answered` 系統紀錄。

### 議題變成可派的通知

議題從「待辦」移到「高」或「一般」，或封存的議題被重開：開始 30 秒的計時。30 秒內同一個議題又被移動就重新計時；移回待辦或又被封存就取消。時間到就發一筆 W1。同時到期的幾個議題合成一筆。變更來自 socket 或瀏覽器都算。計時只在記憶體裡，服務在這 30 秒內重啟就不發（已知限制：first mate 下次跑 `order` 仍會看到「該解除」）。其他的順序調整、拖進待辦，都不發。

### 重送與忽略

- 失敗、未送達：可以重送。重送沿用同一個 write id 與 key，寫一行新的 `sending`，按幾次都不會重複生效。主 home 的 `fm-send.sh` 沒有 key，但失敗代表沒寫入，重送安全。
- 結果不明：重送要先過兩步確認（[contracts](contracts.markdown) 第 8 節）。
- 忽略：寫一行 `ignored`。之後這筆不計入紅點。
- 看板狀態裡，每個議題帶一個「沒送到」的計數：最後狀態是失敗、未送達、結果不明而且沒被忽略的寫入數。

### 重啟後接續

服務啟動時讀完 `audit.jsonl`，找出最後一行是 `sending` 或 `retrying` 的寫入。接續之前先讀一次主 home（轉達與遠端寫入只准送給它列出的 secondmate）：

- 可去重的（W1、遠端的 W3、W4、W6、W9）：`sending` 寫下後 30 分鐘內的，接著跑剩下的重試（歸併先對帳）；超過 30 分鐘的寫 `undelivered`。
- W5（同機的作答）：原樣重放一次。
- W7、W8（同機的歸併）：先對帳再決定。
- 不可去重的（W2、同機的 W3）：停在 `sending` 的寫 `unknown`。

### 已知限制（寫進頁面的說明文字，第五段用）

- 經 secondmate 轉達的訊息，「已送達」只代表寫進了 secondmate 的收件匣。遠端的門鈴被吞掉時上游不補鈴，secondmate 可能要等下一次門鈴才讀到。secondmate 轉不出去時會回報主 first mate，由它在聊天告訴使用者；看板上那筆仍顯示「已送達」。
- `audit.jsonl` 存全文、第一版不整理。它和 `events.jsonl`、`summaries.jsonl` 都要在啟動時讀完，檔案太大會讓服務在 10 秒內來不及就緒。`status` 印出三個檔的大小。

## 驗收

1. `<clone>/myshape/test/run.sh 1 2 3 4` 回 0。第四段的測試用假的 `bin/`（每支假腳本把收到的 argv、stdin、`FM_HOME` 記到檔案，並依測試指定的劇本回 exit code 與輸出）。重試間隔用環境變數縮短（只在 `MYSHAPE_TEST=1` 時有效）。至少涵蓋：
   - 上面「結果怎麼判」表的每一列。
   - 每支假腳本收到的 argv 與白名單的形狀逐字相同，而且 `FM_HOME` 是主 home。
   - 以 `/`、`$`、`-` 開頭的直送被拒，假的 `fm-send.sh` 沒有被呼叫。
   - 答案含 tab 或換行被拒。
   - 5 次重試用完轉「未送達」；重送成功後紅點計數歸零；忽略後不計。
   - 歸併重試前的對帳三種結果。
   - 作答：第一步送達才有通知；殺掉服務再啟動，通知只發一次。
   - 重啟後接續：30 分鐘內與超過 30 分鐘的可去重寫入；停在 `sending` 的 W2 變「結果不明」。
   - 「結果不明」的重送沒有確認碼被拒。
   - 30 秒通知：移出待辦後到期會發；到期前移回去不發；兩個議題合成一筆（測試裡把 30 秒縮短）。
   - 同一個 home 的兩筆寫入不並行。
   - `audit.jsonl` 是 0600，每次狀態轉換剛好一行。
2. 沒設 `MYSHAPE_TEST=1` 時，`test-write` 回「不認得的 op」。
3. 前三段的驗收再跑一次。
