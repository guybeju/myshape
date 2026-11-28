# 第五段：瀏覽器通道與頁面

做完之後：`bin/myshape.sh open` 印出的網址打得開看板，四塊功能（看板與更新、待決佇列、輸入框、拖曳優先級）都能用。

版面的依據是原型的變體 C（規劃目錄裡的 `prototype/board-prototype.html`，用 `?variant=C` 開；它是單一 HTML、假資料）。實作這一段的 PR 把那個檔複製成 `myshape/test/prototype-variant-c.html` 當對照，不被服務提供。

## 先驗再做

| # | 要驗的事 | 怎麼驗 | 假設不成立時 |
| --- | --- | --- | --- |
| 5-1 | 原生拖放在使用者實際用的瀏覽器上可用。原型只由使用者在 Firefox 試過 | 用 Chrome 與 Firefox 各開一次原型的變體 C，拖一張卡跨佇列、按 Esc 取消 | 頁面上沒有拖曳以外的移法（C55 拿掉了卡片上的「移到…」選單）；那個瀏覽器上改用 `bin/myshape.sh move` |
| 5-2 | 議題很多時側欄的表現（原型只有五個議題） | 用 40 個假議題開原型 | 側欄各佇列內部可捲動，佇列標題固定 |
| 5-3 | 「看板服務沒有回應」與「帳本未開」兩個情境的畫面（原型有做，沒人看過截圖） | 用 `?variant=C&scene=down` 與 `scene=noledger` 開原型，截圖貼進 PR | 版面有問題就在這一段調，不必回頭開票 |
| 5-4 | 惡意網頁打不進來 | 驗收第 2 條的那組 `curl` | 任何一條沒被擋就是這一段的 bug，不能合併 |

5-1 到 5-3 都是這一段開工時就能做的。

實作時（2026-11-16）的結果：

- 這台只有 Firefox（154，snap 版），沒有 Chrome；5-1 的 Chrome 部分仍未驗。
- 頁面用無頭 Firefox 加 WebDriver BiDi 從頭到尾走過一遍（`fm-board/test/stage-5-page.sh`）：作答、確認提議、併入、拖曳、改名、送訊息、直送、封存與重開、服務停掉時的紅色橫幅與自動恢復，都通過。
- 拖曳在這個測試裡用的是程式送出的 `dragstart`、`dragover`、`drop`、`dragend` 事件，驗到的是頁面自己的處理邏輯（即時換位、落點、沒放下就還原）。作業系統層級真的用滑鼠拖，仍要人手試一次。
- 手指的拖曳（2026-11-28 加的）由 `test/stage-7-page.mjs` 在 390 px、觸控螢幕（`TB_POINTER=coarse`）下用 WebDriver BiDi 的觸控動作走：一次清單內改順序、一次放到「待辦」分段鈕，各和同一個移動的滑鼠拖曳比對送出的內容。真的手機上仍要使用者試一次。
- 5-2（很多議題時的側欄）用「每個佇列內部可捲動」處理，還沒有用 40 個議題實際看過。
- snap 版 Firefox 讀不到家目錄下的隱藏資料夾，測試工具把暫時的設定檔放在 `~/tb-firefox-tmp-<pid>-*`，跑完就刪；收到 SIGINT、SIGTERM、SIGHUP 也會刪，被直接殺掉留下的由下一次執行清掉（擁有它的行程已不在）。

## 要做的事

### TCP 通道

照 [contracts](contracts.markdown) 第 6.2 節的七項檢查實作，寫成每個請求最先經過的一層。第二段綁住的埠在這一段開始提供內容。

靜態檔：`GET /` 回 `myshape/public/index.html`；`GET /assets/<檔名>` 回 `public/` 的 CSS、圖示（`icon.svg`，`index.html` 用 `<link rel="icon">` 指過去，瀏覽器就不會去要 `/favicon.ico`）與 `dist/page/` 的頁面腳本，檔名只接受 `[a-z0-9.-]+`，對照寫死的清單，不做路徑拼接。CSP 是 `default-src 'self'`，所以頁面沒有行內的 `<script>`、沒有 `<style>` 區塊、也不用 `style="…"` 屬性（這個 CSP 三種都會擋；原型大量使用 `style` 屬性，搬過來時要改成 class）。樣式全在 `board.css`；腳本需要動態改樣式時用 `element.style.x = …` 或切換 class，這不受 CSP 限制。不載入任何外部資源，不用任何前端函式庫。

### API

全部在 `/api/` 底下，都要 token。回應一律 JSON。

