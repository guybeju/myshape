# 矛盾與漏接

改名（[open-issues](open-issues.markdown) C57）之前，看板的名字是 `topic-board` 與 `fm-topic`；這一頁照寫下時的名字留著，新舊名字的對照在 C57。

彙整時發現各票互相矛盾、和實測或上游原始碼對不上、或沒有任何一張票接住的地方。每一條都附建議；spec 的其他檔先照建議寫，並在該處標「（採建議 Cn）」。使用者不同意哪一條，改那一條引用到的段落即可。

前六條會改變做法，請先看。

## 會改變做法的

### C1　`FM_SNAPSHOT_SECONDMATES=0` 不是「跳過遠端」

- **票怎麼說**：資料來源那張第 2 點、派工順序那張第 2 點，都要彙整腳本與 `order` 設 `FM_SNAPSHOT_SECONDMATES=0`，理由是「主 home 不在每輪抓遠端摘要」。
- **實際**：上游寫明 0 是「取消數量上限」（`bin/fm-fleet-snapshot.sh:260`、`:1773`）。照票做，主 home 每 10 秒會去抓**所有**遠端的 `home-summary.json`。收集那一段（`:1396-1500`）對每個抽到的遠端都開一個 `fm-on.sh <id> fm-remote-file.sh get state/home-summary.json`，沒有略過的分支；`FM_SNAPSHOT_REGISTRY_*` 那幾個變數只限制讀 `data/secondmates.md` 的大小與筆數，設小了會讓 registry 被判成不完整，不是乾淨的關法。
- **建議**：設 `FM_SNAPSHOT_SECONDMATES=1` 與 `FM_SNAPSHOT_BUDGET=1`：最多抽一個遠端、最多等 1 秒。看板不用那份摘要（`secondmate_current`），所以抽到誰、有沒有成功都無所謂。
- **這個建議還沒站穩**：第一段的 1-1 要在真機量。如果這個每 10 秒一次的遠端 job 會搶佔遠端的 reply listener 或讓 lane 排隊，目前沒有退路，要回頭開一個決定。到時的候選：主 home 的彙整腳本不經 snapshot、改成自己組 `tasks` 與 `holds`（違反上游「人看的畫面要用 snapshot 的輸出」的契約）；或接受主 home 的輪詢降到每分鐘一次；或只在主 home 有遠端 secondmate 時才降頻。
- **副作用要知道**：這表示主 home 每輪的 snapshot 內部仍會經 `fm-on.sh` 開一個遠端 job。那是上游腳本自己做的，不是看板執行的指令，白名單不受影響；但遠端 lane 會多這個流量。

### C2　socket 路徑太長時 Node 不會報錯

- **票怎麼說**：服務生命週期那張第 5 點：路徑超過上限時啟動失敗。
- **實際**：實測 Node 默默截斷路徑，把 socket 建在別的地方，並回報成功。
- **建議**：服務在 `listen` 之前自己算路徑的位元組長度，超過就啟動失敗。已寫進第二段。

### C3　由誰啟動服務

- **票怎麼說**：服務生命週期那張第 2 點：Bash 議題指令用 `nohup` 加獨立 process group 啟動 `node`，形狀參考上游的 `docs/verification/supervision.md`。
- **實際**：那份文件沒有指令的形狀。上游實際用的是 `set -m; nohup … &`。實測三種形狀都活得過工具呼叫；其中由 node 自己 `spawn({detached: true})` 最乾淨（自己的 session、沒有殘留的包裝程序），而且不依賴 macOS 沒有的 `setsid`。
- **建議**：由 node client 啟動服務。連 socket 本來就要先跑 client，沒有多一個相依。已寫進第二段。

### C4　TypeScript 怎麼跑（問過使用者）

- **實際**：這台的 `node` 沒有 TypeScript 支援，type stripping 不能用。
- **定案**：提交 `tsc` 的編譯結果。連帶的改動：啟動失敗的類別裡「`node` 低於 22」照舊（任何 22.x 都行），另加一類「編譯結果不見了」；多一個 `check-dist.sh` 防止 `dist/` 過期。

### C5　fork 裡不能有新的 `.md`

- **票怎麼說**：偏好檔那張把範本定成三個 `.md`，「實作時原樣搬進 fork」。
- **實際**：上游的文件稽核要求每個追蹤的 `*.md`、`*.txt` 都登記在既有的清單檔。加了就失敗，而改清單檔違反「只新增」。
- **建議**：範本改用 `.md.tmpl`，spec 用 `.markdown`（使用者已選），新目錄不放 `README.md`。內容一個字都不用改。

### C6　fork 的測試不能放在 `tests/`

- **票怎麼說**：誰來實作那張：照上游的測試慣例。
- **實際**：上游的 `fm-test-run.sh --check-coverage` 目前剛好在 15% 的上限，多一個 `tests/*.test.sh` 就失敗；時間量測表寫在上游的 `bin/fm-test-run.sh` 裡。
- **建議**：fork 的測試全放 `topic-board/test/`，用自己的 `run.sh`，只借用上游的 `tests/lib.sh`。代價：在開發用的 clone 裡跑上游的 `fm-test-run.sh --changed` 會因為找不到對應的測試而中止（`no changed-test mapping`）。fork 的 PR 不用 `--changed`，改跑各段驗收列的指令。上游的 CI 本來就不在 `carry` 上跑，所以沒有東西會因此變紅。

## 票與票之間對不上的

### C7　`status` 的規則狀態用詞

偏好檔那張第 7 點寫「未裝、和範本相同、和範本不同」，比的是內容；指令介面那張的補記寫「未裝、已裝 vN、或比範本舊」。**建議**：照前者，並附上版本號給人看：`和範本相同（vN）`、`和範本不同（vN）`。「比範本舊」判斷不出來（使用者手改也會不同）。

### C8　主 home 的歸併沒有列在最終的 argv 清單

安全防護那張第 8 點有「議題指令的 `tag`（本機直接跑）」，但後來幾則補記列 argv 時只列了遠端與同機 secondmate 的形狀。**建議**：最終的表補上 `fm-topic.sh tag <task-id> <議題 id>`（W7）。

### C9　經 secondmate 轉達的訊息，同一個 argv 有兩種分類

重送那張第 2、10 點：遠端的 secondmate 算可去重，同機的算不可去重，但 argv 完全一樣。**建議**：分類的依據寫明是 `secondmates[]` 的 `remote` 欄位，在 `sending` 那一行記下來，重啟後照它判斷。

### C10　`summary --home <id>` 在服務剛啟動時無從檢查

里程碑那張要求 `--home` 的值在 `secondmates[]` 裡，但服務只在有人看頁面時輪詢，剛被 `summary` 帶起來時可能一次都沒讀過主 home。**建議**：服務手上沒有主 home 的彙整結果時，先同步跑一次主 home 的讀取（白名單的 R1）再檢查，最多等 10 秒。

### C11　`failed` 的摘要在首頁沒有位置

版面那張的「最近的結果」只列就緒、報告、落地。**建議**：四種都列，`failed` 用卡住的顏色。失敗正是一陣子沒看的人最需要看到的。

### C12　哪些選項算「不可逆」、確認碼綁什麼

- **票怎麼說**：brief 第 18 項與安全防護那張第 6 點：合併、捨棄等不可逆動作兩步確認，確認碼綁 PR 網址與 head commit。
- **對不上的地方**：選項只是 hold 最後一行的散文，沒有任何一張票定怎麼認出哪個選項是「合併」。`holds[]` 裡也沒有 PR 網址與 head commit；每輪又設了 `FM_CREW_STATE_NO_FORGE=1`，不查 forge。
- **建議**：不猜。**所有**作答都走兩步，確認碼綁 (home, task id, 問題全文的雜湊, 答案)。理由：送出答案就會關掉那個 hold，本身就收不回來；看板又不執行合併，真正合併的是 first mate，上游在那一側自己有防護。代價是每次作答多按一下。
- 連帶補定：答案是單行，不能含 tab 或換行（上游的輸入格式用 tab 分欄、一行一筆）。

### C13　「600 字」的單位

里程碑那張說約 300 字、拒收超過 600 字。**建議**：算 Unicode 碼位。

### C14　`t<流水號>` 的計數存哪

格式那張說轉不出 slug 時用 `t<流水號>`，id 永不重用，但沒說號碼記在哪。**建議**：`topics.json` 加 `next_seq`，只增不減。

### C15　同機的 secondmate 怎麼跑 `setup`

改用 fork 那張說「同機的 secondmate 在它自己的 home 跑」，沒說誰、怎麼跑。**建議**：`fm-topic.sh --in-home <id> setup`，由使用者或主 first mate 從主 home 跑。不進看板的白名單。

