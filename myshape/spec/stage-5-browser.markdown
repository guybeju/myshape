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
| `POST /api/topics/move` | `{id, queue, before?}` 或 `{id, queue, first: true}` | 拖曳的落點；`before` 與 `first` 都省略就是尾端 |
| `POST /api/topics/rename`、`/goal` | `{id, value}` | 改名、改目標 |
| `POST /api/topics/archive`、`/reopen` | `{id, queue?}` | 封存、重開 |
| `POST /api/topics/keep` | `{id}` | 對提議關閉按「先不關」：清掉 `close_proposal` |
| `POST /api/topics/merge` | `{from, into, confirm?}` | 議題併議題，兩步 |
| `POST /api/agents/tag` | `{home, task, topic}` | 歸併 agent |
| `POST /api/messages` | `{topic, text}` | 給主 first mate |
| `POST /api/direct` | `{home, task, text}` | 直送 |
| `POST /api/holds/answer` | 第一步 `{home, task, answer, label}`；第二步再加 `{confirm}`。送 `done` 還是 `release` 照 hold 記下的處理方式，請求裡的 `mode` 不看 | 作答，兩步 |
| `POST /api/todos/claim` | `{task}` | 對要你動手的項目按「做完了」：記成 `claimed` 並通知 aggregator 去驗證；項目還在。重複按不重複通知 |
| `POST /api/todos/drop`、`/takedown` | 第一步 `{task}`；第二步再加 `{confirm}` | 「不做了」與「好，撤下」，兩步：項目離開看板，議題的更新留一筆使用者的紀錄，並通知 aggregator（contracts 第 7.1 節） |
| `POST /api/writes/resend` | `{write_id, confirm?}` | 重送；結果不明的要兩步 |
| `POST /api/writes/ignore` | `{write_id}` | 忽略 |

議題操作和 socket 上的同名操作是同一套伺服器函式。`/api/topics/keep` 是頁面才有的（原型的「先不關」），它只清欄位。瀏覽器這條通道沒有 `propose`、`close-propose`、`summary`、`which`、`stop`、`restart`、`reset-token`。

錯誤回應：`{"error":"<代碼>","message":"<給人看的一行>"}`。401 是 token 不對：頁面顯示「token 已重置或無效，請在終端機重新跑 `bin/myshape.sh open`」並停止輪詢。

### 頁面

單頁，原生的 DOM 操作。每 5 秒輪詢一次 `/api/state`（分頁在背景時停）。頁面腳本用 TypeScript 寫在 `myshape/src/page/`，由同一個 `tsc` 編到 `dist/page/`，不打包。

**首頁**，由上而下：

1. 要你動手：每個開著的要你動手項目，跨議題，卡上標議題（沒有議題的標「未分類」）。沒有開著的項目時整段不顯示。
2. 沒有議題：沒有議題、已經關掉的要你動手項目，摺成「已關 N」，和議題頁「要你動手」底下的一樣（預設收合，每個項目一行，打開是它的每一步）。沒有這種項目時整段不顯示（C61）。
3. 等你決定：所有 live 的待決事項，跨議題列在一起，照 [第三段](stage-3-data.markdown)的順序。每張卡標議題名稱與所在的 home。提議關閉的議題也列在這段。
4. 最近的結果：里程碑摘要，四種都列，附議題名稱；`failed` 用卡住的顏色標出（採建議 C11）。
5. 進行中：燈號是進行中、卡住、未知的 agent，一個一列，附議題與 home。
6. 排定的：待辦佇列的議題，加上暫緩的待決事項與原因。
7. 未分類區。

**左側欄**「優先順序」：高、一般、待辦三個佇列由上而下，「待辦」標明不自動開工。最下面是「已封存」，預設收合，展開後每個議題有「重開」。

**議題卡**：名稱、agent 數、各燈號的數量、待你決定的數量、「提議關閉」的標記、「沒送到」的紅點計數。不顯示目標。

**拖曳**：

