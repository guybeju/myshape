# dispatch-plan：照看板的佇列派工，到每個 home

`bin/fm-dispatch-plan.sh` 是 first mate 這一側的派工計畫，不是看板的程式。
它讀看板公開的檔（`data/topics.json`、`data/topics-archive.json`，`order --hashtag` 另讀 `data/myshape/hashtags.json`），從不改看板的檔，也從不改 backlog。
哪一台機器跑哪個工作是 aggregator 的事，看板只給優先順序與紀錄（captain，2026-11-18）：所以機器的紀錄、規則與檢視都在這裡，看板（`myshape/`）不知道機器。
確切的用法、參數、輸出的字與 exit code 寫在那支指令開頭的說明（`bin/fm-dispatch-plan.sh --help`），這裡寫的是行為、檔案與理由。
看板這一側與 first mate 這一側的分界在 [adapter](../../fm-board/spec/adapter.markdown)。

## 0. 機器那一部分和設計的對照（build 2）

設計是 architect home 的 `data/machine-signals-design/report.md` 第 6 到 9 節，量得到的能力照 `overflow-plan.md` 修訂 2；它們照 `board-decoupling-recheck` 第 5.2 節與 `board-interface-design` 第 7.2 節搬到 first mate 這一側。
這一版對照的是 guybeju/myshape 的 `main`（`5ff6245`，生命週期、排序、用量面板合併之後）。

仍然適用：

- 每台一份紀錄，問了才做、哪裡都不存；它的成長規則（不認得的鍵不管、`null` 與沒有這個鍵都是不知道、`0` 是真的讀數、單位寫在鍵名、改意思才換版本、和讀的那一台的時鐘差 600 秒以上就是不知道）。
- `rule-v1` 與上游自己的門檻；每個 home 的 `order` 照它把工作放進「等機器」，不知道時放行（`machines-view-decide` 答 A）。
- `machines` 的每台區塊、「該轉告」「該通知」，以及量得到的能力與「環境差異」；缺的工具、clone、登入或設定都寫成要補的差異，從不寫成那台不能跑（captain，2026-11-18）。

搬了或改名的：

- `bin/fm-topic.sh machines` 成了 `bin/fm-dispatch-plan.sh machines`（主 home）與 `machine`（每一台，遠端的那一半）；遠端的呼叫是 `fm-on.sh <id> fm-dispatch-plan.sh machine --json`。
  設計的 `--here` 不要了：`machine` 本來就只講它跑的那一台。
- 紀錄的 schema 從 `fm-topic-machine.v1` 改叫 `fm-dispatch-machine.v1`：`fm-topic` 是看板的字頭，同一側的佇列副本叫 `fm-dispatch-queues.v1`。
- role 記在每個 home（`homes[].role`），因為 role 是每個 home 各自解析的（`bin/fm-role.sh report`）。
- 規則範本在 `fm-board/rules/`，主 home 那段從 v14 到 v15，不是設計寫的 v7 到下一版；共用的那段不變（v5）。
- `held` 照上游的 `fm_project_capacity_occupants` 算（同一個 origin 的 clone 都算），不照原型的「同名、沒有 `pr=`」。

已經有的東西蓋掉的：

- design E（build 1）已經在：`order` 的三種來源與 `queues-push`。`machines` 直接用每個 home 的 `order --tsv` 排，不另外排一次。
- 看板讀取契約的 `turn`（hold kind `load`）講的是等容量、自己 hold 住的項目；「等機器」的項目沒有 hold，看板照一般排隊中的項目顯示，看板不用改。

不在這一版的（build 3，placement）：`place()`、`needs:` 那幾行、每台的 placements、交出去的項目回到主 home 的路、共用工具清單和 FORK-SETUP 第 1 節對不對得上的檢查。
清單本身這一版就放了，因為紀錄的 `tools` 要讀它（第 10 節）。
決定 3 答了 B，所以設計裡「PC 等而 Mac 有空時告訴 captain 一次」那一行不做，留給 build 3 的 placement。
負載降下來時叫醒 home 的檢查也不做，和設計一樣（第 9 節）。

## 1. 五個子命令