| 方法與路徑 | body | 作用 |
| --- | --- | --- |
| `GET /api/state?v=<boot_id>:<n>` | — | 看板狀態。沒變回 `{"changed":false}`；`boot_id` 不同回全量。每次呼叫都算「有人在看」，維持輪詢 |
| `POST /api/refresh` | `{}` | 立刻更新 |
| `POST /api/topics/move` | `{id, queue, before?}`、`{id, queue, after}` 或 `{id, queue, first: true}` | 拖曳的落點；`before`、`after` 與 `first` 都省略就是尾端。`after` 是篩選中的落點：排在那個議題正後面，只有頁面能送，socket 的 `move` 不讀它（[篩選中拖曳](drag-under-filter.markdown)） |
| `POST /api/topics/rename`、`/goal` | `{id, value}` | 改名、改目標 |
| `POST /api/topics/archive`、`/reopen` | `{id, queue?}` | 封存、重開 |
| `POST /api/topics/keep` | `{id, days?}` 或 `{id, later: true}` | 對提議關閉按「先不關」：清掉 `close_proposal`，到 `days` 天後（1 到 90，沒帶是 14）或移到待辦 |
| `POST /api/topics/merge` | `{from, into, confirm?}` | 議題併議題，兩步 |
| `POST /api/agents/tag` | `{home, task, topic}` | 歸併 agent |
| `POST /api/messages` | `{topic, text}` | 給主 first mate |
| `POST /api/direct` | `{home, task, text}` | 直送 |
| `POST /api/holds/answer` | 第一步 `{home, task, answer, label}`；第二步再加 `{confirm}`。送 `done` 還是 `release` 照 hold 記下的處理方式，請求裡的 `mode` 不看 | 作答，兩步 |
| `POST /api/todos/claim` | `{task}` | 對要你動手的項目按「做完了」：記成 `claimed` 並通知 aggregator 去驗證；項目還在。重複按不重複通知 |
| `POST /api/todos/drop`、`/takedown` | 第一步 `{task}`；第二步再加 `{confirm}` | 「不做了」與「好，撤下」，兩步：項目離開看板，議題的更新留一筆使用者的紀錄，並通知 aggregator（contracts 第 7.1 節） |
| `POST /api/writes/resend` | `{write_id, confirm?}` | 重送；結果不明的要兩步 |
| `POST /api/writes/ignore` | `{write_id}` | 忽略 |
| `POST /api/hashtags/add`、`/remove` | `{id, name}` | 在一個議題上貼、撕一個 hashtag（[contracts](contracts.markdown) 第 3.8 節） |
| `POST /api/hashtags/rename`、`/merge`、`/delete` | 第一步 `{name, to}`、`{name, into}`、`{name}`；第二步再加 `{confirm}` | 改名、併入另一個、刪掉整個 hashtag，兩步：第一步回 `topics`（會動到的議題 id），碼綁定那個清單，中間有議題貼上或撕掉它就拒絕 |
| `POST /api/hashtags/lock`、`/color` | `{name, locked}`、`{name, color}` | 上鎖解鎖、換顏色（`c1` 到 `c8`） |
| `POST /api/hashtags/settings` | 要改的設定，例如 `{per_topic_max: 6}` | hashtag 設定；任何一項不合法就都不改 |
| `POST /api/hashtags/revert` | `{rid}` | 撤回 aggregator 的一筆 hashtag 改動 |
| `POST /api/hashtags/seen` | `{}` | 「看過了」：清掉「新」與最近改動的清單 |
| `POST /api/views/save`、`/delete` | `{name, any, none, text, untagged, id?, order?}`、`{id}` | 存、刪命名視圖；同名的視圖存的是同一個。`order` 是這個視圖的卡片排列（`priority`、`newest`、`oldest`，沒帶是 `priority`，[卡片排列](card-sort.markdown)） |
| `POST /api/schedules/add`、`/edit` | `{topic, daily: true}` 或 `{topic, weekly: "mon,thu"}`，加 `at`（`HH:MM`），可加 `tz`、`lead`、`duration`（分鐘），`add` 另可加 `rt` | 使用者建立、修改排程（[contracts](contracts.markdown) 第 3.9 節）；`add` 只收在「待辦」的議題；沒寫的 `lead`、`duration` 用設定的值 |
| `POST /api/schedules/pause`、`/resume`、`/skip` | `{topic}` | 暫停、恢復、跳過下一場 |
| `POST /api/schedules/rt` | `{topic, rt}` | 設 rt：`none`、`soft-rt`、`hard-rt` |
| `POST /api/schedules/delete` | 第一步 `{topic}`；第二步再加 `{confirm}` | 刪掉排程，兩步：碼綁定議題與它現在的排程 id，議題沒有排程時第一步就拒絕 |
| `POST /api/schedules/close` | `{key, outcome, note?}` | 使用者結束開著的一場，`outcome` 是 `done` 或 `skipped`；已經送過通知的，通知 aggregator 不用準備了 |
| `POST /api/schedules/settings` | 要改的設定，例如 `{lead_min: 20}` | 排程設定；任何一項不合法、或改了會讓某筆排程同時開著兩場，就都不改 |
| `POST /api/schedules/lock` | `{topic, lock: "schedule" \| "rt", locked}` | 排程或它的 rt 上鎖、解鎖 |
| `POST /api/schedules/pause-all` | `{paused}` | 全部暫停、全部恢復 |
| `POST /api/schedules/revert` | `{rid}` | 撤回 aggregator 的一筆排程改動 |
| `POST /api/schedules/seen` | `{}` | 「看過了」：清掉最近改動的清單與「新」，也是 aggregator 建的排程的「啟用」（一次全部） |
| `POST /api/lifecycle/answer` | `{card: "idle", key: <議題 id>, days?}`、`{card: "stall", key: <議題 id 或 "-">, days?}` 或 `{card: "stall", key: <議題 id>, ask: true}` | 「沒人處理的議題」的先不關（到某天），「沒人接」的延到與〔請 <aggregator> 處理〕（[lifecycle](lifecycle.markdown) 第 3 節） |
| `POST /api/lifecycle/settings` | 要改的期限，例如 `{A3: {remind: 30, raise: 240}}`；N3 只有 `{N3: {raise: 2880}}` | 期限設定；任何一項不合法就都不改 |

