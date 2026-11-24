# 驗證紀錄

改名（[open-issues](open-issues.markdown) C57）之前，看板的名字是 `topic-board` 與 `fm-topic`；這一頁照寫下時的名字留著，新舊名字的對照在 C57。

每一項標三種之一：

- **實測**：這次實際跑過，附指令與結果。
- **讀原始碼**：只讀了上游的原始碼（commit `427056c4`），附檔案與行號。沒有跑過。
- **未驗**：附原因。要怎麼驗、假設不成立時怎麼退，寫在所屬那一段的「先驗再做」。

實測的環境：2026-11-16，Linux，`/usr/bin/node` v22.22.1（Ubuntu 套件 `22.22.1+dfsg+~cs22.19.15-1ubuntu1`），bash，`jq` 有、`tasks-axi` 沒有。全部在規劃目錄底下的暫存目錄做：一份上游的本機 clone、暫時的 `FM_HOME`、隨機的高埠。沒有碰運作中的主 home。過程中沒有看到沙箱限制的跡象（`listen`、背景程序都正常）。驗完程序都已停掉、埠已釋放。

## 一、這次實測的

### 原本只因為沒有 `node` 而沒驗的

| 項目（出處） | 做了什麼 | 結果 |
| --- | --- | --- |
| Node 直接跑 TypeScript（這次補定的事） | `node main.ts`；`node --experimental-strip-types main.ts`；`node -p process.features.typescript` | **不行**。分別回 `ERR_UNKNOWN_FILE_EXTENSION` 與 `ERR_NO_TYPESCRIPT: Node.js is not compiled with TypeScript support`；`process.features.typescript` 是 `false`，`process.config.variables.node_use_amaro` 是 `false`。這是 Ubuntu 套件的編譯選項，不是版本問題 |
| `EADDRINUSE` 與殘留 socket 檔（服務生命週期那張） | 實驗服務先綁 TCP 再綁 socket；另起第二個；用 `kill -9` 製造殘留的 socket 檔；讓別的程式佔住埠 | 和設計一致：埠被佔回 `EADDRINUSE`；已有看板時第二個連 socket 得到回應後 exit 0；埠被別的程式佔住時 socket 連線回 `ECONNREFUSED`，判成「被別的程式佔用」。對殘留的 socket 檔 `listen` 回 `EADDRINUSE`、`connect` 回 `ECONNREFUSED`；沒有檔時 `connect` 回 `ENOENT`；`unlink` 之後可以重綁 |
| socket 路徑太長（同上，第 5 點假設會啟動失敗） | 對 159 位元組的路徑 `listen` | **和假設不同**。Node 沒有報錯，回報 listening，但 socket 檔被建在截斷後的路徑（上一層目錄裡一個 50 個字元的檔名）。服務必須自己先檢查長度 |
| socket 權限 | `process.umask(0o177)` 後 `listen`，`stat` | 0600。不設 umask 時是 0775 |
| 啟動後能不能活過 Bash 工具呼叫（同上） | 三種形狀各啟動一個實驗服務，在下一次工具呼叫（不同的 shell、不同的 session id）檢查 | 三種都活著、都能回應 health。node `spawn({detached:true})`：PPID 是 systemd、自己的 PGID 與 SID、沒有多餘的程序。`nohup setsid node …`：自己的 PGID 與 SID，但留下一個包裝用的 bash 當父程序。`set -m; nohup node … &`（上游慣用的形狀）：PPID 是 systemd、自己的 PGID，SID 仍是啟動它的 shell 的 |
| 比對 `pid` 檔的指令列（同上） | `tr '\0' '\n' < /proc/<pid>/cmdline`；`ps -o args= -p <pid>`；`readlink /proc/<pid>/cwd` | Linux 上兩種都拿得到完整的指令列與參數；cwd 也對 |
| node client 的啟動時間（指令介面那張） | client 冷啟動、連 socket、一次 health 往返，連跑 20 次；另量單純 `node -e 0` | 85 到 104 毫秒（中位數 90）；單純啟動 72 到 87 毫秒。20 核、負載約 0.9。對 3 秒的逾時餘裕約 28 倍 |
| `node --test` 能不能當測試框架 | 對 `.mjs` 跑 | 可以（對 `.ts` 因為上面那一條而失敗；測試跑的是編譯後的 `.js`） |