### C16　完全沒有 `node` 時的 `status` 與 `stop`

指令介面那張把它們歸在「需要 `node`（服務沒跑時只讀檔）」，沒說連 `node` 都沒有時怎樣。**建議**：`status` 退成只讀檔並註明原因，回 0；`stop` 回 69。

### C17　名詞表的「議題標記」還寫「派工前」

派工順序那張已經把時機提前到「建立 backlog 項目時」。**建議**：照後者；這份 spec 的名詞已改，規劃目錄的 `GLOSSARY.md` 也一併改了。

## 沒有任何一張票接住的

### C18　彙整腳本沒有 `decisions_open`

brief 與帳本研究都說待決事項從 snapshot 的 `decisions_open` 讀。實測 `fm-fleet-snapshot.sh --json` 的頂層沒有這個欄位；資料來源那張第 1 點改從 `backlog.records[]` 取，是對的。這裡只是記一筆，免得實作時照 brief 找不到。

### C19　作答時用 `done` 還是 `release`

- **問題**：`fm-captain-hold.sh answers` 每行的第四欄決定作答之後怎麼處理被 hold 的項目：空或 `done` 是把它標成完成，`release` 是解除 hold 讓它繼續。上游的守則：純粹的決定用 close，還有沒做完的工作用 release，合併的同意也用 release（`.agents/skills/captain-hold-lifecycle/SKILL.md:34-42`）。看板分不出一個 hold 是哪一種，沒有任何一張票定這件事。
- **選錯的後果**：該 release 的用了 done，一件還沒做的工作會被標成完成，而且不會有人發現。該 done 的用了 release，一個純決定的項目會留在 backlog，first mate 收到通知後自己關掉。
- **定案（使用者 2026-11-18 改定）**：由開 hold 的人在開的時候決定，看板照著送。`fm-captain-hold.sh hold --on-answer close|release` 把它記在 hold 的內文，規則（共用區塊 v2）要 first mate 開 hold 時帶上。卡片只有一個送出鈕，並寫明送出之後這一項會怎樣。原本的定案是兩個送出鈕、沒有預設，使用者每次都要判斷一個 first mate 開 hold 時就知道的結果，所以改掉；做法寫在 [contracts](contracts.markdown) 第 8 節。
- **沒有記的 hold**：送 `release`。`release` 之後項目回到排隊中，純決定的項目由 first mate 收到通知後自己關掉，最壞是多一個要關的項目；改送 `done` 的話，擋著沒做完工作的項目（例如同意合併）會被默默標成完成，工作就不見了。主 home 的要你動手的項目例外，送 `done`：它只裝使用者自己要做的事，「不做了」「好，撤下」本來就是結束它（C46）。
- **答的不是定案**（例如「先給我更多資訊」）：`close` 的項目照樣關掉並記下那句話，first mate 收到通知，要再問就另開一個 hold（關掉的 task 不能再 hold）；`release` 的項目回到排隊中，first mate 補完資訊後再 hold 一次。
- 已知上游在 away 狀態下拒絕 `release`（回 `refused:`），那時那筆寫入顯示「失敗」並附原因；沒有記的 hold 照預設送 `release`，所以 away 時一樣會失敗。兩種之後項目的狀態在第四段 4-4 驗過（[handover](handover.markdown) 第 3 節）。
- 規則的共用區塊升到 v2，只多 `--on-answer` 那半句；三個範本合計約 1445 token，測試的上限 1450 不變。真的 home 要由使用者明講之後重跑 `install-rules`，而且要等每個 home 都更新到有 `--on-answer` 的程式（[FORK-SETUP](../../FORK-SETUP.markdown) 第 7 節）。

### C20　各段怎麼分

誰來實作那張的六段草稿沒有安置下面這些，這份 spec 的分法是：

| 項目 | 放在 | 理由 |
| --- | --- | --- |
| `--in-home` 的 `tag`、`answers`、`setup` | 第一段 | 純 Bash、不碰 socket |
| `open`、`reset-token`、token 檔 | 第二段 | 服務一啟動就要有 token 與埠 |
| `summary`、`which` | 第三段 | 要靠彙整結果查議題 |
| 各 home 的版本狀態與 `status` 裡的那幾行 | 第三段 | 資料來自輪詢 |
| 議題變成可派的 30 秒通知 | 第四段 | 它是一筆寫入 |
| `status` 的規則狀態 | 第六段 | 和範本一起 |
| 頁面上的改名、改目標、封存、議題併議題 | 第五段 | 這次補定，見該段 |

### C21　`fm-inbox.sh note` 回 3 時上游建議的修法

上游的檔頭說「已存但沒叫醒」時呼叫端應該用 `announce <id>` 修復。重送那張定的是用同一個 request-id 重放，並已確認重放會補叫醒。兩者效果相同；**建議**照票（重放），白名單不用多一個形狀。

## 實作時才發現、已經改掉的

這幾條在規劃時沒有人看到，是寫程式與跑測試時冒出來的。都已經照下面的做法實作並有測試。

### C22　兩個指令同時啟動服務

三個指令同時啟動時，輸的那個在贏家還沒綁好 socket 之前去探 socket，會把贏家誤判成「埠被別的程式佔用」，連贏家的 client 也跟著失敗。**做法**：同一個 home 一次只有一個 client 能啟動、殺掉或換掉服務（`state/topic-board/start.lock`）；服務一綁到埠就先寫 `pid` 檔。

### C23　一筆在等重試的寫入擋住同一個 home 的其他寫入

原本「同一個 home 的寫入依序執行」做成整筆排隊，一則卡在重試的 note 會讓後面所有寫入等最久 15 分鐘。**做法**：只有執行指令那一段互斥，等重試時不佔位置。

### C24　選項行不一定在行首

上游把 hold reason 存在 backlog 項目的標題行，是單行的；規則寫的「最後一行寫 `選項：A | B | C`」到看板時可能已經接在問題後面。**做法**：取最後一行裡最後一個 `選項：` 之後的文字。真的 `tasks-axi` 怎麼存多行的 reason 還沒驗。

### C25　提議沒有辦法拒絕

票只定了確認與歸併，使用者不要某個提議時沒有路。
C52 之後沒有提議了：議題一建立就排進佇列，不要的議題和其他議題一樣封存，頁面上的「不採用」拿掉了。

### C26　每一輪輪詢都讓頁面整頁重畫

讀完一個 home 就把版本加一，頁面每 5 到 10 秒重畫一次，開著的下拉選單會被關掉。**做法**：只有看得到的東西變了才算變；home 過期另外算進版本。

### C27　同機 secondmate 的版本永遠顯示「相同」

`--in-home` 是用主 home 的腳本去讀，回報的是主 home 的 commit。**做法**：回報那個 home 自己 checkout 的 `HEAD`。

### C29　op 名稱是 `constructor` 時服務會當掉

上線後用亂送的要求測 socket 時發現：op 的對照表是一般物件，`constructor`、`toString` 這類每個物件都繼承的名字查得到東西，服務把它當成處理函式呼叫後整個行程結束。**做法**：只認對照表自己有的名字，其他一律回「不認得的 op」。議題 id 也不收這類名字。

### C30　沒有人開著頁面時，`which` 與 `summary` 回的是舊的議題

服務只有在有人看頁面時才定期讀取。task 重新標記之後，如果沒有頁面開著，`which` 會一直回原本的議題。**做法**：這兩個指令每次都先重讀那個 home；讀不到時，之前看過的標記仍然算數，連標記都沒看過才回「議題待查」（原本寫「議題不明」，容易被讀成查詢失敗）。

### C31　議題名稱與目標可以夾帶控制字元

名稱只擋換行。tab 會打亂 `list` 的欄位，終端機的跳脫序列會在 first mate 的終端機裡生效，雙向文字的控制字元會讓名稱看起來不是它實際的內容。**做法**：名稱、目標、關閉原因不收控制字元與雙向文字的控制字元。

### C32　卡在啟動畫面的 worker 顯示成「進行中」

第一次實測時兩個 worker 停在 harness 的確認畫面，從沒開始工作。上游的 crew-state 對這種 pane 回的是 `working`，看板照著顯示「進行中」；watcher 有發現，但它的訊號不在 snapshot 裡。**做法**：上游在派出時會先寫一筆 busy 紀錄（來源 `fm-spawn`），harness 的 hook 第一次觸發後才換成別的來源（`bin/fm-busy-lib.sh` 的檔頭）。crew-state 的 detail 還是 `harness busy (fm-spawn)`，就表示 harness 連第一輪都還沒開始。彙整腳本把這個判斷帶成欄位 `unstarted`，頁面在那一列加警示：「<派出時間> 派出後還沒開始第一輪，停太久就是卡在啟動畫面」。燈號不變。剛派出的幾秒內正常的 worker 也會短暫出現這個警示。還沒換到這一版的 home 沒有這個欄位，當成已經開始。