議題操作和 socket 上的同名操作是同一套伺服器函式。`/api/topics/keep` 是頁面才有的（原型的「先不關」），一定帶一個選擇。`lifecycle/answer` 與 `lifecycle/settings` 也是頁面才有的。hashtag 的路由除了 `add`、`remove`，都是頁面才有的操作，socket 收到就拒絕。排程的 `settings`、`lock`、`pause-all`、`revert`、`seen` 是頁面才有的操作，socket 收到就拒絕；aggregator 的「接下」（`schedule-take`）與時鐘（`schedule-tick`）沒有頁面的路由。瀏覽器這條通道沒有 `propose`、`close-propose`、`summary`、`which`、`stop`、`restart`、`reset-token`。

錯誤回應：`{"error":"<代碼>","message":"<給人看的一行>"}`。401 是 token 不對：頁面顯示「token 已重置或無效，請在終端機重新跑 `bin/myshape.sh open`」並停止輪詢。

### 頁面

單頁，原生的 DOM 操作。每 5 秒輪詢一次 `/api/state`（分頁在背景時停）。頁面腳本用 TypeScript 寫在 `myshape/src/page/`，由同一個 `tsc` 編到 `dist/page/`，不打包。

**首頁的分頁**（版面提案 C，2026-11-28 定）：首頁分成四塊，「等你」「佇列」「動態」「更多」。

| 分頁 | 放什麼 |
| --- | --- |
| 等你 | 下面的第 1 到 3 項：要你動手、沒有議題、等你決定與沒送到 |
| 佇列 | 左側欄：用量（只在寬的畫面）、優先順序、排列、現在、三個佇列、排程、已封存 |
| 動態 | 下面的第 4 到 7 項：最近的結果、進行中、排定的、未分類區 |
| 更多 | 等確認的程式（見[contracts](contracts.markdown) 第 7、8 節）、用量（只在窄的畫面）、hashtag 那一行與它的兩個面板、排程那一行、期限設定 |

- 寬的畫面（641 px 以上）：左欄照舊是「佇列」，右欄上方是「等你」「動態」「更多」三個分頁，一次只顯示一塊。網址的分頁是「佇列」時，右欄顯示「等你」。
- 窄的畫面（640 px 以下）：四個分頁在畫面底部，一次只顯示一塊；底部列留 iPhone 的底部安全區，右下角的提示框在它上方。「佇列」上方是分段鈕「高」「一般」「待辦」「排程」，各寫張數，一次只顯示一個佇列或排程（預設「高」，只記在頁面裡）；佇列在這裡不在清單裡另外捲動。
- 選哪個分頁看寬度，只由 `board.css` 決定，頁面不看寬度：每一塊都畫一次，只有「用量」畫兩次（左欄一份、「更多」一份，每種寬度只顯示其中一份）。
- 「等你」的分頁鈕永遠帶一個數字：還沒按做完了的要你動手項目、等你決定裡排在前面的卡（不含「還有 N 個決定排隊」），與沒送到的寫入，加起來；不受篩選影響（篩掉的由下面「這個篩選之外還有」那一行說）。
- 有程式等使用者確認時，「更多」的分頁鈕帶一個紅點，那段說明在「更多」最上面。用遠端名稱打開時那段說明寫「只能在 PC 上確認」，沒有「確認…」鈕（[contracts](contracts.markdown) 第 6.2 節）。
- 進議題頁時沒有分頁，輸入框照舊黏在底部。
- 分頁記在網址的 fragment 裡，和篩選放在一起（`#/f/…&tab=queue`，「等你」不寫）；換分頁和改篩選一樣不多一筆瀏覽紀錄，所以「上一頁」照舊離開頁面。回首頁時回到原來的分頁。`tab` 的值不認得時是「等你」。

**首頁**的內容（各在哪一個分頁見上表）：

