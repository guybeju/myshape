# dispatch-plan：照看板的佇列派工，到每個 home

`bin/fm-dispatch-plan.sh` 是 first mate 這一側的派工計畫，不是看板的程式。
它讀看板公開的檔（`data/topics.json`、`data/topics-archive.json`），從不改看板的檔，也從不改 backlog。
確切的用法、參數、輸出的字與 exit code 寫在那支指令開頭的說明（`bin/fm-dispatch-plan.sh --help`），這裡寫的是行為、檔案與理由。
看板這一側與 first mate 這一側的分界在 [adapter](../../fm-board/spec/adapter.markdown)。

## 1. 三個子命令

| 子命令 | 在哪裡跑 | 做什麼 |
| --- | --- | --- |
| `order` | 每個 home | 列出排隊中的項目該派、該 hold、該解除的順序，其餘的列在「先不派」並附原因 |
| `queues-in -` | 遠端的 second mate | 收下主 home 送來的佇列副本 |
| `queues-push [--check \| --to <id>]` | 主 home | 把佇列副本送到每個遠端的 second mate，或只送給 `<id>` |

規則範本叫主 first mate（`captain.block.md.tmpl`）與每個 second mate（`captain-shared.block.md.tmpl`）在重新評估排隊中的工作前跑 `order`，照「可派」的順序派。
看板通知某個議題可以派了的時候，主 first mate 也請手上有那個議題項目的 second mate 跑 `order`。

## 2. `order` 的佇列從哪裡來

| home | 佇列的來源 | 第一行 |
| --- | --- | --- |
| 主 home | 自己的 `data/topics.json` 與封存檔 | 沒有（只有檔案不能用時印原因） |
| 同機的 second mate（這台機器最上層的 home 是主 home） | 主 home 的那兩個檔，每次現讀 | `照主 home 的議題順序（直接讀 <檔>）。` |
| 遠端的 second mate，以及它在同一台機器上的 second mate | 那台機器最上層的 home 裡的 `state/dispatch-plan/queues.json`，也就是主 home 送來的副本 | `照主 home 推來的佇列副本（<時間>，<幾> 分鐘前）。` |

- 「這台機器最上層的 home」由上游的 `fm_firstmate_root_home`（`bin/fm-wake-lib.sh`）沿著同機的 `.fm-secondmate-parent` 往上找；遇到遠端的上層就停在自己。
  `order` 在 subshell 裡載入那個函式庫，所以它的變數不會影響 `order` 本身。
- 選哪個來源、副本能不能用、幾分鐘算舊，寫在 `bin/fm-queue-source-lib.sh`；second mate 的 `fm-board.sh tag` 用同一份，所以 `tag` 檢查議題 id 的清單就是 `order` 排的那一份（[adapter](../../fm-board/spec/adapter.markdown) 第 3.4 節）。
- 同機的 second mate 每次都現讀主 home 的檔，所以議題在轉交之後才換佇列、拖進待辦或封存，下一次 `order` 就照新的排，不需要服務在跑。
- 遠端的 second mate 照最後收到的副本排；副本的時間與年紀的意思在第 4 節。
- 排隊中的項目沒有議題標記時，用它內文裡單獨一行的 `topic: <議題 id>`（first mate 轉交時寫的那一行），和看板認那一行的規則相同；有標記時標記優先。
- 合併過的 id 跟著 `merged` 走到現在的議題，封存的議題列為該 hold，副本也帶著這兩樣。
- 不在「可派」「該 hold」「該解除」「停著」任何一段的排隊中項目，照 backlog 的順序列在「停著」後面的「先不派」，每行附原因：被看板以外的 hold 擋著、等使用者決定（captain hold），或它等的項目還沒完成、找不到它等的 id。
  這一段只是讓每個排隊中的項目都看得到為什麼沒派，不要 first mate 做什麼；前四段的意思與順序不變。
  一個項目等的 id 算完成，照 `bin/fm-fleet-snapshot.sh` 的判斷：backlog 裡那一筆是 Done，或 backlog 裡沒有那個 id、但 Done 的保留把它搬進封存檔時是完成的（封存檔的位置照 tasks-axi 自己的設定，`bin/fm-backlog-archive-lib.sh`）。
  backlog 裡還開著的同一個 id 優先於封存檔裡舊的那一筆；兩邊都找不到的 id 不算完成，所以打錯的 id 不會被當成做完了。