第一版用的是「從沒寫過 status」，實測發現正常的 worker 在第一個里程碑之前也沒有 status，會誤報好幾分鐘，已經換掉。

沒有做的：讀 watcher 的 wake 紀錄（格式是上游內部的，會變），以及「開始之後很久沒動」的情況。crew-state 把等人的 pane 報成 `working` 是上游的行為，要不要向上游反映由使用者決定。

### C33　第一次實測找到的其他幾條

- 直送訊息開頭是空白加 `/`，或是 `!`，原本會送出去。現在前面有空白也算，`!` 也擋。
- 看板與終端機同時回答同一個 hold、終端機先到時，看板那一筆顯示「失敗」加一段上游的英文。現在算「已在別處處理」。
- 回答後選「讓工作繼續」的決定事項會出現在 `order` 的「可派」。現在那一行會註明它是決定事項、沒有工作要派。
- 程式更新後、服務還沒換版之前，`status` 看不出來。現在會多一行說目前的程式是哪個 commit。

### C34　寫錯的摘要沒辦法收回

實測時 first mate 把一個其實沒落地的 task 寫成了 `landed`，摘要檔只能加、不能改，錯的里程碑就一直留在看板上。**做法**：`fm-topic.sh retract [--home <id>] <task-id> <kind> -`，stdin 是原因。它把那個 task 最新一則該種類的摘要從看板拿掉，並印出拿掉的是哪一則。檔案仍然只加不改：原本那一行留著，後面多一行撤回紀錄（含原因）。撤回之後同樣的文字可以再寫一次。規則範本還沒有提到這個指令；要加的話得改範本、重跑 `install-rules`。 主 home 的規則範本從 v2 起有一句叫 first mate 寫錯時用 `retract`；範本更新後要由使用者重跑 `install-rules`。

另外，直送給已經結束的 worker 時，原本顯示上游一長串英文錯誤，現在顯示「這個 worker 已經結束或找不到，訊息沒有送出。」

### C35　被捨棄的 task 顯示成「完成」

實測時兩個 task 的分支被捨棄（`fm-teardown.sh --force`），上游把 backlog 那一列收成 Done，帳本記的也是和正常收尾一樣的 `task.cleaned_up`，看板就顯示「完成」，和真的落地的分不出來。**做法**：`ship` 類的 task 被清理時，如果從最近一次派出之後帳本裡沒有 `task.merged`，不顯示「完成」，改顯示「未知」並註明「已收掉，帳本裡沒有落地紀錄」。其他種類（例如 scout）本來就不會合併，照舊顯示完成。它們留下的「就緒」摘要不會自動消失，要用 `retract` 撤回。重做的 task 與原本那個之間沒有連結。

### C36　先在終端機解除的 hold，看板顯示成失敗

實測時先在終端機用 `release` 回答一個 hold，再在看板送出同一個 hold 的回答，上游回 `skipped: <id> (not held for the captain)`，看板把它當成失敗並顯示那一行英文。看板只對它顯示成等使用者決定的 hold 送回答，所以這個回覆代表別處已經解除。**做法**：這一行和「已經關掉」「記了另一個決定」一樣算「已由別處處理」。

### C37　規則區塊的標記行被改過形狀就認不出來

標記行原本要整行一字不差才算。試了整理偏好檔時可能發生的幾種情況：標記行被縮排時 `status` 顯示「未裝」，`install-rules` 會在檔尾再貼一份，規則變成兩份；行尾多了空白、換成 CRLF、結尾標記後面被加上別的註記時，回報「標記不成對」而且說找不到結尾標記。**做法**：標記行前面的空白與標記後面的文字都容許，這幾種情況都算「和範本不同」，重跑 `install-rules` 會在原位換成乾淨的一份。標記真的少一個或重複時照舊拒絕。6-4（上游的 stow 跑過之後標記還在不在）仍然沒有實測，因為 stow 是 first mate 自己判斷的整理動作；這裡驗的是它改壞之後的各種結果。

### C38　排隊中的工作在看板上看不到

看板原本只顯示有 worker 的 task。已經標了議題但還沒派出去的 backlog 項目哪裡都看不到；實測時轉交給 secondmate 的 task 在它派出之前消失了約兩分鐘。**做法**（使用者 2026-11-16 同意）：彙整腳本多回 `queued[]`（每個排隊中的 backlog 項目的 id、kind、標題、hold 原因、是不是等使用者決定、還在等哪些項目），view 多一個 `queued[]`，議題頁多一區預設收合的「排隊中 N」，首頁的議題卡片顯示「排隊 N」。還沒更新的 home 不回這個欄位，當成沒有排隊的項目。沒有標議題的排隊項目不顯示在未分類區。

### C39　合併、改名過的議題查不到來龍去脈

合併只留下「舊 id → 新 id」和一行系統紀錄，被併掉的議題的名稱與目標都丟了；改名完全沒有紀錄；也沒有查詢的指令。使用者的用法是一切透過 first mate，又不希望 first mate 把這些記在 context 裡。**做法**（使用者 2026-11-16 同意，分兩步；這是第一步）：

- 議題檔多一個 `history`，合併、改名、封存、重開各記一筆，和議題的變動同一次存檔。
- `fm-topic.sh find <關鍵字>`：比對議題的 id、名稱、目標，包含已經併掉或改掉的 id 與名字，把符合的議題列在它現在的 id 底下並附上來歷；關鍵字剛好是 task id 時，另外列出那個 task 歷來標過的議題。輸出有上限：最多五個議題、每個議題最多八筆來歷，超過時說還有幾筆。
- 有 `history` 之前做的合併只有 `merged` 表，`find` 照樣列出來，註明沒有當時的紀錄。

第二步是正式的 `split` 指令與規則 v3，規則到那時才改，免得規則提到還不存在的指令。

### C40　拆分議題沒有正式的做法

要把一個議題拆開，first mate 只能提議一個新議題、等確認、再把 task 一個一個改標，新舊議題之間沒有任何連結。**做法**（C39 的第二步）：

- `fm-topic.sh split <來源議題> <新名稱> --goal <一行> [--id <id>] [<task>|<secondmate-id>/<task>]…`。服務建立一個已確認的新議題，排在來源議題的正後面、同一個佇列（搬過去的工作優先順序不變，看板自己下的 hold 也不會失效），並在 `history` 記一筆 `split`。
- 指令先向服務問「會建立哪個 id」（`--dry`，不寫入），檢查每個 task 現在都標在來源議題（或已經標在新議題），有一個不符就整個不做。檢查過了才建立議題，接著逐一改標。
- 改標不是和建立議題同一次寫入，所以中途失敗時原樣再跑一次：同一個來源、同一個名稱的拆分會沿用已經建立的議題，把剩下的 task 搬完。
- 遠端 secondmate 的 task 搬不了，指令會拒絕並說明，由那個 secondmate 自己跑 `tag`。
- `find` 在來源與新議題底下都會列出這筆拆分；task 的標記路徑裡，標在已併掉的 id 上的那一步會註明原本的 id。
- 規則範本升到 v3：多一句 `find`、一句 `split`，`split` 也列進「只在使用者明講時才跑」。真的 home 要由使用者明講之後重跑 `install-rules`。

看板頁面上沒有拆分的按鈕；使用者說這類操作都透過 first mate。

### C41　`find`、`split` 補的檢查

合併之後補跑品質關卡與極端輸入，結果：

- mutation testing 在 `lineage.ts` 找到七個沒被測到的邊界（剛好五個議題、剛好八筆來歷、不相干的合併紀錄會不會混進來等），在 `split` 找到一個（拆出來的議題被封存後再做同樣的拆分）。都補了測試；`placeOf` 裡一個永遠不會成立的防呆分支拿掉了。現在這兩個模組沒有存活的突變。
- `find` 的關鍵字原本只擋空字串與長度，控制字元會原樣印回來。現在和議題名稱用同一個檢查，有控制字元或換行就拒絕。
- 試過沒有問題的：六個相同的 `split` 同時跑（只建立一個議題，六個 task 都搬到）、同一個 task 列兩次、`../etc`、`a/b/c`、`-x` 之類的 task 寫法（全部在寫入前拒絕）、名稱含換行或跳脫字元、id 用 `constructor` 或已用過的 id、五千筆來歷時 `find` 與存檔都在 0.2 秒左右。
- 已知的限制：一個議題的來歷超過八筆時只印最近八筆，關鍵字如果只符合更早的舊名字，找得到議題但看不到那一筆。`split` 不帶任何 task 也能跑，會建立一個空的議題。新議題可以和來源同名，和 `create` 一樣不擋。