### 這次另外發現並實測的

| 項目 | 做了什麼 | 結果 |
| --- | --- | --- |
| 上游的文件稽核 | 在 clone 裡加追蹤的 `topic-board/README.md`、`notes.txt`、`x.md.tmpl`、`a.markdown`，各跑 `bin/fm-doc-audience-check.sh` | 基準 `ok surfaces=142`。`.md` 與 `.txt` 回 `unclassified: …`、exit 1。`.md.tmpl` 與 `.markdown` 通過 |
| 上游的測試清單上限 | 在 clone 裡加一個 `tests/fm-topic.test.sh`，跑 `bin/fm-test-run.sh --check-coverage` | 基準 exit 0。加一個測試之後失敗：`45 of 298 portable serial scripts have no measured duration hint (max 15%)`。目前剛好在上限（44/297） |
| `fm-test-run.sh --changed` 對新檔的要求 | 加 `bin/fm-topic.sh` 與 `topic-board/server.ts`，跑 `--list --changed` | 沒有測試引用時：`no changed-test mapping for source path: bin/fm-topic.sh`。加了一個提到這些路徑的 `tests/*.test.sh` 之後不再中止。只有 `bin/fm-topic.sh` 與那個測試時選出 1 個測試；再加上 `topic-board/server.ts` 與一個 `.md.tmpl` 時選出 47 個，原因沒有查 |
| 從 `tests/` 以外載入上游的 `tests/lib.sh` | 在 clone 的 `topic-board/test/` 放一支腳本，source `tests/lib.sh`，用 `fm_test_tmproot`、`assert_equals`、`pass` | 可以。`ROOT` 指到 clone，`FM_HOME` 被清掉 |
| 空的 home 跑 snapshot | 暫時的空 `FM_HOME`：`FM_SNAPSHOT_SECONDMATES=0 FM_CREW_STATE_NO_FORGE=1 bin/fm-fleet-snapshot.sh --json` | exit 0、251 毫秒、沒有在 `FM_HOME` 寫任何檔。沒有 `tasks-axi` 也能跑。頂層欄位：`backlog`、`contributions`、`fm_home`、`generated`、`main_inventory`、`roots`、`schema`、`scout_reports`、`secondmate_current`、`secondmate_guidance`、`secondmate_landed`、`tasks`。沒有 `decisions_open` 這個頂層欄位 |
| `trash` 指令 | `command -v trash` | 這台沒有。`gio trash` 可用，但不支援 `/tmp`（tmpfs），所以暫存目錄開在家目錄底下 |

## 二、讀原始碼確認的