- 「等你驗證」列的是看板 `data/myshape/todos.json` 裡使用者按了做完了的項目（contracts 第 3.6 節），每個附它的議題與佇列；second mate 的 home 不印這一段：那些項目是主 home 看板上的。

壞掉時放行，都 exit 0：

- 找不到可用的來源時（主 home 沒有議題檔或讀不懂，遠端沒有副本或副本讀不懂），第一行說明原因，把排隊中、沒被 hold 的項目照 backlog 順序全列為可派，不列「該 hold」與「該解除」；看板之前下的 hold 仍列在「停著」。
- 只有找不到可用的來源時才這樣：同機的 second mate 不看副本，遠端的不看主 home 的檔。
- 讀不到 backlog 時印「讀不到 backlog，照平常的方式派工。」。

## 3. 佇列副本 `fm-dispatch-queues.v1`

主 home 的 `queues-push` 從公開的檔做出一份 JSON，遠端的 `queues-in` 原樣收下：

```
{"schema":"fm-dispatch-queues.v1","at":"2026-11-19T04:07:24Z",
 "queues":{"high":[…],"normal":[…],"later":[…]},
 "topics":{"<id>":{"name":"…"}},"merged":{"<舊 id>":"<新 id>"},
 "archived":{"<id>":{"name":"…"}}}
```

- `at` 是主 home 做出並送出這一份的時間（UTC，到秒）。
- 不帶 `todos`、目標、來歷：`order` 用不到。
- `queues-in` 只收剛好一份、每個欄位型別都對、最多 262144 位元組的副本，否則什麼都不寫並 exit 1。
- 收到的 `at` 比已經存著的舊時，留著舊的那一份並說明略過，所以晚到或順序顛倒的送出不會倒退。
- 副本存在 `state/dispatch-plan/queues.json`，目錄是 0700，先寫暫存檔再改名，只有 `queues-in` 會寫它。
- `queues-in` 會在遠端那台跑，照 bash 3.2 與 BSD 工具寫。

## 4. 副本的時間、年紀與一小時的提醒

- `order` 印的時間是那一份副本的 `at`，年紀是從那時到現在的分鐘數（時鐘比主 home 慢時算成 0）。
- 主 home 的佇列有變時下一輪就送；沒變時，上一次送到已經 30 分鐘（`COPY_REFRESH_MINUTES`）就再送一次同樣的內容。
- 所以主 home 一直有在送時，年紀不會超過大約 35 分鐘（30 分鐘加上一輪檢查的 5 分鐘）。
- 年紀到 60 分鐘以上，第一行後面加「副本超過一小時沒更新：主 home 可能沒有 first mate 在跑，或連不到這台；仍照副本排。」。
  這表示主 home 有一個小時以上沒送到這台：主 home 沒有 session（watcher 沒在跑），或連不到這台。
  仍照副本排，因為議題在這段時間裡通常沒有變；代價是這段時間裡被移到待辦的議題，遠端可能還會派它的項目。
- 主 home 的 `queues-push --check` 在同一種情況下發一則通知（第 5 節），所以兩邊說的是同一件事。

## 5. `queues-push` 與主 home 的固定檢查

主 home 在 `state/dispatch-queues.check.sh` 登記一個 watcher 的固定檢查（`bin/fm-check-register.sh dispatch-queues`），內容只呼叫 `bin/fm-dispatch-plan.sh queues-push --check`。
內容只呼叫指令，所以程式更新不會改到它的位元組，登記一直有效。
設定的步驟在 [FORK-SETUP](../../FORK-SETUP.markdown) 第 8 節第 6 點。
watcher 每 5 分鐘（`CHECK_INTERVAL`）跑一次，最多 30 秒，丟掉 exit code 與 stderr，印出的第一行變成一則通知，而且同一輪排在它後面的檢查就不跑了（`bin/fm-watch.sh`）。
所以 `--check` 平常什麼都不印，也一定在 30 秒內結束：

- 送給誰：`data/secondmates.md` 裡每個遠端的 second mate，只送給缺這一份的：它上一次收到的內容不同，或上一次送到已經 30 分鐘以上。
  同機的 second mate 不送。
