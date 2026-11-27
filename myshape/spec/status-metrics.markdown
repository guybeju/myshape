# 設計紀錄：狀態數字（用量面板）

aggregator 可以在每個 home 的回報裡帶一小串它自己選的數字，例如一個帳號的用量用了幾成、什麼時候重置，看板在首頁的「用量」面板照樣顯示。
看板只定格式與送來的路徑，不解讀內容：推哪些數字、門檻多少、怎麼分組，都是 aggregator 的事。
格式的規範在 [contracts](contracts.markdown) 第 4.1 節，上限在第 10 節；程式在 `myshape/src/metrics.ts`（解析、過期判斷、排列）與 `myshape/src/page/usage.ts`（面板）。
first mate 這一側推什麼在 [adapter](../../fm-board/spec/adapter.markdown) 第 3.1 節。

## 決定

每一條：決定什麼、為什麼、不採用的做法。

1. **送來的路徑是 feed 回報裡選用的 `metrics` 區塊。**
   理由：看板本來就定時讀每個 home，不多一支程式、一種參數、一次確認，看板照舊只是被讀的一方；遠端的 home 經同一支 feed 送到，看板不必知道它在哪台機器。
   不採用：新的 socket 操作，因為看板會多一個收資料的入口，aggregator 還得自己排程推送，遠端的 home 也要另外連到主 home 才送得到。
2. **格式是一串有名字的數字，加上選用的組。**
   每一筆有穩定的 `id`、`label`、數值（`unit` 是 `%` 時是 0 到 100 的百分比）、`unit`，以及選用的重置時間、量的時間、`severity` 與所屬的組；組（例如一個帳號）有自己的狀態 `ok`、`stale`、`unavailable` 與一行說明。
   理由：一組的狀態讓 aggregator 說得出「這個帳號這次讀不到」，又不必假造一個數字；通用的欄位也夠 claude-agg 這種 aggregator 推花費之類的數字。
   不採用：照用量來源寫死的欄位（例如 `five_hour_percent`），換一個 aggregator 或一種數字就要升版本。
3. **一筆不合格只丟那一筆，並說丟了幾筆、第一筆為什麼。**
   一筆的每一個欄位都要合格，不然整筆不用；不認得的欄位略過；超過上限的筆數、重複的 `id`、指到不存在的組的都丟。區塊不是物件或 `v` 不是 1 時整個區塊不用，頁面寫一行原因；回報的其他部分照常使用。
   理由：一筆壞資料不能擋住其他的，也不能讓整個讀取失敗；只收完全合格的，就不會顯示一半是猜的數字。
   不採用：截斷過長的字或把壞欄位當成沒有，那樣頁面上的東西和 aggregator 送的不一樣，又看不出來。
4. **每一筆都顯示多久以前量的；過了期限就標成過時。**
   期限是那一筆的 `stale_after_s`，沒有就用區塊的，再沒有就是看板的預設 900 秒，都限在 10 秒到 86400 秒之間。沒有量的時間、量的時間比看板的時鐘晚超過 60 秒，或所屬的組不是 `ok`，一律不當成現在的數字。
   理由：看板不能把舊數字當成新的；量的時間由 aggregator 給，才是真的量的時候，不是看板讀到的時候。
   不採用：用看板讀到的時間當新舊，因為 aggregator 可能拿快取的數字回答，讀到的那一刻不代表數字是新的。
5. **重置時間過了就寫「重置時間已過」，那一筆也算過時。**
   理由：重置之後原來的數字已經不成立，倒數到負的只會讓人誤會。
   不採用：照樣倒數或藏起那一筆。
6. **只顯示。** 面板在首頁側欄的最上面，一組一張小卡，照回報的順序列：組名、讀不到時的標記與說明、組裡最快的重置；每一筆一行名字與數值，百分比另有一條 `<meter>`，下一行寫重置、多久以前量的，過時的寫原因並變淡。
   看板從不因為一個數字派工、hold、改順序、改議題的顏色或放卡到使用者面前；`severity` 只改那一行的樣式，而且過時的那一行不用它。看板的檢視與生命週期的判斷不讀這些數字，有沒有數字都一樣（`myshape/src/view.test.ts` 的 status metrics）。
   理由：數字的意思只有 aggregator 知道；看板照它的數字動作，就是在替它做決定。
   不採用：照數字排序或把紅色的放前面，那就是看板在解讀內容。