0. 篩選：頁首的「篩選」（有篩選時是「篩選中」）打開篩選面板，面板裡有視圖按鈕（「全部」、存下來的每個視圖、「（沒標）」），每個 hashtag 一個按鈕（按一下是「有」，再按是「沒有」，再按取消），一個關鍵字框，有篩選時可以「存成視圖」。hashtag 與關鍵字用「而且」合起來；關鍵字比對頁面上這個議題的所有文字（名稱、目標、議題 id、提議關閉的原因、hashtag、agent、排隊項目、待決事項、worker 提問、要你動手、摘要），卡片下寫出是哪幾欄符合。篩選只改看到什麼：首頁每一段與左側欄都只列通過的議題與它們的東西，「沒有議題」與未分類區在篩選時不列。篩選的條件在網址的 fragment（`#/f/any=…&none=…&untagged=1&text=…&view=…`，後面可以再有分頁的 `tab`），改條件不捲動、不多一筆瀏覽紀錄；回首頁時保留。沒有 fragment、或 fragment 只有 `tab` 時，用 hashtag 設定的預設視圖，預設是「全部」。窄的畫面上面板從底部拉起，在分頁列上方；按「收起」或再按「篩選」關上。
   有篩選時在分頁列下面固定顯示一行（面板關上也在）「這個篩選之外還有：等你決定 N」（有在排隊的待決事項時加「決定排隊 K」，還有要你動手的項目時加「要你動手 M」），算的是被篩掉的 live 待決事項（排隊中的另算成 K）、提議關閉與還沒做完的要你動手項目，沒有議題的也算；按一下回到「全部」。
   「更多」裡是「<aggregator 的名稱> 最近改了 N 個 hashtag」（N 是 aggregator 在上一次「看過了」之後的 hashtag 改動，沒有就不顯示）與「hashtag 設定」。前者打開是清單，每一筆有時間、那一行紀錄、議題與「撤回」（已撤回的寫「已撤回」），最後一個「看過了」。aggregator 開的 hashtag 在「看過了」之前標「新」。
   「hashtag 設定」面板：每一項設定寫出現在的值與預設值（aggregator 可以貼撕、可以開新的、開新的要不要明說是新的〔「要」或「不用」〕、一個議題最多幾個、整個看板最多幾個、aggregator 每小時最多改幾次、預設視圖）；每個 hashtag 一張卡，有幾個議題、誰開的、鎖上或解鎖、顏色，以及「改名…」「併入…」「刪掉…」，這三種走伺服器的兩步確認，第二步寫出會動到幾個議題與它們的名稱；最後是存下來的視圖，每個可以刪掉。
   顏色是 `board.css` 裡固定色票的 class（`tag c1` 到 `tag c8`），不用 `style` 屬性。
   「更多」裡再一行排程的：「所有排程暫停中」（打開時）、「<aggregator 的名稱> 最近改了 N 筆排程」（同 hashtag 的那一行：清單、每筆「撤回」、最後「看過了」，沒有就不顯示）、「排程設定」與「全部暫停」或「全部恢復」。「排程設定」面板每一項寫出現在的值與預設值（[contracts](contracts.markdown) 第 3.9 節的十四項），並說明同一筆排程不能同時開著兩場的限制。
   「更多」最後一行「期限設定」（預設收合）：每一種 aggregator 負責的狀態一列，寫出現在的提醒與交給你的期限、單位與預設值，可以改（[lifecycle](lifecycle.markdown) 第 5 節）；「請 aggregator 處理之後的「沒人接」卡」（N3）那一列只有交給你的期限，提醒寫「不適用」，上面的說明寫出為什麼。
1. 要你動手：每個開著的要你動手項目，跨議題，卡上標議題（沒有議題的標「未分類」）。狀態看板不認得的寫出原文，只有「不做了」。沒有開著的項目時整段不顯示。
2. 沒有議題：沒有議題、已經關掉的要你動手項目，摺成「已關 N」，和議題頁「要你動手」底下的一樣（預設收合，每個項目一行，打開是它的每一步）。沒有這種項目時整段不顯示（C61）。
3. 等你決定：一條佇列（[lifecycle](lifecycle.markdown) 第 4 節），由上而下：live 的待決事項（照[第三段](stage-3-data.markdown)的順序，每張卡標議題名稱與所在的 home），aggregator 的提議關閉（「關閉並封存」「先不關，到 <日期>」附天數「先不關，移到待辦」），看板的「沒人處理的議題」（一句固定的話，「關閉並封存」「先不關，到 <日期>」「移到待辦」），看板的「沒人接」卡（每個逾期的卡一行，寫出原因與從何時起；沒有議題的排隊項目那一行有「歸到…」、agent 那一行有「歸併到…」；卡上有「請 <aggregator> 處理」（議題的卡，一張卡一次）、「延到 <日期>」「移到待辦」；請過一次、期限內沒有變化又回來的卡寫「已退回過一次：<時間> 請 <aggregator> 處理過，期限內沒有變化。」，沒有「請 <aggregator> 處理」）。
   只有前面那麼多張是卡片（aggregator 的 `decisions_at_once`，沒有設時待決事項都顯示、其他三種一次一張），其他的摺成最後一行「還有 N 個決定排隊，輪到時才顯示」：不寫內容、沒有按鈕。篩選時只算通過的議題的。
   下面是「沒送到 N」：每一筆失敗、未送達、結果不明的寫入，不論議題（含已封存與沒有議題的），有「重送」與「忽略」。沒有時不顯示。