- 怎麼送：`bin/fm-on.sh --stdin <id> fm-dispatch-plan.sh queues-in -`；那邊回 `ok queues …` 才算送到。
- 紀錄：送到的那一份存成 `state/dispatch-plan/pushed/<id>`；連續失敗記在 `pushed/<id>.failing`（第一次失敗的時間、最後一次嘗試的時間、exit code），送到時清掉。
- 失敗時：連不到或逾時的，下一輪再試；那邊拒收的（exit 1、2 或 64，例如那台的程式還沒有 `queues-in`），離上一次嘗試一小時後才再試，不每 5 分鐘敲一次。
- 時間：開始後 18 秒就不再開始新的傳送，每一次傳送最多 9 秒（有 `timeout` 或 `gtimeout` 時），剩下的留給下一輪，下一輪先送最久沒試過的。
- 通知：一台 second mate 從上一次送到起（沒送到過的，從第一次失敗起）超過 60 分鐘還沒收到這一份時，`--check` 印一行「看板佇列副本：<id> 已經 <幾> 分鐘沒收到主 home 的副本（<原因>），…」。
  印過之後寫 `pushed/<id>.warned`，下一次送到才清掉，所以同一段時間只有一則通知。
- 不加 `--check` 時，每個遠端的 second mate 印一行現況（已送出、沒變、送不出去、還不能收、時間用完），有傳送失敗時 exit 1；這是給人或 agent 手動查的。
- 主 home 沒有 session 時 watcher 不跑，就沒有人送；遠端照最後一份副本排，並照第 4 節提醒。
  要在沒有 session 時也送，得另外加作業系統的排程，不在這個版本裡。

`queues-push --to <id>` 只對那一個遠端的 second mate 做同樣的事，馬上做：同一份副本、同樣的 9 秒、同樣的 `pushed/` 紀錄，副本沒變或那邊一小時內拒收過就不送。
主 home 在交給遠端 second mate 一件會用到議題 id 的事之前先跑它，不管結果都接著交：

- 看板上把那個 second mate 的 task 拖到一個議題（`fm-board.sh deliver` 的 `tag`，[adapter](../../fm-board/spec/adapter.markdown) 第 3.2 節）；
- 把 backlog 項目交給那個 second mate（上游的 `bin/fm-backlog-handoff.sh`，傳送之前），因為項目的 `topic:` 那一行是它接手時要標的議題。

所以看板知道的議題，在那一台被要求用它標記之前就已經在它的副本裡；送不出去時，那台照它手上的舊副本檢查。

## 6. 每個 home 各自排，不跨 home

- 每個 home 的 `order` 只排自己 backlog 裡的項目；兩個 home 各自照看板的順序派，不會比較誰的項目比較急。
- 例如主 home 有一個「一般」的項目，同機的 second mate 有一個「高」的項目，同一個專案的容量只剩一個位子時，先跑重新評估的那個 home 拿到位子。
- 容量本身由 `config/project-capacity` 與上游的 `fm-spawn.sh` 決定，`order` 不擋任何派工。

## 7. 測試

`dispatch-plan/test/run.sh` 跑全部，每一段都只用暫時的 home：

| 檔 | 測什麼 |
| --- | --- |
| `stage-1-order.sh` | 主 home 的各段與「先不派」的原因、封存檔裡已完成的依賴、`topic:` 那一行、壞掉時放行 |
| `stage-2-sources.sh` | 同機與遠端的 second mate 的來源、第一行、一小時的提醒、等你驗證不出現 |
| `stage-3-queues-in.sh` | 收下、略過較舊的、拒收壞的與太大的、只在 second mate 的 home 跑 |
| `stage-4-queues-push.sh` | 第一次送時 stderr 沒有 shell 的錯誤、每台只送一次、沒變不送、30 分鐘再送、失敗下一輪再試、拒收的每小時一次、18 秒、通知只一則、`--to` 只送一台、交給遠端之前先送 |

`stage-4` 從一個暫時的 code root 跑，那裡的 `bin/fm-on.sh` 是假的：它把副本交給暫時的「遠端」home 裡真的 `queues-in`，或照設定失敗，所以測試不會連到任何別的機器。

沒有測到的：

- 傳送超過 9 秒被切掉的那條路：要測就得讓 `timeout` 對子程序送信號，測試刻意不送任何信號。
- 在 Mac 的 bash 3.2 上跑這些測試。
- 離開模式的 daemon 與 supervision host 實際跑這個檢查。