| 子命令 | 在哪裡跑 | 做什麼 |
| --- | --- | --- |
| `order [--hashtag <名稱>] [--tsv]` | 每個 home；`--hashtag` 只在主 home | 列出排隊中的項目該派、該 hold、該解除的順序，其餘的列在「先不派」並附原因；這台機器先等時，工作改列在「等機器」；`--hashtag` 只列議題貼著那個 hashtag 的那幾行；`--tsv` 給程式讀 |
| `machine [--json]` | 每一台 | 這台的紀錄（`--json`），或只有這台的檢視 |
| `machines [--json]` | 主 home | 每台的紀錄、`rule-v1` 的答案、該轉告、該通知與環境差異 |
| `queues-in -` | 遠端的 second mate | 收下主 home 送來的佇列副本 |
| `queues-push [--check \| --to <id>]` | 主 home | 把佇列副本送到每個遠端的 second mate，或只送給 `<id>` |

規則範本叫主 first mate（`captain.block.md.tmpl`）與每個 second mate（`captain-shared.block.md.tmpl`）在重新評估排隊中的工作前跑 `order`，照「可派」的順序派；「等機器」不在「可派」裡，所以兩段規則都不用為它多寫一句。
看板通知某個議題可以派了的時候，主 first mate 也請手上有那個議題項目的 second mate 跑 `order`。
主 first mate 跑完 `order` 接著跑 `machines`，照「該轉告」「該通知」做。

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

`order --hashtag <名稱>` 是只看一組議題的唯讀檢視，派工的順序與意思都不變：
- 第一行寫「只列議題貼著 #<名稱> 的項目。」，每一段的標題照舊，每一段只留議題貼著那個 hashtag 的行（「等你驗證」也是）；沒有議題的項目不列。
- 哪些議題貼著它，直接讀主 home 的 `data/myshape/hashtags.json`（contracts 第 3.8 節）：併掉的議題 id 的 hashtag 算在它併進去的議題上。名稱比對存下的 `key`，jq 沒有 NFKC，所以只把全形 ASCII 換成半形、ASCII 轉小寫（`bin/myshape-lib.sh` 的 `tb_hashtag_fold_jq`，和 `myshape.sh list --hashtag` 同一份）；存下的寫法本身一定比對得到。沒有這個檔或沒有這個 hashtag 時每一段都是空的。
- 只在主 home 跑：遠端的 second mate 照主 home 推來的副本排，副本裡沒有 hashtag（第 3 節），所以 second mate 的 home 一律拒絕，exit 1，stderr 一行說要在主 home 跑；同機的 second mate 雖然現讀主 home 的檔，也照同一條拒絕，兩種 second mate 才不會有不同的答案。

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
  `machines` 會看到這種情形，在「該轉告」請低的那個 home 讓位，在「該通知」告訴 captain（第 9 節）；這是提醒，不是跨 home 的關卡（`priority-cross-home-decide` 答 A）。
- 容量本身由 `config/project-capacity` 與上游的 `fm-spawn.sh` 決定，`order` 不擋任何派工。
  「等機器」是 `order` 印給 first mate 的建議，`fm-spawn.sh` 不讀它；captain 明講要做的照派。

## 7. 機器的紀錄 `fm-dispatch-machine.v1`

`machine --json` 在它跑的那一台做出一份，印在 stdout，哪裡都不存；沒人問就什麼都不跑。

```
{"schema":"fm-dispatch-machine.v1","collected_epoch":1795805164,"machine":"seanho-hp-envy",
 "platform":{"os":"Linux","arch":"x86_64"},
 "host":{"load1":1.8,"load5":1.89,"cores":20,"mem_free_pct":64,"disk_free_mb":11144},
 "homes":[{"home":"main","code":"3af1ccc…","role":"user"},{"home":"sm1","code":null,"role":"user"}],
 "workers":[{"home":"main","id":"w1","kind":"ship","project":"sample","age_s":3600,"pr_ready":false,
   "state":"paused","state_age_s":30,"declared":{"effort":"high","model":"opus","mode":"direct-PR"}}],
 "workers_complete":true,
 "projects":[{"name":"sample","limit":2,"held":2}],
 "projects_cloned":["main","sample","sm1"],
 "tools":[{"name":"node","found":true,"version":"22.22.1"},{"name":"shellcheck","found":false,"version":null}],
 "ready":[{"home":"sm1","section":"dispatch","id":"s1","topic":"billing","topic_name":"帳務重構",
   "queue":"high","at":0,"repo":"sample"}],
 "notes":[]}
```