4. 最近的結果：里程碑摘要，四種都列，附議題名稱；`failed` 用卡住的顏色標出（採建議 C11）。
5. 進行中：燈號是進行中、卡住、未知的 agent，一個一列，附議題與 home。
6. 排定的：待辦佇列裡沒有排程的議題（有排程的列在左側欄的「排程」，不在這裡），加上暫緩的待決事項與原因。
7. 未分類區。

**左側欄**（「佇列」分頁）最上面是「用量」（窄的畫面上它在「更多」），然後是「優先順序」：高、一般、待辦三個佇列由上而下，「待辦」標明不自動開工。最下面是「已封存」，預設收合，展開後每個議題有「重開」。
標題下面是「排列：」三個按鈕「照優先順序」（預設）「新的在上」「舊的在上」，只改三個佇列裡的卡片怎麼列，不改優先順序；記在選了的視圖裡，沒有選視圖時記在頁面自己的 `localStorage`。決定、理由與照建立時間排時拖曳怎麼算見[卡片排列](card-sort.markdown)。

- 有排程開著一場時，「高」上面多一條「現在」：每一場一張卡，順序照看板公開的（`hard-rt`、`soft-rt`、`none`，同一級照時刻），寫議題、當地時間、狀態（快到了、到了、已接下）、rt 與看板建議的用法、aggregator 什麼時候接的與它寫的那一行、最晚什麼時候結束，以及「這一場結束…」（頁面上問一次，再選「標成做完」或「標成跳過」）。超過 `closes_by` 的不顯示，就算檔裡還寫著。hashtag 篩選不藏「現在」。
- 「待辦」下面是「排程」：有排程的議題，寫下一場的當地時間與規則，標「新」、為什麼不響（暫停中、所有排程暫停中、等你按啟用）、「這一場開著」、「上一場錯過」與 rt。這些議題存在「待辦」，但不列在「待辦」的卡片裡；「現在」與「排程」的卡片都不能拖，要把議題變回一般的，先在議題頁刪掉排程。已封存議題的排程不列。

**議題卡**：名稱、agent 數、各燈號的數量、待你決定的數量（「待你決定 N」，只算可以作答的）、在排隊的待決事項的數量（「決定排隊 N」，有才顯示）、「提議關閉」的標記、「沒送到」的紅點計數，下面一行是它的 hashtag（合併後超過一個議題的上限時標「hashtag 超過上限」），用關鍵字篩選時再一行「符合：<欄位>」。不顯示目標。

**拖曳**：

- 拖的當下就更新順序：卡片跟著游標插到新位置，其他卡片即時讓開；放開才送 `/api/topics/move`；按 Esc 回到原位。
- 滑鼠用瀏覽器原生的拖放。拖曳中的卡片用虛線框與淡色標示。空的佇列在拖曳中顯示落點提示，拖曳結束就消失（原型的小瑕疵在這裡修掉）。
- 觸控螢幕（`pointer: coarse`）上用手指拖：手機瀏覽器的原生拖放靠不住，所以頁面自己用 Pointer Events 做（`src/page/touch.ts`），使用者選的是只用長按拖曳、不加「移到…」選單（設計的 Q2）。
  - 卡片右上角多一個 ⠿，44 × 44，只在觸控螢幕顯示。按住約 0.4 秒卡片浮起來，用相反的配色；按住時手指移開超過 10 px 就當成滑動，不拖。只有 ⠿ 擋掉觸控的捲動，卡片其他地方照常捲頁面。按住 ⠿ 時卡片的原生拖放暫停，手機自己的長按拖曳與長按選單都不會接手。
  - 卡片照手指的高度插到清單裡：排在中線在手指下面的第一張卡前面，沒有就排最後；佇列的標題與卡片之間的空隙不會讓它跳到最後。
  - 拖曳中手指靠近畫面上緣（頁首下面）或下緣（底部分頁上面）時頁面自己捲動，越靠邊越快。
  - 窄的畫面上，分段鈕「高」「一般」「待辦」也是落點：在上面放開，就排到那個佇列清單的最後，送出的和拖到那個佇列清單尾端一樣（篩選中見[篩選中拖曳](drag-under-filter.markdown)第 8 條）。放開會改動的那個鈕在手指下時用虛線框標出。「排程」鈕不收。
  - 取消：拖回原處，或在佇列與分段鈕以外放開。第二根手指按下，或瀏覽器接手手勢時，也取消。
  - 落點、放開後的回饋與從待辦拖出的倒數都和滑鼠一樣；落點用同一個純函式 `dropPlace`（`src/page/drop.ts`）算。