### C42　窄視窗下首頁的兩欄擠在一起

首頁固定是「260px 的優先順序欄加上其餘」兩欄，沒有任何 `@media` 規則。視窗寬度 390 px 時右欄剩一百多 px，「排定的」每列的字變成一個字一行。議題頁沒有這個問題。**做法**：視窗寬度 640 px 以下改成單欄，內容欄（等你決定、最近的結果…）排在前面，優先順序欄排在後面。用無頭 Firefox 在 390 px 寬截圖確認；沒有為它寫自動測試，因為現有的瀏覽器測試固定在 1300 px 寬。這台機器沒有裝 Chrome，Chrome 與真的滑鼠拖曳仍然沒有測過。

### C43　獨立審查找到的問題（`split`、`find`）

請另一個 agent 不帶結論重看 C38 到 C42 的變更，它實際跑出來的問題與處理：

- **`split` 會把標記檔寫壞卻回報成功。** `cmd_split` 把建立議題與改標寫成 `( 函式 ) || failed=1`，函式在 `||` 後面執行時 `set -e` 不作用，中途失敗會繼續往下跑：標記寫不進去照樣印 `ok`；議題 id 解不出來時會把一行只有時間的內容加進標記檔，那個 task 就從議題上掉下來，而且再跑一次會被擋。**做法**：每一步改成把這支腳本當成獨立的程序再跑一次（內部子命令 `split-topic` 是不含 task 處理的那一半），失敗就是失敗。
- **改標用的是預先問到的 id。** 檢查與建立之間如果有別人用掉那個 id，服務會另外取一個，task 卻被標到原本那個。**做法**：改標用的 id 取自真正建立時服務回的那一行，看不懂就不搬。
- **來源議題後來被併到別處，再跑同一個拆分會多建一個議題。** 比對時沒有沿著 `merged` 表走。已修。
- **來源議題不在任何佇列時 `split` 會丟例外。** 只有手改過的議題檔會這樣。改成拒絕並說明。
- **`find constructor` 之類的關鍵字會讓服務回錯誤。** 查 task 標記時用了物件繼承來的屬性。改用 `Object.hasOwn`。
- **標記檔的時間讀不懂時 `find` 印 1970-01-01。** 改印「時間不明」。日期一律是 UTC 的日期。
- 沒有改的：結尾標記後面如果有人手寫了別的字，`install-rules` 會連那些字一起換掉（有備份）；檔案別處有一行縮排後以標記開頭的文字時，會被當成多出來的標記而拒絕安裝。
- 審查沒找到問題的：task 與 secondmate id 的路徑穿越、`history` 的讀寫與當機順序、排隊項目從彙整腳本到頁面的整條路、`--dry` 不會改到狀態。
- 仍然沒驗的：bash 3.2。`cmd_split` 取 task 清單的寫法已經改成不依賴空陣列的展開。

### C44　使用者在看板上確認議題，first mate 不知道

實際使用時發現：first mate 提議議題之後照規則等使用者確認，使用者在看板頁面上按了確認，first mate 沒有收到任何通知，直到被問才去跑 `list`。看板原本只在議題變成可派工時通知 first mate。**做法**：從頁面來的議題操作，如果是 first mate 在等或需要跟著動作的決定，就送一則 note 到主 home 的收件匣（和可派工通知同一條路，同樣在白名單內）：

- 合併、封存：內容是系統紀錄的那一句加上議題 id，例如「使用者在看板上：議題「X」已封存（id：x）」。
  確認議題原本也在這裡；C52 之後頁面上沒有確認，這一項跟著拿掉。
- 對關閉提議按「先不關」：「議題「X」先不關（id：x）」。
- 不通知的：改名、改目標、拖曳排序（變成可派工時原本就有通知）、重開（同上）、合併還在等第二步確認的時候，以及 first mate 自己從終端機下的指令。

### C45　first mate 開了太寬的議題

真的 home 上 first mate 提議了「Firstmate 框架維護」這種什麼工作都能裝的議題，使用者要的是一件具體的事一個議題（2026-11-17 對 first mate 說的，之後用 `split` 拆成四個）。**修正**：主 home 規則範本升到 v4，在「提議議題」那一句後面加「議題要窄：一件具體的事一個議題，不開什麼都能裝的大議題。」。三個範本合計約 1218 token，測試的上限從 1200 調到 1250。真的 home 要由使用者明講之後重跑 `install-rules`。

### C46　要使用者親手做的事沒有地方放

使用者要自己跑的 sudo 指令、要自己做的登入只出現在聊天裡，往上捲就不見了。first mate 先用一般的待決事項頂著（選項「已完成 | 不做了」），但頁面把它們和真正的決定混在「等你決定」，指令不好複製，first mate 撤下時只能冒充使用者作答，使用者按了已完成之後也沒有人驗證（使用者 2026-11-17 要求，同意下面的做法）。**做法**：

- 不另開資料來源。項目就是主 home 的 captain hold，原因以 `動手：` 開頭（定義在 [contracts](contracts.markdown) 第 1 節）；看板只多記它的狀態（`topics.json` 的 `todos`）。
- `fm-topic.sh todo add <task-id> <標題> --topic <議題 id> --do <一行> [--note <說明>] [--cmd <指令>]…`（C54 改的；原本是 stdin 第一行是說明，其餘是指令）。先檢查議題，再用上游的 `fm-captain-hold.sh hold` 建立或更新，最後標上議題。已經是一般待決事項的 task 不能改成這種項目。重跑同一個指令是安全的，文字會更新，看板上舊的狀態會清掉。已經是一件工作的 task 也不能改成這種項目。
- 頁面多一區「要你動手」（首頁與議題頁），不和「等你決定」混在一起；議題卡上另外計數。每個指令用等寬字原樣顯示，各有一個「複製指令」按鈕；瀏覽器不讓複製時改成把那一個指令選取起來（C54）。
- 「做完了」不關 hold：看板記成 `claimed`、發一則通知給主 first mate（附兩個指令），卡片留著並顯示「等 first mate 驗證」。通知萬一沒送到，`fm-topic.sh order` 的「等你驗證」也會列出來。
- first mate 驗證後跑 `fm-topic.sh todo done <task-id>`：經上游唯一的作答入口關掉 hold，紀錄是「做完了」，附註「first mate 已驗證」。只關開著的這種項目。沒成功就跑 `todo failed <task-id> --reason <一行>`：卡片回到要使用者動手，顯示原因。
- first mate 不再需要時跑 `todo obsolete <task-id> --reason <一行>`：卡片顯示原因與一個「好，撤下」按鈕，由使用者按下才關。**這一點和當初對使用者說的「first mate 直接撤下」不同**：上游把每一次作答都記成「Captain answered」，沒有讓 first mate 自己關掉 captain hold 而不冒充使用者的入口（`reconcile close` 要先有使用者的選擇），所以關閉的那一下留給使用者。
- 「不做了」與「好，撤下」走原本作答的兩步確認，照 hold 記下的處理方式送出：`todo add` 記的是 `close`，更早建立、沒有記的也送 `done`（C19）。
- 規則範本升到 v5，多一句說明這四個指令。三個範本合計約 1355 token，測試的上限調到 1400。真的 home 要由使用者明講之後重跑 `install-rules`。
- 看板服務沒有多跑任何指令：通知走原本的 `fm-inbox.sh`，作答走原本的 `fm-captain-hold.sh answers`；`todo add` 與 `todo done` 是 first mate 在終端機跑的。

合併前的獨立審查找到並修掉的：`todo done` 原本會把「不在開著的 hold 清單裡」的 id 也送進作答入口，可能關掉別的決定，現在只送開著的這種項目，所以對已關的項目重跑會被拒絕並說明；重複按「做完了」時若同時清掉了別的舊紀錄，會多發一則通知；`todo add` 改寫內容後舊的狀態沒有清掉；task id `__proto__` 存不進去；已經是工作的 task 會被改成這種項目；放超過 14 天的項目會掉到「暫緩」（現在留在「要你動手」）；first mate 標成不再需要的項目不能再按「做完了」；CRLF 會留在指令裡；`topics.json` 的 `todos` 型別不對時 `order` 會整個失敗。

已知限制：只支援主 home 的項目；`claimed` 之後使用者不能自己收回（first mate 驗證沒過就會退回）；`todo done` 不要求使用者先按過「做完了」，使用者在聊天說做完了也可以用，規則要求 first mate 先驗證。

### C47　帳本大到一次讀不完時，讀取整個失敗