| 鍵 | 從哪裡來 |
| --- | --- |
| `host.load1`、`cores`、`mem_free_pct`、`disk_free_mb` | 上游 `bin/fm-capacity.sh` 報告的第一行（最多 10 秒）；Darwin 讀 `sysctl` |
| `host.load5` | 上游 `bin/fm-lane-vitals-lib.sh` 的 `fm_lane_vitals_probe`（不量 GPU） |
| `platform` | `uname -s`、`uname -m` |
| `homes[]` | 上游 `fm_local_firstmate_state_dirs` 走到的每個 home，這個 home 排第一：`main` 或它的 secondmate id、它的 commit、`fm-role.sh report` 的 role |
| `workers[]` | 那些 home 的 `state/*.meta` 裡每一筆不是 secondmate 的紀錄；`state` 與 `state_age_s` 取自那個 home 的 `state/home-summary.json`，沒列到的是 `null`；`declared` 是派工時寫下的 |
| `workers_complete` | 那一趟沒有讀到每個 home 時是 `false` |
| `projects[]` | 最上層的 home 的 `config/project-capacity` 的每一行；`held` 照上游的 `fm_project_capacity_occupants`，用這台上叫那個名字的 clone（worker 的專案、home 本身或 `projects/<名稱>`）；沒有那個名字的 clone 時是 0，因為這台開不了它的 worker；紀錄讀不完時是 `null` |
| `projects_cloned` | 每個 home 本身與它 `projects/` 底下的目錄名 |
| `tools[]` | `dispatch-plan/common-tools.tsv` 上的每個工具，`<名稱> --version` 的第一個版本號（每個最多 5 秒）；沒有清單時整個是 `null` |
| `ready[]` | 每個 home 的 `order --tsv` 裡「可派」與「等機器」的工作（不含已經回答的決定），照那個 home 的順序 |
| `notes[]` | 讀不到的訊號是哪個、為什麼 |

- 只有標籤與數字，沒有路徑、位址、指令或權杖，和上游的 `fm-lane-capacity.v1` 一樣。
- 讀不到的訊號是 `null` 並寫進 `notes`，從不寫成 0；這個鍵不存在表示做紀錄的那一版不收它，兩種都當成不知道。
- 加一個鍵不換版本；改了一個鍵的意思、單位或型別，或拿掉一個必要的鍵，才換 `v2`。讀的一方只認得它知道的版本。
- `logins` 先不收：還沒有不用連網就能查登入的方法，`machines` 把每台的登入寫成待查，不寫成缺。
- 上游的函式庫在 subshell 裡載入，它們的變數不會影響這支指令。
- `machine` 會在遠端那一台跑，照 bash 3.2 與 BSD 工具寫；Mac 上沒有 `timeout` 時，那幾個時間上限就不生效，整次呼叫仍由主 home 那邊的 20 秒切掉。

## 8. `rule-v1`

一個不記任何狀態的函式：輸入一份紀錄與讀的那一台的時鐘，輸出 `{decider, machine, reasons, projects}`。

1. `unknown`：版本不認得；紀錄和這台的時鐘差超過 600 秒（舊的，或那台的時鐘快很多）；或 `load1`、`cores`、`mem_free_pct` 有一個不是數字。
2. `wait`：下面任何一條成立，每一條都是上游 `fm-capacity.sh` 自己的門檻：
   - `load1 ≥ cores`（固定的 cpu 限制）；
   - 有 `load5` 時，`load5 ≥ 0.85 × cores`（cpu 關卡重新打開的那條線），所以尖峰過後的那幾分鐘還是先等；
   - `mem_free_pct < 10`；
   - 有 `disk_free_mb` 時，`disk_free_mb < 5120`。
3. 其他都是 `room`。
4. 每個專案：`free` 是上限減佔用；`free` 是 0 或機器先等時是 `wait`，機器不知道時是 `unknown`，其餘是 `room`。沒有那一行的專案不在裡面。