| 項目（出處） | 依據 | 結論 |
| --- | --- | --- |
| `FM_SNAPSHOT_SECONDMATES=0` 是否跳過遠端收集（資料來源那張） | `bin/fm-fleet-snapshot.sh:158`、`:260`（"0 lifts the count bound"）、`:1773` | **和假設相反**：0 是取消數量上限，不是跳過。收集那一段（`:1396-1500`）對每個抽到的遠端都執行 `fm-on.sh <id> fm-remote-file.sh get state/home-summary.json`，沒有略過的分支。見 [open-issues](open-issues.markdown) 的 C1 |
| `FM_CREW_STATE_NO_FORGE` 會傳到 crew-state（同上） | `bin/fm-fleet-snapshot.sh:335-342` | 會（規劃時已確認） |
| `fm-on.sh` 不轉送環境變數、每個 job 的上限與逾時（同上） | `bin/fm-on.sh:121-127`；`bin/fm-remote-job-lib.sh:31-32,72-80,102-104` | 遠端用 `env -i`，只帶 `PATH`、`HOME`、`FM_HOME` 等；輸入輸出各上限 1 MiB；執行與排隊逾時預設各 360 秒 |
| `backlog.records[]` 的欄位（派工順序那張） | `bin/fm-fleet-snapshot.sh:490-580` | 有 `state`（`in_flight`、`queued`、`done`）、`hold_kind`、`hold_reason`、`hold_until`、`hold_bucket`、`hold_age_days`、`blocked_by_ids`、`unresolved_blocker_ids`、`current_role`、`captain_actionable`。沒有叫 `blockers` 的欄位 |
| 怎麼判斷自己在 secondmate home（指令介面那張） | `bin/fm-primary-scope-lib.sh:9-20` 的 `fm_root_is_secondmate_home`；標記檔由 `bin/fm-home-seed.sh:993-1000`、`bin/fm-remote-home-provision.sh:271-278` 寫 | 看 `.fm-secondmate-home` 標記檔。這支 lib 可以 source、沒有副作用。原本打算看 parent channel 的綁定，不需要 |
| 本機 secondmate 的 home 路徑怎麼查（同上） | `bin/fm-secondmate-registry-lib.sh:34-104` | `secondmate_registry_field <reg> <id> remote` 與 `… home`。沒有現成的「列出全部」函式，要自己逐行呼叫 `secondmate_registry_parse_line` |
| `secondmates[]` 的 id 能不能當 `fm-send.sh` 的 target（重送那張） | `bin/fm-send.sh:5,490-497,695-703`；`bin/fm-backend.sh:973-990` | 可以：`<id>` 與 `fm-<id>` 都接受，靠主 home 的 `state/<id>.meta` 解析。delivery id 必須是 16 位**小寫**十六進位。不收 `--` 終止符 |
| `fm-send.sh` 沒有 `FM_HOME` 就拒絕（指令介面那張） | `bin/fm-send.sh:255-258` | 是，exit 1 |
| `fm-captain-hold.sh answers` 的輸入與輸出（重送那張） | `bin/fm-captain-hold.sh:84-104,1558-1702` | stdin 每行 `<task-id>\t<answer>\t<label>[\t<mode>]`；`--source` 必填；輸出 `closed:`、`skipped:`、`refused:` 各一行，最後一行 `answers: closed=<n> skipped=<n>`；有任何 skipped 或 refused 就 exit 1。`mode` 是空或 `done` 會把 task 標成完成，`release` 是解除 hold；away 狀態下 `release` 會被 `refused:` |
| `fm-inbox.sh note --request-id` 重放會補叫醒（同上） | `bin/fm-inbox.sh:365-390,436-443` | 是（規劃時已確認）。exit 3 是「已存但沒叫醒」 |
| fork 上的 GitHub Actions 會不會跑（誰來實作那張） | `.github/workflows/ci.yml:3-10`；`no-mistakes-required.yml:4-8` | **不會**。兩個 workflow 都只在 `main` 的 push 與 base 是 `main` 的 PR 觸發。base 是 `carry` 的 PR、推到 `carry`，都不觸發 |
| 上游怎麼啟動常駐程序（服務生命週期那張） | `bin/fm-startup-network.sh:282-299`、`bin/fm-park.sh:236-239`、`bin/fm-remote-job-lib.sh:1467-1477`；`docs/watcher-continuity.md:191-197` | 用 `set -m` 加 `nohup … &`，不用 `setsid`（macOS 沒有這個指令）。票裡引用的 `docs/verification/supervision.md` 只有驗證紀錄，沒有指令的形狀 |
| `config/topic-board-port` 不會被推到 secondmate（同上） | `bin/fm-config-inherit-lib.sh` 的 `FM_INHERITABLE_CONFIG` 是明列的清單 | 不會（規劃時已確認） |
| 上游有沒有其他清單會擋新增的檔 | `tests/`、`bin/fm-lint.sh:23-42`、`.github/workflows/ci.yml:553-558,592-626` | 沒有要求登記 `bin/` 的腳本、沒有要求特定檔頭、沒有禁止新的頂層目錄。會碰到的只有：ShellCheck、禁止直接呼叫 `bd`、bash 3.2 語法檢查、不能追蹤 `data`／`state`／`config`／`projects`／`.no-mistakes`、不能追蹤 `scratchpad*` |
| 上游既有的 TypeScript 怎麼跑 | `tests/fm-commandcode-harness.test.sh:81-100`、`tests/fm-pi-primary-types.test.sh:2-6` | 靠 node 原生的 type stripping，載不了就 `skip:`；型別檢查在暫存目錄臨時裝 TypeScript。repo 裡沒有 `tsconfig.json`、沒有 lockfile。上游對 node 的最低版本沒有明文 |
| 壓縮後會重印啟動摘要（偏好檔那張） | `docs/sessionstart-nudge.md:68-72`；`bin/fm-session-start.sh:1057-1058` | 文件與程式都這樣寫（規劃時已確認）。實際行為仍列在未驗 |