- 卡片上沒有移動用的選單，拖曳是頁面上唯一的移法（C55）。
- 照建立時間排列時（[卡片排列](card-sort.markdown)），卡片不跟著游標換位置，只能拖到別的佇列，排在那裡的最後；在原來的佇列裡放下什麼都不送。手機上一次只看一個佇列，所以手指只能拖到分段鈕。
- 篩選中（hashtag、關鍵字或視圖）只在看得到的卡片之間排：放在一張卡下面就排在完整佇列裡那張卡的正後面，放在最上面就排在第一張看得到的卡前面，被篩掉的議題位置不變；落點提示寫明正在篩選。決定、理由與邊界情形見[篩選中拖曳](drag-under-filter.markdown)。
- 放開後右下角出一則回饋，6 秒後自動消失，點一下也會關掉：
  - 從待辦拖出：倒數 30 秒，寫明時間到會通知 first mate、拖回去就不通知；倒數結束前不消失。
  - 其他順序調整：「first mate 下次重新評估派工時才會照新順序，不會馬上開工」。
  - 拖進待辦：「已經在跑的 worker 不會停；還在排隊的項目要等 first mate 下次重新評估才會被停住」。
- 不做卡片移動的滑動動畫。

**議題頁**，單欄，由上而下：

1. 標題列：名稱、所在佇列、右邊一個「⋯」選單。
2. 一行目標。
   下面一行是這個議題的 hashtag，每個旁邊一個「×」撕掉，最後是一個輸入框與「貼上」；超過上限時寫明減到上限以下之前不能再貼新的。已封存的議題不顯示這一行。
3. 待決佇列：首頁第 3 項那條佇列裡這個議題的卡，同樣的順序、按鈕與摺疊；先不關到某天時寫出到哪天；「暫緩」收合在下面，然後是不能作答的 worker 提問，最後是已關的待決事項，摺成「已關 N」，和「要你動手」底下的一樣：預設收合，每個待決事項一行（最後一筆關閉紀錄的時間、home/task 與那一行），打開是它在看板上的每一筆紀錄，新的在上。有一筆 `hold.answered` 或 `hold.closed` 的才算關了；只是從讀到的 `holds[]` 不見了的不算。這些紀錄照樣也在「更新」裡（C61）。
4. 更新：里程碑摘要用底色與左邊線標出、前面有 kind 的小標籤、有 PR 就接連結；系統紀錄用斜體；帳本事件是一般文字。新的在上。
5. 關聯 agent：燈號、task id、home、最後更新時間、狀態原文、直送的輸入框與按鈕。按鈕上的字是「直送」或「經 <secondmate> 轉達」。
6. 排隊中：這個議題還沒派出去的 backlog 項目，預設收合成一行「排隊中 N」。展開後每列是 task id、標題、home，以及它在等什麼：「可以派」「等你決定」「決定排隊」（它的待決事項還在排隊）「停著：<hold 原因>」（aggregator 給了日期時是「停著：<hold 原因>（延到 <日期>）」）「等 <id> 完成」。沒有排隊的項目時整區不顯示。首頁的議題卡片上同時顯示「排隊 N」。
7. 輸入框黏在視窗底部，送給主 first mate。

議題頁標題下面是「排程」：有排程時寫規則、時區、標記、rt 的建議用法、接下來三場、提前分鐘數與時段長度（標明是用設定的值還是這筆自己的）、開著的那一場（同「現在」的卡），以及「暫停」或「恢復」、「跳過下一場」、rt、排程與 rt 的鎖、「改時間…」（星期、時間、時區、提前分鐘數、時段長度）、「刪掉排程…」（兩步）；aggregator 建的、在等啟用的另有「啟用」，按下是「看過了」，所以寫明會一起啟用每一筆在等的排程。最後是「最近十場」，每場一格：當地時間、怎麼結束（做完、跳過、事先跳過、太快看板略過、沒有人接、逾時結束、錯過 N 場）與 aggregator 寫的那一行。沒有排程、在「待辦」的議題有「加排程…」；不在待辦的寫明要先移到待辦。

**改名、改目標、手動封存、議題併議題放在哪**（這次補定的）：都在議題頁，不在側欄的卡片上。側欄的卡片是拖曳的對象，又窄，不放按鈕。

- 改名、改目標：標題與目標旁各一個 ✎ 鈕（`aria-label` 是「編輯名稱」「編輯目標」），按下後原地變成輸入框，Enter 儲存、Esc 取消。
- 「⋯」選單有兩項：
  - 「封存」：選單下方出現一次畫面內的確認，寫明「排隊中的項目會被停住，已經在跑的不會停；之後可以在『已封存』重開」。
  - 「併入其他議題…」：選一個別的議題，走伺服器的兩步確認，第二步寫明「併入之後不能拆開，<舊名稱> 的 agent 與更新都會顯示在 <新名稱> 底下」；舊議題有新議題沒有的 hashtag 時，另寫出合併後新議題會多哪些（hashtag 取聯集），合起來超過上限也寫出來。