它不記上一次的答案，所以負載一降下來，下一次問就是 `room`，不會像上游 `auto` 的關卡那樣照一份舊的讀數一直拒絕。
代價是要有人再問一次（第 9 節）。

## 9. `order` 的「等機器」與 `--tsv`

- `order` 每次只用這台的主機訊號問 `rule-v1`，大約多花 0.1 秒；專案的位子不在這裡擋，那是 `fm-spawn.sh` 的事。
- `wait`：來源那一行之後加一行 `這台機器先等（rule-v1：<原因>）；「等機器」的項目先不派，下一輪再看；captain 明講要做的照派。`，「可派」只留已經回答的決定（它不開 worker），其他工作照原來的順序列在緊接著的「等機器」；其他各段不變。
- `unknown`：加一行 `看不出這台機器能不能再加（rule-v1：<原因>）；照「可派」派。`，「可派」照舊。code root 沒有上游的探測程式時也是這樣。
- `room`：輸出和以前一模一樣。
- 那一行放在來源那一行之後，因為 second mate 與 FORK-SETUP 都讀 `order` 的第一行。
- 讀不到 backlog 時照舊只印「讀不到 backlog，照平常的方式派工。」，不問機器。
- 等的代價：負載降下來時沒有東西叫醒 home。「等機器」的項目等那個 home 下一次重新評估：它有 worker 在跑時很快就有（拆掉或 PR 就緒），閒著的 home 要等心跳，最長 7200 秒。主 home 的 `machines` 在主 home 自己重新評估時看到那台有空，就在「該轉告」請那個 second mate 跑 `order`。
- `--tsv`：同樣的項目，每項一行、八欄，用 tab 分開：段落（`dispatch`、`machine-wait`、`hold`、`release`、`parked`、`not-yet`）、id、議題 id、議題名稱、佇列（`high`、`normal`、`later`、`archived`、`none`）、在佇列裡的位置、repo、`work` 或 `decision`；沒有說明的那幾行，也不列「等你驗證」。讀不到 backlog 時什麼都不印。

## 10. `machine` 與 `machines`

`machines` 只在主 home 跑，唯讀，從不派工、不送訊息、不 hold：

- 這台的紀錄直接做；`data/secondmates.md` 裡每個在別台的 second mate，跑 `fm-on.sh <id> fm-dispatch-plan.sh machine --json`，最多 20 秒。
- 拿不到紀錄的那一台（連不到、逾時、那邊的程式還沒有 `machine`、回來的不是紀錄）是 `不知道`，寫出原因，`不算也不轉交`；`rule-v1` 判成 `unknown` 的紀錄也一樣。
- 每台一個區塊：答案與原因、負載、記憶體、磁碟；在跑的 worker（種類、effort、狀態，狀態超過 600 秒舊時寫出來）；每個專案的上限、佔用、還能派幾個，以及它的下一個項目（各 home 的「可派」與「等機器」合在一起，照佇列、議題在佇列裡的位置、home、home 裡的順序排）；有項目卻沒有上限那一行的專案也列出來。
- **該轉告**（主 first mate 送給 second mate 的一行）：
  - 那台有空，某個專案還有位子（或沒有上限），它的下一個項目在某個 second mate：請它跑 `order`；每個 second mate 一行；
  - 某個專案滿了，排在最前面的項目在一個 home，另一個 home 有排得比較後面的項目：請後面那個 home 把下一個位子讓給前面的。
- **該通知**（給 captain 的一行，同一件事只說一次）：上面那種讓位；以及機器有空、專案卻滿了而且有項目在等，寫出佔位的裡面幾個 paused、幾個是 scout。
- **環境差異**：每台和共用工具清單比（沒裝的、比最低版本舊的、版本讀不到的、那台的清單沒有的）；每個 home 的 commit 和 role 和主 home 比；下一個項目的 repo 在那台沒有 clone；作業系統不同時列出來；登入每台都待查。
  每一行寫出補齊的方法與誰做（那台的 second mate、要 captain 同意），從不寫成那台不能跑。
- `--json` 印 `{"schema":"fm-dispatch-machines.v1","at":…,"machines":[{via, record, verdict, error}]}`，給 agent 讀同樣的紀錄與答案。
- 什麼都不記，每一行都來自這一次的紀錄。