7. **頁面上的時間自己往前走。** 頁面只在版本變了才重畫，所以每一筆是否過時、重置是否已過也算進版本（和每個 home 是否過期一樣）；首頁有數字時，頁面另外每 30 秒重畫一次，讓「多久以前」與倒數跟著走。
   理由：這兩種變化只因為時間過去，沒有任何一次讀取會宣告它們。
   不採用：讓服務每分鐘加一次版本，那樣每個開著的頁面每分鐘都要拿一次整份資料。
8. **看板不寫任何新檔。** 數字只在記憶體裡，跟著每個 home 最近一次的回報。
   理由：數字每次讀取都會再來；存下來的，重啟之後反而容易被當成現在的數字。
   不採用：存進 `data/myshape/`。
9. **每個 home 的回報都可以帶，頁面照 home 的順序列；不是主 home 的寫出 home 的名字。**
   理由：遠端機器上的帳號只有那台的 aggregator 讀得到。

## first mate 這一側（今天推的）

- 只有主 home 的回報帶，數字來自這台機器上的 quota-axi：每個 Claude 帳號（quota-axi 的 lane）一組，名稱是它的 `accountKey`（`default` 寫成「Claude」）；每個有百分比的時段一筆，值是用了的百分比（100 減 `percentRemaining`，到小數一位）、它的 `resetsAt`、量的時間（`state.refreshedAt`，quota-axi 剛問過廠商時是報告的 `generatedAt`）；用了 80% 是 `warn`，95% 是 `critical`；`stale_after_s` 是 600。
- quota-axi 只跑一次：`--provider claude --json --no-credential-refresh --max-age 300`，最多 10 秒（`fm_run_timed`）；從不加 `--allow-keychain-prompt`、`--allow-claude-inference` 或 `--full`。`--max-age` 讓 300 秒內的讀取用 quota-axi 上一次的答案，不是每次讀取都去問廠商。有頁面時看板每 10 秒讀一次主 home，所以最多每 300 秒問一次廠商；沒有頁面時每 900 秒才讀一次（contracts 第 10 節），那時每次讀取都會問一次。這一側自己不讀任何憑證或 token；帳號的名稱只取 quota-axi 不含秘密的輸出。
- 沒有 quota-axi、逾時、exit 不是 0 或 1、輸出讀不懂時，回報帶一個 `unavailable` 的組說明原因、沒有數字；不是新鮮的讀數（quota-axi 的 `stale`、`unavailable` 等）是那一組 `stale` 或 `unavailable`，說明是它的狀態與錯誤，也沒有數字。回報的其他部分不受影響，讀取照常成功。

### 已知的限制

- 看板給程式的環境只有五個名稱（[contracts](contracts.markdown) 第 7 節），`QUOTA_AXI_CLAUDE_PROFILES` 傳不到 quota-axi，所以看板經 feed 只看得到這台機器預設的那一個 Claude 帳號。要多個帳號，得在看板程式的環境表加上那個名稱，或由 first mate 從自己的設定檔交給 quota-axi；兩種都要另外決定，這一版都沒做。
- 同機的 secondmate 和主 home 是同一台機器、同一組帳號，不重複推；遠端的 secondmate 這一版也不推，它那台的帳號不會顯示。
- quota-axi 自己的 HTTP 逾時是 15 秒，比這一側的 10 秒長：廠商慢的那一次會被停下、顯示讀不到，下一次讀取再試。

## 測試

| 測什麼 | 在哪裡 |
| --- | --- |
| 解析：合格的、每個上限的邊界與超過、壞的一筆、不認得的欄位、版本不對、空的、沒有區塊 | `myshape/src/metrics.test.ts` |
| 過期：新的、過時、重置已過、沒有量的時間、時鐘超前 | `myshape/src/metrics.test.ts` |
| 排列：組照回報的順序、組裡照回報的順序、沒有組的在最後、最快的重置 | `myshape/src/metrics.test.ts` |
| 頁面的文字：多久以前、倒數與已過、數值、樣式 | `myshape/src/page/usage.test.ts` |
| 有沒有數字，看板其他的顯示與判斷都一樣 | `myshape/src/view.test.ts` |
| 回報帶著區塊到頁面、壞的一筆、版本不對 | `myshape/test/stage-7-aggregator.sh` 的 `test_fm_status_metrics` |
| 面板在真的瀏覽器裡 | `myshape/test/stage-7-page.mjs`、`fm-board/test/stage-5-page.mjs` |
| first mate 這一側：有、沒有、失敗、慢、讀不懂、過時、多個帳號、旗標 | `fm-board/test/stage-1-feed.sh`（quota-axi 是 `fm-board/test/quota-axi/` 的替身） |