## 二之一、實作時（2026-11-16）補驗的

| 項目 | 做了什麼 | 結果 |
| --- | --- | --- |
| 1-3 到 1-5（部分） | 用真的 `fm-fleet-snapshot.sh` 讀手寫的 `data/backlog.md` | 不帶 `hold-kind` 的 hold 是 `hold_kind: null`、`hold_reason` 原樣；`state`、`hold_until`、`unresolved_blocker_ids` 足以判斷可派；origin 在 `body_lines`，格式 `Captain hold origin: <task-id>`。沒有經過真的 `tasks-axi` 寫入，`unhold` 的確切名稱仍未驗 |
| 3-4 | 30 000 筆、9.9 MB 的 `events.jsonl` | 從下指令到服務可連 0.6 秒 |
| 6-1 | 對新建的 `data/captain-shared.md` 跑上游的 `shared_captain_header_valid` | 通過 |
| C1 的現象 | 第三段的測試裡，假的 `fm-on.sh` 記下收到的呼叫 | 主 home 每次讀取，上游的 snapshot 確實自己去抓一台遠端的 `home-summary.json` |
| 並行啟動 | 三個指令同時啟動服務 | 沒有啟動鎖時會誤判成「埠被別的程式佔用」；加鎖後只留一個服務 |
| 真的 `fm-inbox.sh` | 暫時的 `FM_HOME`，從 API 送一則訊息，執行的是上游原本的腳本 | 已送達：note 存進 `state/inbox/`，request id 有登記 |
| 真的 `fm-send.sh` | 同上，直送一個不存在的 task | 回非 0，寫入記成「失敗」並附 stderr。送到真的 worker 還沒驗 |
| 瀏覽器 | 無頭 Firefox 154 經 WebDriver BiDi 走完整個使用流程 | 通過。Chrome、真的滑鼠拖曳未驗 |
| 上游的檢查 | `bin/fm-doc-audience-check.sh`、`bin/fm-test-run.sh --check-coverage`、`tests/fm-documentation-audiences.test.sh`、`bin/fm-lint.sh` 對三支新腳本 | 都過；六段相對 `carry` 只有新增的檔（91 個） |

## 二之二、主 home 的 first mate（firstmate_ever）幫忙驗的

2026-11-16，在它那邊的隔離 worktree 與暫時的 `FM_HOME`，有 `tasks-axi` 0.2.6。

| 項目 | 結果 |
| --- | --- |
| 整套測試 | `topic-board/test/run.sh` 十支全過，含瀏覽器那一支 |
| 1-3 | `tasks-axi unhold <id>` 存在；`order` 印出的 hold 與 unhold 指令原樣可用。不帶 `--kind` 的 hold 存成 `(hold: topic-board：議題 demo 在待辦)`，snapshot 裡是 `hold_kind: null`、`hold_bucket: null` |
| `order` 的來回 | 待辦議題的項目列在「該 hold」→ 照做之後到「停著」→ 議題移到「高」之後到「該解除」→ 解除之後只在「可派」 |
| 4-4 | `done`：項目移到 Done。`release`：項目留在 Queued、hold 拿掉，`order` 把它列為可派。兩種的 stdout 都是 `closed: <id>`，不能靠輸出分辨 |
| 多行的 hold reason | `tasks-axi` 自己不收多行與括號；`fm-captain-hold.sh` 把 reason 編成 `(hold: fm-hold-v1:<base64>)`，snapshot 會解回來，換行是真的換行。所以「最後一行寫選項」行得通 |
| 1-5 | hold 的 `body_lines` 是 `Captain hold set: <UTC>` 與 `Captain hold origin: <task>`（用 `hold --title` 建的多一行 `Origin: <task>`） |

它沒有試的：直送真的 worker（它的 fleet 是空的）、真的 home 上的行為（要等合併之後套用）。

## 二之三、單元測試與 mutation testing（2026-11-16）