`machine` 在任何一台都能跑：`--json` 印這台的紀錄（第 7 節），不加時印只有這台的檢視，和 `machines` 的那一塊相同。

共用工具清單是 `dispatch-plan/common-tools.tsv`：每行 `<名稱><tab><最低版本或 ->`，`#` 開頭的是說明。
現在是 `node 22`、`pnpm`、`firefox`、`jq`、`shellcheck 0.11.0`（FORK-SETUP 的 `node` 與 `bin/fm-lint.sh` 要的 ShellCheck）。
它和 FORK-SETUP 第 1 節對不對得上，由 build 3 加檢查。

## 11. 測試

`dispatch-plan/test/run.sh` 跑全部，每一段都只用暫時的 home：

| 檔 | 測什麼 |
| --- | --- |
| `stage-1-order.sh` | 主 home 的各段與「先不派」的原因、封存檔裡已完成的依賴、`topic:` 那一行、壞掉時放行、`--hashtag` 只列那幾行而 second mate 的 home 拒絕、機器先等時的「等機器」（`load1`、`load5` 剛好 0.85 × cores、記憶體、磁碟）與決定留在「可派」、不知道時放行（讀不到記憶體、code root 沒有探測程式）、`--tsv` |
| `stage-2-sources.sh` | 同機與遠端的 second mate 的來源、第一行、一小時的提醒、等你驗證不出現 |
| `stage-3-queues-in.sh` | 收下、略過較舊的、拒收壞的與太大的、只在 second mate 的 home 跑 |
| `stage-4-queues-push.sh` | 第一次送時 stderr 沒有 shell 的錯誤、每台只送一次、沒變不送、30 分鐘再送、失敗下一輪再試、拒收的每小時一次、18 秒、通知只一則、`--to` 只送一台、交給遠端之前先送 |
| `stage-5-machine.sh` | 紀錄的每個鍵、跨 home 數佔位而 PR 就緒的不佔、secondmate 的紀錄不是 worker、讀不到的訊號是 `null` 並寫原因、沒讀到每個 home、讀不懂的上限檔、沒有路徑、工具清單（找到、比較舊、沒裝、沒有清單）、只有這台的檢視 |
| `stage-6-machines.sh` | 只在主 home、每台遠端只問一次、連不到、舊版、不是紀錄、`rule-v1` 的每一種情形（設計的 run I）從讀的一方判、該轉告、該通知、機器先等時不請人派、環境差異的每一種、`--json` |

`dispatch-plan/test/helpers.sh` 讓每一次 `order` 與 `machine` 讀一台固定的主機：上游的探測程式在 Linux 上讀 `FM_PROC_ROOT_OVERRIDE` 代替 `/proc`，`DP_HOST/bin` 裡的 `getconf` 與 `df` 回答核心數與磁碟，其他呼叫交給真的那一支；所以斷言不看 runner 真的負載。
只有 planner 的呼叫拿到這些（`PLAN` 是包著它的小腳本，其他用 `dp_on_host`），因為上游其他讀 `/proc` 的程式遇到假的 `/proc` 時沒有退路；`stage-4` 跑的 `fm-backlog-handoff.sh` 不在固定的主機上。
`stage-5` 與 `stage-6` 的工具清單只有 `jq`（工具那一個測試除外），所以不會在 runner 上反覆跑每個工具的 `--version`。
`stage-4` 到 `stage-6` 從一個暫時的 code root 跑，那裡的 `bin/fm-on.sh` 是假的：它把副本交給暫時的「遠端」home 裡真的 `queues-in` 或 `machine`、印一份固定的紀錄，或照設定失敗，所以測試不會連到任何別的機器。

沒有測到的：

- 傳送超過 9 秒、遠端紀錄超過 20 秒被切掉的那兩條路：要測就得讓 `timeout` 對子程序送信號，測試刻意不送任何信號。
- 在 Mac 的 bash 3.2 上跑這些測試；macOS 讀 `sysctl`，固定主機的那幾個測試在那裡會讀到真的主機。
- 離開模式的 daemon 與 supervision host 實際跑這個檢查。
- 真的 Mac 上的 `machine`（工具、role、clone 的名字）：要等 macmate 那一台的程式更新到這一版。
