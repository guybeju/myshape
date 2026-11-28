# 第二段：服務的骨架

做完之後：看板服務能按需啟動、保證只有一個、當掉能回來；`myshape.sh` 能經 socket 做所有議題操作；議題檔由服務獨家寫入。還沒有輪詢、沒有對外寫入、沒有頁面。

## 先驗再做

這一段原本「因為沒有 `node` 而沒驗」的項目，2026-11-16 已在這台用 node v22.22.1 實測（指令與輸出在 [verification](verification.markdown)）。結論直接寫進下面的做法：

| # | 結果 | 對設計的影響 |
| --- | --- | --- |
| 2-a | 這台的 `node`（Ubuntu 套件）沒有 TypeScript 支援，直接跑 `.ts` 與 `--experimental-strip-types` 都失敗 | 執行期只跑提交進 git 的 `dist/*.js`（使用者定案） |
| 2-b | 埠被佔用時 `listen` 回 `EADDRINUSE`；對殘留的 socket 檔 `listen` 也回 `EADDRINUSE`，`connect` 回 `ECONNREFUSED`；沒有檔時 `connect` 回 `ENOENT`；刪掉殘留檔後可以重綁 | 單例仲裁照原設計可行 |
| 2-c | socket 路徑超過上限時 Node **不會報錯**，而是默默截斷路徑，把 socket 建在別的地方 | 服務必須在 `listen` 之前自己檢查路徑的位元組長度（採建議 C2） |
| 2-d | `process.umask(0o177)` 之後建立的 socket 權限是 0600 | 照做；`listen` 的回呼只註冊一次（實驗裡重綁時重複註冊，回呼跑了兩次） |
| 2-e | 由 node 用 `spawn(…, {detached: true})` 啟動的服務有自己的 session 與 process group、父程序變成 systemd，跨兩次 Bash 工具呼叫仍活著。`nohup setsid` 也活著，但留下一個包裝用的 bash；上游慣用的 `set -m; nohup … &` 也活著，有自己的 process group、沒有自己的 session | 由 node client 啟動服務，不用 Bash 的 `nohup`（採建議 C3） |
| 2-f | Linux 上 `/proc/<pid>/cmdline` 與 `ps -o args= -p <pid>` 都拿得到完整的指令列 | 用 `ps -o args= -p`（BSD 的 `ps` 也有），不讀 `/proc` |
| 2-g | node client 冷啟動加一次 health 往返：20 次量測 85 到 104 毫秒（單純啟動 `node` 約 75 毫秒） | 3 秒的 health 逾時有 28 倍以上的餘裕 |

還要驗的：

| # | 要驗的事 | 怎麼驗 | 假設不成立時 |
| --- | --- | --- | --- |
| 2-1 | 服務活過 Claude Code session 結束。這次只能驗到「跨工具呼叫仍活著、已脫離原本的 session」 | 在主 home 的 first mate session 裡跑 `bin/myshape.sh status` 讓服務起來，記下 pid；結束那個 session；從另一個終端機 `ps -p <pid>` | 服務本來就是懶啟動：下一個議題指令、`open` 或主 home 下一次開 session 會把它帶起來，資料不會掉。只是使用者會看到「看板服務沒有回應」直到那時 |
| 2-2 | `ps -o args= -p <pid>` 在 macOS 的輸出能比對出同一個 home 的服務 | 在 macOS 上啟動服務後跑一次 | 比對不出來就不殺，回 69 並請使用者手動處理。主 home 目前是 Linux |
| 2-3 | `tsc` 的輸出在不同機器上逐位元組相同 | 在兩台機器各跑一次 `myshape/test/check-dist.sh` | 不同就把檢查改成「重編後 `node --test` 全過」，不比位元組 |

## 要做的事

### 原始碼的位置與編譯