- `pnpm test`：149 個單元測試，10 個測試檔。
- `mutator-axi`，分批跑的結果（被抓到／存活／沒覆蓋）：`topics` 90／0／0；`commands` 134／0／0；`view` 與 `report` 259／0／0；`notifier`、`files`、`store`、`journal` 411／0／0；`actions`、`writes`、`api` 552／0／1；`poller`、`http`、`journal` 642／1／1。各批有重疊，所以不加總。存活的那一個見 [open-issues](open-issues.markdown) 的 C28。
- `crapper-axi`：這些模組的函式 CRAP 都在 10 以下；進入點與頁面不在內。
- 上游自己的 `tests/fm-test-run.test.sh` 在這台有一項失敗（`fm-session-lock-ancestry` 的「pty-host 沒有被 init 收養」）。在不含這個功能的乾淨 `carry` 上跑，同一項一樣失敗，所以和這個功能無關。

## 三、未驗

| 項目 | 原因 | 所屬 |
| --- | --- | --- |
| （這張表是規劃當時的狀態；之後驗到的結果在 [handover](handover.markdown) 第 3 節） | | |
| bash 3.2 的語法相容、`shfmt` 的格式 | 沒有 bash 3.2、沒有 docker 權限、沒有裝 `shfmt` | 第一段的驗收 |
| 進入點與頁面程式的 CRAP 分數 | `board-server.ts`、`board-client.ts`、`src/page/` 只有整合測試，覆蓋率工具看不到 | 第二、五段 |
| 服務活過 Claude Code session 結束 | 要結束目前的 session 才能驗，這次做不到。已驗到的部分見上 | 第二段 2-1 |
| macOS 上比對 `pid` 的指令列 | 這台是 Linux | 第二段 2-2 |
| `tsc` 的輸出跨機器逐位元組相同 | 這次沒有裝 `typescript` | 第二段 2-3 |
| task 多時一次 snapshot 的耗時 | 這個 home 沒有任何 task | 第一段 1-2 |
| 主 home 每輪抓遠端摘要的成本 | 沒有 secondmate | 第一段 1-1 |
| `fm-on.sh` 經遠端 lane 的排隊延遲與 job 逾時 | 沒有 secondmate | 第一段 1-6 |
| 遠端 job 的環境讀不讀得到 pane | 沒有 secondmate | 第一段 1-7 |
| 用主 home 的程式碼對同機 secondmate home 跑 `answers` | 沒有 secondmate | 第一段 1-8 |
| parent channel 的每一行帶子 task 的 id；手上的文字夠寫摘要 | 沒有 secondmate | 第三段 3-1、3-2 |
| 遠端沒有彙整腳本時 stderr 的確切字串 | 沒有 secondmate | 第三段 3-3 |
| secondmate 照字面轉達「轉給」的訊息、轉不出去時回報 | 沒有 secondmate，而且要先裝規則 | 第四段 4-2 |
| `fm-on.sh --stdin … answers` 寫進遠端的 hold | 沒有 secondmate | 第四段 4-3 |
| `done` 與 `release` 兩種作答之後，被 hold 的項目各變成什麼狀態、會不會被 `order` 列為可派 | 沒有 `tasks-axi` | 第四段 4-4 |
| 設了容量之後照 `order` 的順序拿空位 | 主 home 還不能派工 | 上線 R-7 |
| 原生拖放在 Chrome 上；議題很多時的側欄；兩個情境的截圖 | 這次沒有開瀏覽器 | 第五段 5-1 到 5-3 |
| first mate 會不會照規則在對的時機跑指令 | 主 home 還不能用；這是整個看板最依賴模型的地方 | 第六段 6-2 |
| 壓縮後 Claude Code 實際重印了摘要 | 主 home 還不能用 | 第六段 6-3 |
| stow 之後區塊的標記還在 | 主 home 還不能用 | 第六段 6-4 |
| 上線的順序在真機走得通；遠端 agent 跑的是哪一份 `bin/`；遠端用 https 讀得到 fork；用網址 fetch 上游再合併；遠端 home 的 `origin` 實際字串 | 沒有 secondmate；還沒有東西可以上線 | 上線 R-1 到 R-4、R-6 |
| `gh pr create` 的實際落點 | 這次不開 PR | 上線 R-5 |