**待決事項的卡**：問題原文保留換行；有選項就畫按鈕，文字框一律有（單行）。按下任何選項或送出文字，卡片裡出現第二步確認（文字與送出鈕見 [contracts](contracts.markdown) 第 8 節），按「送出」才送。暫緩的 hold 展開後一樣可以作答。

**寫入的狀態**：顯示在它送出的地方（agent 列、hold 卡片、輸入框下方），一行：原文、狀態標籤、錯誤說明。失敗、未送達、結果不明三種有「重送」與「忽略」。結果不明按重送先出現一次警告「可能會重複送出」，再按才送。以 `/`、`$`、`-` 開頭的直送在送出前就在頁面上擋下並說明原因（伺服器也擋）。

**未分類區**只放還需要一個議題的東西（議題一建立就在佇列裡，所以不在這裡，C52；什麼算 agent 見 [contracts](contracts.markdown) 第 1 節）：

- 沒有有效標記、還在跑的 agent：寫出原因（沒有標記、標記的議題不存在），附「歸併到…」。
- 這些 agent 的里程碑摘要。
  不屬於任何列出的 agent 的摘要（例如已經不讀的 home、不是工作的紀錄）不在未分類區，仍在「最近的結果」裡。
- 沒歸屬的待決事項，可以直接作答；沒歸屬的 worker 提問。
- 沒標議題的排隊項目：預設摺起來的清單「沒標議題的排隊項目 N」，只顯示。已經有卡片的待決事項不重複列（C49）。
- 最後是預設摺起來的「已結束、沒標議題 N」：已經結束、沒有有效標記的 agent（同樣寫出原因、附「歸併到…」）與它們的摘要，N 是這些 agent 的數目。
  它們不等任何事，留著是為了還能把來歷歸到議題（C53）。

**深色、觸控與窄螢幕**（2026-11-28 補定，手機版面的三個提案共用的底子）：

- 深色只跟著系統的 `prefers-color-scheme`，頁面上沒有切換。`board.css` 的顏色都是 `:root` 的變數：淺色那一組就是原本的色碼，深色那一組在 `@media (prefers-color-scheme: dark)` 裡，hashtag 的 `c1` 到 `c8` 各有一個深色的底色。`color-scheme: light dark` 讓輸入框、捲軸與 `<meter>` 跟著換。`index.html` 宣告 `color-scheme` 與淺、深各一個 `theme-color`。
- 觸控的尺寸看 `pointer: coarse`，不看寬度：按鈕最少 44 × 44 px，連結型按鈕與 `<summary>` 加內距，輸入框的字是 16 px（iOS 聚焦字小於 16 px 的輸入框時會放大整頁）。
- 版面看寬度：
  - 640 px 以下：首頁單欄，優先順序欄排在後面（C42）；`.row` 換行，說明自己一行、輸入框與按鈕在下一行；期限設定的數字框有固定寬度；路徑、SHA-256 這類沒有空白的長字斷行；右下的提示框改成整列寬。
  - 480 px 以下：設定表格（hashtag 設定、排程設定）每一列疊成一張小卡，值前面寫「現在：」「預設：」。
- viewport 有 `viewport-fit=cover`；輸入框、頁底的留白與提示框都避開 iPhone 底部的安全區（`env(safe-area-inset-bottom)`）。
- 測試：`stage-7-page.sh` 用 `stage-7-layout.mjs` 在淺色、深色各走一次 390 與 1300 px：390 px 時打開期限、hashtag、排程設定，首頁與議題頁都不能橫向捲動、沒有元素超出視窗，側欄在下面；1300 px 時側欄在左邊；深色時頁面要看到 `prefers-color-scheme: dark`、背景是深的、沒有元素留著白底。觸控尺寸沒有自動測試（無頭 Firefox 是滑鼠）。

**整頁的狀態**：

- 看板服務沒有回應（輪詢連續失敗 3 次）：頁首下方一條紅色橫幅，說明畫面是最後拿到的資料、現在送不出東西，並給出 `bin/myshape.sh open`。這時送出類的按鈕只提示沒有送出。
- `boot_id` 變了：整頁重拉資料；畫面上進行到一半的兩步確認作廢，提示重做。
- 某個 home 過期：一條黃色橫幅；那個 home 的 agent 燈號變「未知」並寫出多久沒更新，它的待決事項標「可能已過時」。
- 某個 home「還沒換到 fork」「版本不相容」「版本不同」：在 home 的標籤旁標出，前兩種附上要做的事。
- 某個 home 的帳本未開：在相關議題的更新區塊上方說明，並給出要跑的指令。
- 頁首右邊有輪詢的說明與「立刻更新」。