- 原始碼在 `myshape/src/`，TypeScript。`tsc` 把它編到 `myshape/dist/`，`dist/` 提交進 git。執行期只跑 `dist/` 裡的 `.js`。
- **執行期沒有任何 npm 相依**：只用 Node 的內建模組（`node:net`、`node:http`、`node:fs`、`node:child_process`、`node:crypto`、`node:path`）。`myshape/` 底下不需要 `node_modules` 就能跑。
- 開發期的相依都在 `package.json` 的 `devDependencies` 釘死確切版本：`typescript`（7.0.2）、`@types/node`（22.20.5）、`vitest` 與 `@vitest/coverage-v8`（5.1.0）、`oxlint`（1.93.0）、`oxfmt`（0.78.0）。用 pnpm 安裝，lockfile 是 `pnpm-lock.yaml`。
- 測試有兩層。Bash 寫的整合測試（`myshape/test/run.sh`）從 `myshape.sh` 進去，跑的是提交的 `dist/`。單元測試是 `src/*.test.ts`，用 `pnpm test` 跑，不會被編進 `dist/`；`pnpm run coverage` 產生覆蓋率給 `crapper-axi` 用。
- `pnpm run typecheck`、`pnpm run lint`、`pnpm run format:check` 要全過。
- `package.json`：`"private": true`、`"type": "module"`、`"engines": {"node": ">=22"}`，scripts 只有 `build`（`tsc -p .`）與 `test`。
- `tsconfig.json`：`"strict"`、`"noUncheckedIndexedAccess"`、`"exactOptionalPropertyTypes"`、`"noImplicitOverride"`、`"noPropertyAccessFromIndexSignature"`、`"verbatimModuleSyntax"`、`"isolatedModules"` 全開；`"module": "nodenext"`、`"target": "es2023"`、`"rootDir": "src"`、`"outDir": "dist"`；不產生 source map 與 `.d.ts`，讓輸出穩定。
- `myshape/.gitignore` 忽略 `node_modules/` 與 `.metrics/`（分析工具的輸出）。上游的 `.gitignore` 沒有這一條，不加的話開發用的 clone 會顯示 dirty。
- `myshape/test/check-dist.sh`：有 `myshape/node_modules/.bin/tsc` 時，把 `src/` 編到暫存目錄，和 `dist/` 逐檔比對，不同就失敗並列出檔名；沒有 `tsc` 時印 `skip:` 並回 0。每個動到 `src/` 的 PR 都要重編並提交 `dist/`。

### 入口

- `myshape/dist/board-client.js`：`myshape.sh` 呼叫它，把子命令與參數傳過去。它負責 health、啟動服務、送一個要求、把回應的那一行印出來、用對的 exit code 結束。
- `myshape/dist/board-server.js`：服務本體。參數：`--home <主 home>`、`--root <code root>`、`--commit <code root 的 git commit>`。這三個值由 `myshape.sh` 算好傳給 client，client 啟動服務時原樣帶上。

`myshape.sh` 在呼叫 client 之前自己檢查：

1. 在 secondmate home：印「議題檔只在主 home」，exit 1，不啟動服務。
2. `command -v node` 找不到：回 69，原因「沒有 node」，修法的文字對齊上游 `bin/fm-bootstrap.sh:872` 的 `install_cmd`。
3. `node -p 'process.versions.node.split(".")[0]'` 小於 22：回 69，原因「node 版本低於 22」。

沒有 `node` 時的 `status` 與 `stop`（採建議 C16）：`status` 只讀 `pid`、`port` 檔與三個 jsonl 的大小，印出來並註明「沒有 node，無法詢問服務」，回 0；`stop` 回 69。

### 啟動與單例

同一個 home 一次只有一個 client 能啟動、殺掉或換掉服務：client 先拿 `state/myshape/start.lock`（`mkdir` 當鎖，裡面記 pid；持有者死了就接手，最多等 30 秒），拿到之後重新問一次 health 再動手。沒有這把鎖時，兩個指令同時啟動，輸的那個會在贏家還沒綁好 socket 之前把它誤判成「埠被別的程式佔用」（實作時的並行測試抓到的）。