彙整腳本用 `tail … | head -c` 取帳本的一段。`head` 拿夠了就關掉管線，`tail` 還在寫就被 SIGPIPE 結束，`pipefail` 把這當成失敗，整次讀取沒有輸出。Linux 上要帳本比一段大很多（實測 40 MB）才碰得到，macOS 的 `tail` 在 600 KB 就碰到：first mate 在 Mac 上跑第一段的測試時發現（2026-11-17）。**修正**：取那一段的 `tail` 被中途關掉不算失敗。新增一個 8 MB 帳本的測試，在 Linux 上也會重現原本的失敗。

### C48　bash 3.2 把變數後面的中文字當成變數名稱

macOS 內建的 `/bin/bash` 是 3.2。在雙引號裡寫 `"$name：新增"` 這種「變數後面直接接非 ASCII 字元」的字串時，3.2 會把後面那個字的位元組讀成變數名稱的一部分，在 `set -u` 之下以 unbound variable 結束。`bin/fm-topic.sh` 有 18 處，多半是錯誤訊息與 `install-rules` 的輸出，所以每一段測試都早早失敗。主 first mate 第一次真的用 3.2 跑測試時發現（2026-11-17）；之前在 Mac 上的結果其實是 `PATH` 上的 bash 5.3 跑的。**修正**：這些地方一律寫成 `${name}`。Linux 上重現不了這個失敗，所以第一段多一個測試檢查三支指令裡沒有這種寫法。修正之後在 3.2 上的結果見 [handover](handover.markdown) 第 3 節。

### C49　沒標議題的排隊項目在看板上看不到

排隊中的工作只列在它的議題頁（C38）。first mate 把工作放進 backlog 卻忘了標議題時，這件事在排隊，看板上卻哪裡都找不到。使用者 2026-11-17 決定要顯示。**做法**：首頁「未分類」區的最後多一個預設摺起來的清單「沒標議題的排隊項目 N」，每一列和議題頁的排隊清單相同（task、標題、home、在等什麼）。沒有議題的 captain hold 也是排隊中的項目，但它已經有自己的卡片，不重複列。只顯示，不能在頁面上標議題。

### C50　來歷紀錄查不出原因，也看不出是誰做的

議題看起來不對勁時，使用者會請一個 agent 查發生過什麼事（使用者 2026-11-17：這個功能主要是除錯用，不是每天看的）。原本的來歷只有「什麼時候、發生什麼」：為什麼合併或拆分沒有記；是使用者在頁面上做的還是 first mate 下指令做的，要交叉比對議題檔、事件檔與稽核紀錄才看得出來；`find` 每個議題只印最近八筆。**做法**：

- `merge` 與 `split` 可以帶 `--reason <一行>`，記進那一筆來歷。不強制：還在用舊規則的 home 不帶也能跑。
- 封存的那一筆自動帶上它之前的關閉提議的原因（有的話）。
- 每一筆來歷記 `by`：`page`（看板頁面）或 `command`（socket，也就是 `fm-topic.sh`）。
- `find` 的每一行在句尾用括號寫出這兩件事，例如「（用指令；原因：太寬）」；沒有記的舊紀錄沒有括號。
- `find --all <關鍵字>`：不限議題數與筆數，時間印到秒。平常的 `find` 維持原本的上限，並提示可以加 `--all`。
- 重複的拆分（同一個來源與名稱）不管帶不帶原因都不再記一筆。
- 不記拖曳排序之類頻繁的操作：議題檔每次存檔都整個重寫。
- 規則範本升到 v6：`find` 那句提到 `--all`，`split` 那句要求 `split` 與 `merge` 都寫 `--reason`。三個範本合計約 1396 token，測試的上限調到 1450。

沒有做的：`find <議題>` 列出搬過的 task（使用者同意不做）。

### C51　轉交給 secondmate 的項目在派工前顯示成沒標議題

first mate 把項目轉交給 secondmate 時，議題標記留在主 home；secondmate 的 home 要到它派工、照共用規則標上議題之後才有標記。中間這段，看板把這個排隊中的項目當成沒有議題，C49 的清單會誤報。主 first mate 在真的 home 與遠端 home 上實測時發現（2026-11-17）。主 home 的規則本來就要求轉交的項目內文帶一行 `topic: <議題 id>`。**修正**：彙整腳本的 `queued[]` 多一個 `topic_hint`，取內文裡那一行的 id；排隊中的項目沒有標記時，用它決定議題（一樣走合併表，議題要是已確認或已封存）。有標記時以標記為準。只用在排隊中的項目，已經派工的照舊只看標記。

### C52　新議題等使用者確認才進佇列

first mate 用 `propose` 開的議題停在提議中，要等使用者在頁面上或用 `confirm` 確認才進佇列，規則也叫 first mate 等確認之後才 `tag`。
使用者 2026-11-18 決定：新議題不等決定，直接接在優先順序佇列的最後；佇列預設是中間的「一般」，只有使用者說了或明顯指出別的佇列時才放別處；而且要由看板的設計保證，不能靠 first mate 記得規則。
**做法**：

- `propose` 與 `confirm` 換成 `create <名稱> --goal <一行> [--id <id>] [--queue high|normal|later]`：服務建立一個已確認的議題，排在佇列最後。
  沒有 `--queue` 就是 `normal`；看板不從名稱或目標推斷佇列。
  沒封存的議題裡已有名稱與目標都相同的就是同一個議題，重做只印它的 id 與所在的佇列，不建第二個、不搬位置，帶了別的 `--queue` 也一樣。
- 提議中的狀態整個拿掉：socket 的 `propose`、`confirm`，瀏覽器的 `POST /api/topics/confirm`，頁面未分類區的提議卡（確認、改選佇列、「不採用」），議題頁的「提議中」與「不採用」，`topics.json` 的 `suggested_queue` 與 `proposed_by`，以及頁面確認議題時給 first mate 的通知（C44）。
  `split` 與 `reopen` 本來就直接放進佇列，不受影響；頁面不能建立議題，所以沒有別的地方會產生提議。
  `status` 欄位留著、一律寫 `confirmed`，退回舊版時舊程式照樣讀得懂。
- 還在跑的看板裡可能已經有提議中的議題。新版的服務啟動時把它們照建立時間排到提議時的佇列（`suggested_queue`，沒有就是一般）最後，立刻寫回 `topics.json`，每一個記一筆 `topic.confirmed` 系統紀錄，並送一則 note 給主 first mate（它可能還在等確認）。
  封存檔裡被「不採用」的提議只把狀態改成 `confirmed`，仍然留在封存。
  不用手動做什麼：看板在下一個議題指令發現程式的 commit 變了就換成新版（contracts 第 11.3 節），換的那一次就完成；之後的啟動什麼都不改。
  議題、`merged` 表、來歷與各 home 的標記檔都不動，標到提議的 task 之後就歸在那個議題底下。
- `fm-topic.sh` 不經服務的指令（`tag`、`list`、`order`）把 `topics` 裡的每一個議題都當成看板上的議題，所以還沒換到新版服務之前，舊的提議也可以 `tag`；`list` 把它列成不在佇列裡的議題。
- `propose`、`confirm` 回用法錯（exit 2），訊息指向 `create`：真的 home 在重跑 `install-rules` 之前，規則還是 v6，會叫 first mate 跑 `propose`。
- 主 home 規則範本升到 v7：那一句改成「沒有合適的就跑 `create` 建一個再 `tag`；我指定佇列才加 `--queue`」，只在我明講時才跑的清單拿掉 `confirm`。
  三個範本合計仍是約 1445 token，上限 1450 不變。
  真的 home 要由使用者明講之後重跑 `install-rules`。

### C53　未分類區列出不是工作的紀錄與已經結束的工作

使用者 2026-11-18 看到未分類區有六項，問這些是什麼、為什麼還在等歸併。
四項是已經結束的工作，標記寫的是自己的 task id，看板上沒有那個議題：是 secondmate 在自己的 home 裡 `tag` 的，那裡當時只檢查 id 的格式（後來也檢查了，見這一條做法的最後一點）。
另外兩項根本不是工作：一個退役的 secondmate（主 home 帳本裡 task 是 mate 自己的 id、派工的 `kind` 是 secondmate），和遠端 secondmate 的回報通道 `parent-replies`（上游把遠端 home 的 `state/parent-replies.status` 當成回報通道，帳本照樣把它記成狀態行）。
看板原本把 home 已經沒有、帳本裡有事件的每一個 (home, task) 都列成已結束的 agent，所以兩種都進了未分類區。
還在跑的 secondmate 自己的 `needs-decision` 行也會被當成 worker 提問。
**做法**（已結束的部分由主 first mate 2026-11-18 依這裡的證據定為選項 B，隨 PR 一起審）：