## 驗收

1. `<clone>/myshape/test/run.sh 1 2 3 4 5` 回 0。
2. 安全檢查的測試，對一個跑在暫存 `FM_HOME` 的服務用 `curl` 逐條打（`<p>` 是埠，`<t>` 是 token）。每條都要是指定的狀態碼，而且服務之後仍然回應 health：

   | 請求 | 預期 |
   | --- | --- |
   | `curl -H 'Host: evil.example' http://127.0.0.1:<p>/` | 4xx |
   | `curl -H 'Host: 127.0.0.1:1' http://127.0.0.1:<p>/` | 4xx |
   | `curl http://127.0.0.1:<p>/api/state` | 401 |
   | `curl -H 'Authorization: Bearer wrong' http://127.0.0.1:<p>/api/state` | 401 |
   | `curl -H 'Authorization: Bearer <t>' http://127.0.0.1:<p>/api/state` | 200 |
   | 帶對的 token、`Content-Type: application/json`、沒有 `Origin` 的 `POST /api/refresh` | 403 |
   | 同上，`Origin: null` | 403 |
   | 同上，`Origin: http://evil.example` | 403 |
   | 同上，`Origin: http://127.0.0.1:<p>`、`Content-Type: text/plain` | 415 |
   | 同上，`Content-Type: application/json`、body 是 `{` | 400 |
   | 同上，body 超過 64 KiB | 413 |
   | `curl -X OPTIONS -H 'Origin: http://evil.example' -H 'Access-Control-Request-Method: POST' …/api/refresh` | 405，沒有任何 `Access-Control-*` header |
   | `curl -H 'Connection: Upgrade' -H 'Upgrade: websocket' …` | 400 |
   | `curl 'http://127.0.0.1:<p>/assets/..%2f..%2fstate%2fmyshape%2ftoken'` | 404 |
   | 用原始 socket 送一個 `Host:` 值是亂碼的請求 | 4xx，服務沒當掉 |
   | 帶對的 token、`-H 'X-Forwarded-Host: 127.0.0.1:<p>'` 的 `GET /api/state` | 403 |

   遠端名稱（contracts 第 6.2 節），`<n>` 是範例名稱 `board-pc.example-tailnet.ts.net`、`<l>` 是範例登入。沒有 `config/myshape-remote.json`、或它讀不懂時，下面每一條都是 403；寫了 `{"host":"<n>","login":"<l>"}` 並重啟之後：

   | 請求（都帶 `-H 'Host: <n>'`） | 預期 |
   | --- | --- |
   | `-H 'Tailscale-User-Login: <l>'` 的 `GET /` | 200 |
   | 同上，帶對的 token 的 `GET /api/state` | 200 |
   | 同上，`Origin: https://<n>`、`Content-Type: application/json` 的 `POST /api/refresh` | 200 |
   | 沒有 `Tailscale-User-Login` 的 `GET /` | 403 |
   | `Tailscale-User-Login` 是別人 | 403 |
   | 對的登入、加 `Tailscale-Funnel-Request: ?1` | 403 |
   | 對的登入、`Origin: http://<n>` 的 `POST /api/refresh` | 403 |
   | 對的登入、`Origin: https://<n>` 的 `POST /api/programs/confirm` | 403；本機名稱的同一個請求照舊交給 API |
   | `Host: <n>:8443` 或 `Host: other.example-tailnet.ts.net` | 403 |

   另外確認：每個回應都有 CSP 與 `X-Frame-Options: DENY`；`ss -ltn` 顯示服務只聽 `127.0.0.1`；`index.html` 的原始碼裡沒有 token、沒有任何議題資料；每筆被拒的請求在 `audit.jsonl` 有一行，而且那一行沒有 token。
3. 兩步確認：沒有確認碼直接送作答、確認碼用第二次、確認碼過期、兩步之間 hold 的問題或處理方式變了、服務重啟後用舊的確認碼，全部被拒；請求裡帶的 `mode` 不影響送出的處理方式。
4. `reset-token` 之後，舊 token 的請求回 401。
5. 手動走一遍（用假資料的暫存 `FM_HOME`，在 Chrome 與 Firefox 各一次），每項截圖貼進 PR：首頁五段、議題頁、拖曳跨佇列與 Esc 取消、從待辦拖出的倒數、改名、改目標、封存與重開、併入其他議題、歸併 agent、作答一個有選項的 hold、送一則訊息給 first mate、直送、一筆失敗的寫入按重送與忽略、停掉服務後的紅色橫幅、再啟動後頁面自己恢復。
6. 和 `myshape/test/prototype-variant-c.html` 並排比對版面；有出入的地方在 PR 裡列出原因。已知的出入：原型裡提議中的議題那一區不存在，議題一建立就在佇列裡（C52）；Host 不對回 403（不是 400）。
7. 前四段的驗收再跑一次。