client 的流程，除了 `status`、`stop` 之外的每個經 socket 的子命令都一樣：

1. 連 socket 送 `health`，逾時 3 秒。
2. **沒有 socket 檔（`ENOENT`）或連線被拒（`ECONNREFUSED`）**：啟動服務，每 200 毫秒試一次 health，最多等 10 秒。
3. **連得上但逾時沒回**：視為卡死。讀 `pid` 檔，用 `ps -o args= -p <pid>` 確認指令列同時含 `board-server.js` 與這個 home 的路徑，送 TERM，5 秒後還在就送 KILL，再啟動。比對不上就不殺，回 69。
4. **health 正常，但回報的 `code_commit` 和現在傳入的不同，或回報的埠和 `config/myshape-port`（沒有這個檔就是 47819）不同**：送 `stop`，等它退出，再啟動。
5. 都正常：送要求。

啟動的方式：`spawn(process.execPath, [<board-server.js>, …參數], {detached: true, stdio: ['ignore', <log fd>, <log fd>], cwd: <state/myshape>})` 之後 `unref()`。log fd 是以追加模式開的 `service.log`；開之前若它超過 1 MiB 就先改名成 `service.log.1`。client 啟動前先確保 `state/myshape/` 存在且是 0700。cwd 設在那裡，不在任何 worktree 裡，上游的 `fm-teardown.sh` 依 cwd 回收程序時不會掃到。

服務啟動的順序：

1. 檢查 socket 路徑的位元組長度：Linux 超過 107、macOS 超過 103 就印原因並以非 0 結束。
2. 綁 TCP 埠。這是單例的仲裁點。
   - 回 `EADDRINUSE`：`pid` 檔裡的程序還活著，就是已經有看板在跑或正在啟動，exit 0。否則連 socket 送 `health`，3 秒內有回應也 exit 0；沒有回應或連不上就是埠被別的程式佔用，把原因寫進 log 後以特定的 exit code 結束。不自動換埠。
3. 綁到埠之後：先寫 `pid` 檔（另一個剛啟動的服務靠它知道佔住埠的是看板）。然後刪掉 `state/myshape/` 與 `data/` 底下殘留的 `*.tmp-<pid>` 暫存檔並記入 log；載入議題檔、`events.jsonl`、`summaries.jsonl`、`audit.jsonl`（後三個在這一段只要能讀、能截掉沒寫完的半行）。
4. token 檔不存在就產生。寫 `port`。
5. 最後才刪掉殘留的 socket 檔、`umask 0o177`、綁 socket。載入完成前不綁，免得 3 秒的 health 逾時把還在載入的新服務當成卡死。
6. 產生這次啟動的 `boot_id`（亂數）。

這一段 TCP 只需要綁住埠、對任何請求回 404；瀏覽器那條通道的檢查與 API 是第五段的事。

服務不會閒置自動關，session 鎖換手時不重啟，沒有 watchdog。只有 `stop`、被殺或重開機會讓它停。收到 `stop` 或 TERM：不再接新要求，寫完手上的檔，刪掉 socket 檔與 `pid` 檔，退出。

主 home 每次開 session（拿到 session 鎖、不是重印摘要）時，`bin/fm-session-start.sh` 呼叫 `bin/fm-topic-session-start.sh`：服務成功啟動過（`state/myshape/token` 存在）的主 home 先跑一次 `status`，在跑就不動，即使跑的是舊版的程式；不是在跑就跑 `open`，丟掉它印的網址。結果在啟動摘要裡印成一行：在跑、已啟動、沒有回應而重新啟動，或無法啟動加上原因。所以 `stop` 停掉的服務會在下一次開 session 時回來；重開機之後也一樣。secondmate home、服務沒有成功啟動過的主 home、沒拿到鎖的唯讀 session 都不做這件事。