- 拖的當下就更新順序：卡片跟著游標插到新位置，其他卡片即時讓開；放開才送 `/api/topics/move`；按 Esc 回到原位。
- 用瀏覽器原生的拖放。拖曳中的卡片用虛線框與淡色標示。空的佇列在拖曳中顯示落點提示，拖曳結束就消失（原型的小瑕疵在這裡修掉）。
- 卡片上沒有移動用的選單，拖曳是頁面上唯一的移法（C55）。
- 放開後右下角出一則回饋，6 秒後自動消失，點一下也會關掉：
  - 從待辦拖出：倒數 30 秒，寫明時間到會通知 first mate、拖回去就不通知；倒數結束前不消失。
  - 其他順序調整：「first mate 下次重新評估派工時才會照新順序，不會馬上開工」。
  - 拖進待辦：「已經在跑的 worker 不會停；還在排隊的項目要等 first mate 下次重新評估才會被停住」。
- 不做卡片移動的滑動動畫。

**議題頁**，單欄，由上而下：

1. 標題列：名稱、所在佇列、右邊一個「⋯」選單。
2. 一行目標。
3. 待決佇列：提議關閉的卡在最上面（「關閉並封存」「先不關」），接著 live 的待決事項，「暫緩」收合在下面，然後是不能作答的 worker 提問，最後是已關的待決事項，摺成「已關 N」，和「要你動手」底下的一樣：預設收合，每個待決事項一行（最後一筆關閉紀錄的時間、home/task 與那一行），打開是它在看板上的每一筆紀錄，新的在上。有一筆 `hold.answered` 或 `hold.closed` 的才算關了；只是從讀到的 `holds[]` 不見了的不算。這些紀錄照樣也在「更新」裡（C61）。
4. 更新：里程碑摘要用底色與左邊線標出、前面有 kind 的小標籤、有 PR 就接連結；系統紀錄用斜體；帳本事件是一般文字。新的在上。
5. 關聯 agent：燈號、task id、home、最後更新時間、狀態原文、直送的輸入框與按鈕。按鈕上的字是「直送」或「經 <secondmate> 轉達」。
6. 排隊中：這個議題還沒派出去的 backlog 項目，預設收合成一行「排隊中 N」。展開後每列是 task id、標題、home，以及它在等什麼：「可以派」「等你決定」「停著：<hold 原因>」「等 <id> 完成」。沒有排隊的項目時整區不顯示。首頁的議題卡片上同時顯示「排隊 N」。
7. 輸入框黏在視窗底部，送給主 first mate。

**改名、改目標、手動封存、議題併議題放在哪**（這次補定的）：都在議題頁，不在側欄的卡片上。側欄的卡片是拖曳的對象，又窄，不放按鈕。

- 改名、改目標：標題與目標旁各一個「編輯」鈕，按下後原地變成輸入框，Enter 儲存、Esc 取消。
- 「⋯」選單有兩項：
  - 「封存」：選單下方出現一次畫面內的確認，寫明「排隊中的項目會被停住，已經在跑的不會停；之後可以在『已封存』重開」。
  - 「併入其他議題…」：選一個別的議題，走伺服器的兩步確認，第二步寫明「併入之後不能拆開，<舊名稱> 的 agent 與更新都會顯示在 <新名稱> 底下」。

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

   另外確認：每個回應都有 CSP 與 `X-Frame-Options: DENY`；`ss -ltn` 顯示服務只聽 `127.0.0.1`；`index.html` 的原始碼裡沒有 token、沒有任何議題資料；每筆被拒的請求在 `audit.jsonl` 有一行，而且那一行沒有 token。
3. 兩步確認：沒有確認碼直接送作答、確認碼用第二次、確認碼過期、兩步之間 hold 的問題或處理方式變了、服務重啟後用舊的確認碼，全部被拒；請求裡帶的 `mode` 不影響送出的處理方式。
4. `reset-token` 之後，舊 token 的請求回 401。
5. 手動走一遍（用假資料的暫存 `FM_HOME`，在 Chrome 與 Firefox 各一次），每項截圖貼進 PR：首頁五段、議題頁、拖曳跨佇列與 Esc 取消、從待辦拖出的倒數、改名、改目標、封存與重開、併入其他議題、歸併 agent、作答一個有選項的 hold、送一則訊息給 first mate、直送、一筆失敗的寫入按重送與忽略、停掉服務後的紅色橫幅、再啟動後頁面自己恢復。
6. 和 `myshape/test/prototype-variant-c.html` 並排比對版面；有出入的地方在 PR 裡列出原因。已知的出入：原型裡提議中的議題那一區不存在，議題一建立就在佇列裡（C52）；Host 不對回 403（不是 400）。
7. 前四段的驗收再跑一次。