- 什麼算 agent 寫在 [contracts](contracts.markdown) 第 1 節：home 已經沒有的 task，帳本要記過它的 worker 生命週期，而且最近一次派工不是 secondmate。
  判斷用的是帳本事件的種類與派工的 `kind`，不是名單。
  它只會漏掉有確切證據不是工作的紀錄：home 還有紀錄的 task 照舊列出，排隊中的項目來自 backlog，都不受影響。
  剩下的缺口：帳本關著時派出、之後沒有經過收掉就從 home 消失的 task，只有狀態行，會被當成不是工作；它的事件仍在更新裡。
  反過來，帳本開之前派出的 secondmate 退役後只有收掉那一筆，會被當成工作而顯示出來。
- 不是工作的紀錄不列為 agent，哪裡都不列（未分類區、議題頁的關聯 agent、議題卡的計數）。
  它們的帳本事件、標記檔、看板的事件檔都不動；事件仍在 `/api/state` 的更新裡，有標記的照標記顯示在那個議題的更新區。
- `kind` 是 secondmate 的 task 的 `needs-decision` 行不算 worker 提問；它轉達的 captain hold 本來就以那個 home 的待決事項出現。
- 未分類區只放還需要一個議題的東西；已經結束、沒有有效標記的 agent 與它們的摘要，摺在最後的「已結束、沒標議題 N」，預設收合，仍可「歸併到…」（[stage-5-browser](stage-5-browser.markdown)）。
  沒有選「整個拿掉」：沒有議題的更新在頁面上哪裡都看不到，歸併是唯一把來歷放回議題的地方；而且標記寫錯的工作一結束就看不到，這次的四項就是那個樣子。
- 已經在跑的看板：不用手動做什麼。
  看板在下一個議題指令發現程式的 commit 變了就換成新版（contracts 第 11.3 節）；看板狀態每次都從事件檔與各 home 的標記重算，所以換上之後立刻照新規則顯示，沒有要搬的資料。
  標在不是工作的紀錄上的標記留在檔裡，只影響那些事件歸在哪個議題的更新區。
- 標記寫了不存在的議題：主 home 的 `tag` 本來就擋；`--in-home <id> tag` 改成先在主 home 檢查，再寫進 secondmate 的 home。
  secondmate 自己跑的 `tag` 與經 `fm-on.sh` 跑的 `tag` 讀不到主 home 的議題檔，仍只檢查格式；這種項目在頁面上寫「標記的議題不存在」，與「沒有標記」分開。
  要在那裡也擋下，需要讓 secondmate 讀得到主 home 的議題清單，另案處理。
  後來已修：secondmate 的 `tag` 照 `fm-dispatch-plan.sh order` 讀的那一份主 home 議題清單檢查，讀不到時照寫並說沒有檢查；`tag <新 id> --from <舊 id>` 沿用的議題也照同一套檢查（[fm-board adapter](../../fm-board/spec/adapter.markdown) 第 3.4 節）。

### C54　「要你動手」的卡片把說明當成指令，沒有指令時也分不出來

使用者 2026-11-18 看到卡片有時根本沒有要複製的字，卻還是有「複製指令」按鈕，要一個更通用的設計。
`todo add` 原本把 stdin 第一行之後的全部當成一個指令：真的 home 上 `nas-2fa` 的第二行是一句說明（只在你人在電腦前時做。），卡片把它當成指令讓人複製；`router-port-check` 根本沒有指令要跑，格式卻沒辦法說「沒有指令」或「這是說明」。
**做法**：

- 一個項目有要做什麼（一行，必填）、說明（可不填）與零到多個指令。
  每個指令自己一塊、自己一個「複製指令」按鈕，只複製那一個指令；說明是一般文字，沒有按鈕；沒有指令的項目沒有指令框，也沒有按鈕。