### 啟動失敗的類別

每種都由 client（或前面的 `myshape.sh`）印成 [contracts](contracts.markdown) 第 9 節的那一行，exit 69：

| 原因 | 修法的文字 |
| --- | --- |
| 沒有 node | 上游的安裝指令 |
| node 版本低於 22 | 請升級到 22 以上 |
| 埠 <n> 被別的程式佔用 | 在 `config/myshape-port` 寫另一個埠號 |
| socket 路徑太長（<n> 位元組，上限 <m>） | home 的路徑太深，請把 home 搬到較短的路徑 |
| `state/` 不可寫 | 檢查 `state/` 的權限 |
| 編譯結果不見了（`dist/board-server.js` 不存在） | 在主 home 跑 `/updatefirstmate`，或確認 checkout 完整 |
| `data/topics.json` 或封存檔讀不懂 | 修好或移開那個檔之後再試（服務不會覆寫讀不懂的檔） |
| 10 秒內沒就緒，或啟動中當掉 | 附 `service.log` 最後 20 行 |

服務把啟動失敗的原因寫進 `state/myshape/startup-error`（一行 JSON），client 讀它來印那一行；啟動成功就刪掉。

要求已送出、回應前連線斷掉：exit 3，印「結果不明，可以原樣重做一次」。client 自己不重送。還沒送出就失敗的（連不上），照上面的流程重啟後送一次。

### `status`、`stop`、`restart`、`open`、`reset-token`

- `status`：不自動啟動、不因版本或埠不符而重啟。服務在跑：印是否在跑、pid、埠、程式版本、啟動時間、輪詢是否進行中（這一段固定是「否」）、`events.jsonl`、`summaries.jsonl`、`audit.jsonl` 的大小。沒在跑：讀 `pid`、`port` 檔與檔案大小，印「沒在跑」。之後的段會往 `status` 加行（各 home 的版本、規則的狀態）。
- `stop`：沒在跑就什麼都不做，回 0。
- `restart`：`stop` 之後照一般流程啟動。
- `open`：確保服務在跑，讀 `port` 與 `token` 檔，印 `http://127.0.0.1:<埠>/#t=<token>`。它只印網址，不替使用者開瀏覽器，服務也不因此多執行任何指令。
- `reset-token`：服務產生新 token、用暫存檔加 rename 換掉 token 檔。印 `ok reset-token 已重置，請重新跑 open`。

### 議題操作

全部經 socket，由服務改 `data/topics.json` 與封存檔。每個都可以原樣重做：

| 子命令 | 作用 | 原樣重做時 |
| --- | --- | --- |
| `create <名稱> --goal <一行> [--id <id>] [--queue high\|normal\|later] [--hashtag <名稱>]… [--new-hashtag <名稱>]…` | 建立新議題，一建立就已確認，排在佇列最後：沒有 `--queue` 就是 `normal`，只有明確傳了才放別的佇列，不從名稱或目標推斷（C52）。每個 `--hashtag` 照下面的 `hashtag` 貼上，每個 `--new-hashtag` 照 `hashtag … --new` 貼上；任何一個被拒絕就整個不建，看板還沒有的名稱放在 `--hashtag` 也是。印出 id 與放在哪裡 | 沒封存的議題裡已有名稱與目標都相同的，回那個 id，不建第二個，也不搬位置（重做時帶了別的 `--queue` 也一樣）。同名不同目標照規則加序號 |
| `merge <舊 id> <新 id>` | 把舊議題併進新議題：`merged[舊] = 新`，舊議題從 `topics` 與佇列移除。新 id 必須是沒封存的議題 | 已併過就回成功 |
| `close-propose <id> --reason <文字>` | 寫入 `close_proposal` | 理由相同不動，不同就換掉 |
| `move <id> <佇列> [--before <id> \| --first]` | 移動佇列與位置；沒給位置時，新進這個佇列的放尾端 | 沒給位置而議題已在那個佇列就不動 |
| `rename <id> <名稱>`、`goal <id> <一行>` | 改名、改目標 | 值相同不動 |
| `archive <id>` | 從 `topics.json` 搬到封存檔，加 `archived_at`，清掉 `close_proposal` | 已封存就回成功 |
| `reopen <id> [--queue <佇列>]` | 從封存檔搬回來，一律變成已確認，預設放「一般」尾端 | 已不在封存檔而且存在就回成功 |
| `hashtag <id> +<名稱> [--new]`、`hashtag <id> --remove <名稱>` | 在一個沒封存的議題上貼、撕一個 hashtag，存在 `data/myshape/hashtags.json`（[contracts](contracts.markdown) 第 3.8 節）；第一次用到的名稱就開新的 hashtag，但要加 `--new`（不帶值）明說：沒加時 exit 1，印一行看板上相近的、常用的與怎麼再跑一次，什麼都不改（使用者在頁面上關掉 `aggregator_must_mark_new` 時不用加）。撕掉用 `--remove`，不收 `-<名稱>`；`--new` 不和 `--remove` 一起用，多出來的參數都是用法錯 | 已經有（不分大小寫與全形）或已經沒有就不動 |

每個 id 參數都先過 `merged` 表。名稱與目標是單行、去頭尾空白、不能是空的；名稱上限 80 個碼位，目標上限 200 個碼位。`move`、`reopen` 觸發的「議題變成可派」通知是第四段的事，這一段只留一個內部事件的掛點。`create`、`merge`、`close-propose`、`archive`、`reopen` 各寫一筆系統紀錄進 `events.jsonl`；`hashtag` 與帶 `--hashtag` 的 `create` 另寫一筆 `hashtag.added` 或 `hashtag.removed`，`merge`、`split` 帶上 hashtag 時另寫一筆 `hashtag.carried`。`find` 的關鍵字是看板有的 hashtag 時，先列那個 hashtag 與貼著它的議題，而且不把它當成 task id 去讀 home。

`summary` 與 `which` 在第三段。

## 驗收

1. `<clone>/myshape/test/run.sh 1 2` 回 0。第二段的測試每個都用自己的暫存 `FM_HOME` 與隨機的高埠（寫進該 home 的 `config/myshape-port`），結束時 `stop` 服務並確認程序已死。至少涵蓋：
   - 沒在跑時任一子命令會自動啟動；兩個指令同時啟動只留下一個服務。
   - 殘留的 socket 檔、殘留的暫存檔、`events.jsonl` 的半行，啟動後都被處理。
   - 埠被別的程式佔用回 69 與對的那一行；`dist/board-server.js` 不見回 69。
   - `--commit` 不同或埠設定變了，下一個指令會換掉舊服務。
   - 用 `kill -STOP` 讓服務卡死，下一個指令在 3 秒逾時後殺掉重啟。
   - 上表每個議題操作：做一次、原樣重做、非法輸入被拒（exit 1）、用法錯（exit 2）。
   - 純中文名稱得到 `t<n>`；封存或併掉的 id 不能再被 `--id` 使用。
   - 服務被 `kill -9` 之後 `topics.json` 仍是完整的 JSON。
   - `status`、`stop` 在服務沒跑時不啟動它。
   - `board.sock`、`token` 是 0600，`state/myshape/` 是 0700。
2. `<clone>/myshape/test/check-dist.sh` 回 0（裝了 `typescript` 的情況下）。
3. `cd <clone>/myshape && npx tsc --noEmit -p .` 沒有任何訊息。
4. 把 `<clone>/myshape/node_modules` 移走後，`run.sh 2` 仍然過：證明執行期沒有 npm 相依。
5. 第一段的驗收第 2 到 5 條再跑一次。
6. 先驗項目 2-1 的結果寫進 PR。