- 輸入改成 `todo add <task-id> <標題> --topic <議題 id> --do <一行> [--note <說明>] [--cmd <指令>]…`，每一部分是自己的參數，不從行的樣子猜。
  多行的指令（here-document、行尾的 `\`）整段放進同一個 `--cmd`，例如 `--cmd "$(cat <<'EOF' … EOF)"`。
  沒有選 stdin 加標籤行的寫法：標籤寫在內容裡，here-document 裡剛好以標籤開頭的一行會被讀成新的一段，沒辦法拒絕。
- 拒絕、印出正確用法的（exit 2）：舊的 `-`（stdin）寫法；沒有 `--do`、兩個 `--do`、`--do` 有好幾行；兩個 `--note`；空的 `--do`、`--note`、`--cmd`；不認得的參數。
  舊的寫法沒辦法照原意保留：第一行之後哪些是說明、哪些是指令，只有寫的人知道，所以一律拒絕，不重新解讀。
  還沒重跑 `install-rules` 的 home 照 v7 的規則跑 `-`，會看到新的用法。
- hold 的原因第一行之後每一行都帶標籤（`說明：`、`指令：`、`續：`，[contracts](contracts.markdown) 第 1 節）。
  分辨新舊紀錄靠的就是這一點：有任何一行沒有標籤，就是之前寫的，照以前顯示（第一行之後全部當成一個指令）。
  所以 `router-port-check` 這種只有一行的舊紀錄沒有指令框，`nas-2fa` 那句說明仍是一個指令框；要分開就照新的寫法重跑 `todo add`。
  舊紀錄不用手動處理，也不改寫。
  做不到的：舊紀錄第一行之後的每一行剛好都以這三個標籤之一開頭時，會被當成新紀錄讀；標籤寫在內容裡，這是分不出來的。
  舊的 `todo add` 從來不寫標籤，只有手寫的原因才可能這樣。
- 已經在跑的看板：`todo add` 寫入之前先確定服務跑的是現在的程式（和 `open` 一樣，程式版本不同就換掉），所以舊程式不會把帶標籤的文字當成一個指令顯示。
  因此 `todo add` 需要看板服務；服務起不來時什麼都不寫（exit 69）。
  在換版之前就開著的分頁跑的是舊的頁面程式，它讀不到新的欄位，每一張「要你動手」卡片都會多一個空的指令框和一個沒有東西可複製的按鈕，連只有一行的項目也是；重新整理一次就好。
  沒有為舊分頁多送舊的欄位：那是只為了過渡而留的第二條路。
- 項目上的狀態（做完了、驗證沒過、不再需要）記在 `topics.json` 的 `todos`，鍵是 task id，這次沒有改；舊紀錄與新紀錄都照原樣保留。
- 主 home 規則範本升到 v8：`todo add` 那一句改成新的參數，「（看板會通知你）」拿掉（通知本身會說要跑什麼）。
  三個範本合計約 1442 token，上限 1450 不變。
  真的 home 要由使用者明講之後重跑 `install-rules`。

### C55　議題卡上的「移到…」選單

使用者 2026-11-18：佇列裡的議題卡不需要移到別的佇列的下拉選單，用拖的就好。
這個選單是 5-1 定下的鍵盤可用的後備（[stage-5-browser](stage-5-browser.markdown)），可以把卡片放到三個佇列任一個的最前或最後。
**做法**：

- 卡片上的選單整個拿掉，連同它的處理函式與頁面上只有它用到的回饋分支。
  樣式 `select.auto` 留著，「歸併到…」與「併入其他議題…」的選單還在用。
- 選單的每一種移法都有對應的拖法，`stage-5-page.sh` 逐一用拖的驗過。
  拖到一張卡的上半部放在它前面，所以拖到第一張卡的上半部就是最前；拖到最後一張卡的下半部或放在佇列上卡片以外的地方就是最後；空的佇列放在佇列上。
  三個佇列都驗了最前與最後，包括拖進與拖出「待辦」、拖進空的佇列、同一個佇列裡換位置。
- 服務端不動：`POST /api/topics/move` 仍然收 `first: true`，和 `fm-topic.sh move --first` 走同一個函式；頁面不再送它。
- 拿掉之後頁面上沒有鍵盤可用的移法，原生拖放不能用的瀏覽器也沒有後備（Chrome 還沒驗，[handover](handover.markdown) 第 3 節）。
  這兩種情況改用 `bin/fm-topic.sh move <id> <佇列> [--before <id> | --first]`。

### C56　看板的指令不再用 first mate 的函式庫（B1）

使用者對看板與 first mate 要分開到什麼程度選了 B：看板是使用者派工的方式和 agent 之間的轉接層，另一頭可以是任何 agent，看板的後端也不能依賴 first mate。
這是分成四個 PR 做的第一個：指令分開、轉接指令、規則搬家；餵資料與頁面動作的契約、看板自己存「要你動手」的項目、以 aggregator 自己的名字接上，是之後的三個。
**做法**：

- `bin/fm-topic.sh` 只留看板自己的子命令，只 source `fm-topic-lib.sh`；它不 source 任何 first mate 的函式庫。
- 讀寫 first mate 檔的子命令搬到 first mate 這一側：`tag`、`setup`、帶 task 的 `split`、`--in-home`、`install-rules` 與 `status` 的規則那一行到 `bin/fm-board.sh`（`rules`），`order` 原樣搬到 `bin/fm-dispatch-plan.sh`；規則範本與它們的測試到 `fm-board/`（[adapter](../../fm-board/spec/adapter.markdown)）。
- 舊的寫法回 2，一行指出新的指令；不轉送，也沒有第二條路。
- 原本擋 secondmate home 的檢查讀的是 first mate 的標記檔，換成看板自己的：除了 `open`，沒有 `state/topic-board/token` 的 home 一律拒絕。
  全新的 home 要先 `open` 才能 `create`；`open` 在 secondmate 的 home 不再被拒絕，這一點留作已知限制（handover 第 4 節）。
- 看板服務的白名單 W5、W7、W8、W9 改跑 `fm-board.sh`；帳本未開的提示也改成 `fm-board.sh setup`。
  缺編譯結果時的錯誤不再叫人跑 `/updatefirstmate`。
- `todo add` 與 `todo done` 在看板自己存這些項目之前（B3）仍執行四個 first mate 的指令，只執行、不 source。
- 主 home 規則範本升到 v9、共用的升到 v3：指令名稱換成新的，`order` 那一句多一句「看板通知議題可派時也重新評估」。
  為了留在 1450 token 的上限內（約 1445），拿掉了 `split` 那一句的「中途失敗就原樣再跑一次」（指令失敗時自己會這樣說）、第一行的「fork 裡的」，與兩處 `bin/`。
  真的 home 要由使用者明講之後在主 home 重跑 `bin/fm-board.sh install-rules`。
- 新的第七段從只有看板自己的檔的副本跑看板：乾淨的環境、只有系統目錄的 `PATH`、每支其他 first mate 腳本的絆線，以及升級時跑著的看板不需要任何手動步驟。

### C57　看板的執行期名稱改成 myshape

使用者對看板的執行期名稱選了 C：看板自己擁有的名字一律改成 `myshape`，之後看板搬到自己的 repository（`guybeju/myshape`）時就是最後的名字。
這一條在 B1 之後、B2 之前，單獨一個 PR。
**做法**：

- 改名的規則：看板自己的名字改成 `myshape`；first mate 自己的名字不改（`fm-board.sh`、`fm-board-lib.sh`、`fm-board/`、`fm-dispatch-plan.sh`、`dispatch-plan/`、`state/fm-board/`、讀取腳本 `fm-topic-board-read.sh`、開 session 的 `fm-topic-session-start.sh`）；領域的詞（議題、待辦、`data/topics.json`、`data/<task>/topic`、`topic:` 那一行、`--topic`、`topic.*` 事件、頁面標題「議題看板」）與內部的識別字（`tb_`、`tb-`）不改；已經寫進紀錄的字串照原樣留著，除非程式還會比對它。
- 對照表（左邊是改名前）：

  | 改名前 | 改名後 |
  | --- | --- |
  | `topic-board/` | `myshape/` |
  | `bin/fm-topic.sh`、`bin/fm-topic-lib.sh` | `bin/myshape.sh`、`bin/myshape-lib.sh` |
  | 套件 `firstmate-topic-board` | `myshape` |
  | `state/topic-board/`、`data/topic-board/` | `state/myshape/`、`data/myshape/` |
  | `config/topic-board-port` | `config/myshape-port` |
  | `FM_TOPIC_BOARD_TEST`、`FM_TOPIC_BOARD_<X>_MS` | `MYSHAPE_TEST`、`MYSHAPE_<X>_MS` |
  | 頁面的 sessionStorage `topic-board-token` | `myshape-token` |
  | `--source topic-board`（「Captain answered this call through topic-board.」） | `--source myshape`；舊紀錄照原樣留著 |
  | 規則標記 `<!-- topic-board:begin` 與 `<!-- topic-board:end -->`（主 v9、共用 v3） | `<!-- myshape:begin` 與 `<!-- myshape:end -->`（主 v10、共用 v4） |
  | 看板自己下的 hold 的開頭 `topic-board：` | `看板佇列：`（沒有產品名稱，之後再改名也不用動） |
  | `state/topic-board/rules-backup/` | `state/fm-board/rules-backup/`（B1 起新的備份已經放這裡） |

- 舊的名字不讀：有看板資料的 home 更新到這一版之後，只要還有改名前的路徑而新名字不在，看板的每個子命令都回 69，指向 `bin/fm-board.sh migrate-myshape`，排在「先跑 open」那一層檢查之前。
  `migrate-myshape` 是 first mate 這一側的一次性指令，停掉舊服務、搬目錄、核對校驗碼、換規則、改 hold 的開頭、清 checkout、重新打開看板；`--check` 只看不寫，`--undo` 照紀錄還原。
- 搬家期間的過渡：開 session 的那一行、留在 `bin/fm-topic.sh` 的提示（舊的六種寫法指向 `fm-board.sh` 或 `fm-dispatch-plan.sh`，其他指向 `bin/myshape.sh`）、`order` 對舊開頭的警告、安裝規則與 `rules` 認得舊標記、根目錄 `.gitignore` 的 `/topic-board/`。
  每個 home 都搬完之後，這些過渡的東西在拆分 repository 前的準備 PR 裡一起拿掉。

### C58　看板的改動可以不留紀錄

使用者 2026-11-20：`archer-openwrt` 議題頁看不到任何一張卡被開、被回答的痕跡；可追蹤是這個設計重要的指標，要看板的設計強制存下紀錄。
查到的（設計報告 `todo-history-trace-design` 第 1 節，在 B3 之後重新盤點）：一個改動可以不帶紀錄就回來（「先不關」、`todo adopt-done` 清掉的舊狀態、啟動時確認的封存提議、第一次啟動帶過來的狀態都沒有紀錄）；改動先存檔、紀錄後寫，中間當掉或寫不進去就只有改動；存下的紀錄在整個 fleet 寫滿 2000 筆更新之後從頁面上掉出去。
使用者選了分兩步：B3 先把「要你動手」每一步記下來（guybeju/firstmate#61），這一條是第二步，在 B4 之前。
**做法**：

- 型別：改動的結果一定帶至少一筆紀錄（`records.ts`、`topics.ts`、`todos.ts`），不帶就編譯不過；說「沒有改」的結果交回的狀態要和原本一樣，不然看板直接報錯。
- 只有一個寫狀態檔的地方：`store.ts` 的 `commitChange`。每個改動經一個檔存（議題是 `topics.json`，要你動手是 `todos.json`），紀錄和改動放在那個檔的 `outbox`、同一次改名存下，再追加到 `events.jsonl` 並 fsync；之前沒寫進去的紀錄先補寫，補不進去就拒絕這次改動；啟動時補寫 `events.jsonl` 還沒有的。紀錄帶 `rid` 去重，帶 `by`（`captain`、`aggregator`、`board`）與 `label`（[contracts](contracts.markdown) 第 3.3 節）。
- 改動看板的操作都在 `ops.ts` 的一張表裡，socket 與頁面都只經它；頁面寫入送到之後的紀錄由一張涵蓋每一種寫入的對照表決定，作答時待決事項已在別處結束寫 `hold.closed`。
- 頁面：看板保留每一筆系統紀錄，帳本事件每個議題留最新 500 筆；議題頁的「要你動手」下有摺起來的「已關 N」，每一個關掉的項目一行，打開是它的每一步；帳本與摘要超過 200 筆的摺進「更早的更新 N」；用指令做的歸併從標記檔算出一行「歸到「X」（first mate 用指令）」。
- 防呆：`ops.test.ts` 把表裡每個操作跑一次、沒有紀錄就失敗，新操作沒有測試資料就編譯不過；`storage.test.ts` 逐列測當掉的各種時間點；`check-state-writers.sh` 檢查只有 `commitChange` 寫狀態檔；`stage-1-topic.sh` 檢查 `myshape.sh` 的每個寫入都交給看板；`stage-5-http.sh` 把每個 socket 操作與頁面路由各送一次，核對紀錄。
- 不在這一條：待決事項從讀取資料記下的開與關（`hold.opened`、`closed_holds`）、`fm-captain-hold.sh` 與讀取契約的修改、補記修好之前已經關掉的項目（使用者選了不補），各是之後的工作。
- 回不去的：舊版程式存檔時丟掉 `outbox`，只有最後一次改動的紀錄剛好也沒寫進 `events.jsonl` 時才會少一筆；已經寫進去的紀錄舊版照樣當文字顯示。

### C59　在頁面之外開、關的待決事項沒有留下紀錄

使用者 2026-11-21：`archer-openwrt` 議題頁還是看不到任何一張卡被開、被回答的痕跡；可追蹤是重要的指標，要看板的設計強制存下紀錄。
C58 之後看板只記得在頁面上答的；在聊天裡答、first mate 自己開或收的待決事項，看板只在讀到的 `holds[]` 裡看到它出現或不見。
使用者在三個做法裡選了 C（設計報告 `todo-history-trace-design` 第 2.7 節，A、B、C 一個疊一個），並接受多一個要跟上游合併的例外；修好之前已經關掉的不補記（選了 B）。
**做法**：

- 讀取腳本多報 `holds[].hold_set`、`closed_holds[]` 與 `closed_cursor`（[contracts](contracts.markdown) 第 4 節的 C12、C13）；`closed_holds[]` 讀 backlog 裡每一筆的 Resolution 紀錄，加上游標之後搬進封存的。
- `bin/fm-captain-hold.sh` 每次 hold、作答、放行在 `state/captain-hold-events.jsonl` 寫一行確切的時間（contracts 第 2 節的第三個例外）。
- 看板讀到新的 hold 寫 `hold.opened`、讀到新的已關待決事項寫 `hold.closed`，經 `commitChange` 存，帶 `key` 只寫一次；`data/myshape/decisions.json` 記每個 home 上一次看到的，第一次讀到一個 home 時什麼都不記（第 3.3、3.7 節）。
- 一個待決事項一筆開啟、一筆關閉：在看板作答的，關閉是看板送到時寫的 `hold.answered`，讀取資料裡 `source` 是 `myshape` 的那一筆不另寫；那個作答還在送出時先等，看板沒有它的紀錄時照一般的關閉寫。
- 防呆：`decisions.test.ts`、`stage-1-feed.sh` 的 `test_closed_decisions`、`stage-5-http.sh` 的 `test_decisions_open_and_close_once`、`stage-7-upgrade.sh` 的從前一版升上來與退回去、`check-state-writers.sh` 檢查 `decisions.json` 只有 `decisions.ts` 寫、紀錄只經 `saveRecords`。
- 還看不到的列在 [handover](handover.markdown) 第 4 節。

### C60　aggregator 用自己的名字接上看板（B4）

看板執行的程式寫死成 `bin/fm-board.sh`，別的 aggregator 只能冒用這個名字；設計報告 `board-interface-design` 的 B4。
使用者在兩個決定裡選了：B，看板執行設定檔登記的程式並在頁面上確認，照 security 的五個條件做；`carry` 留一份釘住版本的看板程式在現在的路徑（拆 repository 之後）。
**做法**（[contracts](contracts.markdown) 第 3、7、8 節）：

- 設定檔 `config/myshape-aggregator.json` 只寫名稱與兩個路徑，`feed`、`deliver` 由看板加上；陣列、參數、多的鍵都不能用。
- 不用確認的只有 code root 的 `bin/` 底下、git 追蹤而且和 HEAD 相同的程式，由 `bin/myshape.sh` 每次啟動或換掉服務時用 git 查好交給服務；這是和今天一樣的門檻，不是「審過」。
- 其他程式要在頁面上兩步確認，確認綁程式與設定檔內容的 SHA-256，每次執行前重算；確認紀錄 `data/myshape/confirmations.json` 只由頁面的確認寫，經 `commitChange`，帶 `program.confirmed`。
- 每支程式都要是一般檔、可執行、不是符號連結、擁有者是執行看板的帳號、別的帳號不能寫；群組能寫只有不用確認的可以，要確認的一律拒絕並寫出檔名與權限。
- 程式只拿到 `MYSHAPE_HOME`、`PATH`（只留絕對路徑）、`HOME`、`LANG`、`TMPDIR`；名稱固定，值是啟動看板的人給的。
- 寫入在 deliver 的程式不能執行時等著，在啟動、確認 deliver 的程式、每次讀好根 home 之後、與任何新寫入之前依序放行，每次放行存一筆 `writes.released`。
- 看板改版之前（B2）的稽核紀錄不再換算：讀到就略過，不接著送、不顯示。
- first mate 這一側：一個函式寫設定檔，`fm-board.sh setup`、新的 `bind`、`tag`、`split`、`adopt` 與 session start 都經它；後四個只在用看板的 home 少了它時寫並印一行，session start 另換掉沒有設定檔就啟動的看板（使用者在更新的空檔上選了 D）。看板自己跑的 `feed`、`deliver` 不寫；路徑上已經有的檔不換掉，所以放一個空檔就是一直不接的做法。
- 防呆：`binding.test.ts`、`commands.test.ts`、`sending.test.ts`、`ops.test.ts` 的 `program-confirm`、`check-state-writers.sh` 的 `confirmations.json`、`stage-5-http.sh` 的確認路由、`stage-7-aggregator.sh` 的 AT9、`stage-7-upgrade.sh` 的 B3 到 B4、`fm-board/test/stage-4-binding.sh`。
- `FM_ROOT_OVERRIDE` 的實體路徑不是 `bin/myshape.sh` 自己的位置，或進不去、解析不出來時，沒有程式不用確認（B4 之後補上，security 的建議）；防呆是 `stage-7-aggregator.sh` 的 `test_bind_an_override_keeps_the_exemption_only_for_the_own_location`。
- session start 每次替 home 寫了設定檔都印 `看板服務：已接上 firstmate，換上新的看板`，看板原本沒在跑、沒有回應或啟動失敗時也印（B4 之後補上，D 的第三個條件）；防呆是 `fm-board/test/stage-4-binding.sh`。
- 不在這一條：拆 repository。

### C61　已關的待決事項、沒有議題的已關項目、更新空檔的開啟

C58、C59 合併時留下的三個後續（guybeju/firstmate#63、guybeju/firstmate#64 的 PR 說明），使用者 2026-11-22 各選了 A：

- 議題頁：已關的待決事項摺進「待決」最後的「已關 N」，和「要你動手」的一樣；紀錄不變，照樣也在「更新」裡（[stage-5-browser](stage-5-browser.markdown)）。關了的是有 `hold.answered` 或 `hold.closed` 紀錄的；同一個待決事項的兩筆關閉（頁面的「已在別處結束」與讀取資料的真正關閉）算一個，關閉之後的新 `hold.opened` 是下一輪。
- 首頁：沒有議題、已關的要你動手項目放在「要你動手」下面的「沒有議題」，摺成「已關 N」，沒有時整段不顯示。放的位置使用者選了 C（一段叫「沒有議題」的），沒有選放進「要你動手」或「未分類」。
- 讀取程式的 `code_commit` 換了不再重新開始：看板接著上一次成功讀取時記下的比，開著的 hold 這一次只以 task 認，而且只有 `hold_set` 不早於 `decisions.json` 記下的 `seen_at` 的才寫開啟，所以更新前後的空檔裡開的待決事項有開啟，之前就開著的、只是新的讀取程式才報出來的（guybeju/firstmate#68 之後主 home 的 `動手：` hold）都不寫（[contracts](contracts.markdown) 第 3.3、3.7 節）。照舊不寫開啟的：同一個 task 在空檔裡關掉又重新 hold 的新的一輪；`hold_set` 不是確切時間的；換上這一版的那一次（較舊的看板沒記下 `seen_at`）。
- 都只改顯示與讀取的比對：沒有新的操作、不改存的資料與 `commitChange`。
- 防呆：`view.test.ts` 的 closed decisions、`decisions.test.ts` 的 across a change of the reader's code、`poller.test.ts`（換程式時失敗的讀取不交出去）、`stage-5-page.mjs`（兩個摺疊）、`stage-7-upgrade.sh` 從 `cbe6e42a` 升上來的那一步。

### C28　使用者的 ub-mode 與全域規範裡沒有做到的

- 測試不是每一步都先寫：第一段與之後的修正是測試先行；第二段起多半是程式與測試一起寫，再用測試把問題找出來（找到的都記在上面）。單元測試是全部寫完之後才補的。
- CRAP 的關卡只有函式庫模組過。進入點 `board-server.ts`、`board-client.ts` 與 `src/page/` 沒有單元測試（它們由 Bash 與瀏覽器的整合測試覆蓋，那些測試跑的是編譯後的檔，覆蓋率工具看不到），共 92 個函式在關卡之外。
- mutation testing 涵蓋 15 個函式庫模組，剩一個存活的突變：輪詢器裡「到期時間等於現在」的邊界（`<=` 換成 `<`），差別是晚一個 250 毫秒的 tick，沒有為它寫測試。
- 超過 100 字元的行還有幾十行，都是格式化工具不會折的字串（多半是中文訊息）。
- Bash 腳本的函式長度與複雜度沒有用工具量。
