# first mate 這一側：看板在 fork 裡的交接

看板本身的交接（看板自己的測試怎麼跑、每個問題的狀態、驗證的結果、已知限制）在看板的 [handover](../../myshape/spec/handover.markdown)。
這一頁是 fork 這一側的：first mate 這一側的測試怎麼跑，與 fleet 接手之後的分工。
上線的前提與步驟在 [rollout](rollout.markdown)；first mate 這一側的指令與它依賴的框架介面在 [adapter](adapter.markdown)。

## 1. 怎麼跑 first mate 這一側的測試

和看板自己的測試一樣，全部在 fork 的 checkout 裡跑，不需要真的 home，只寫自己建的暫存目錄，服務開在當下空著的埠；需要的工具見看板的 handover 第 1 節。
這一側另外要的：

| 工具 | 用在 | 沒有的時候 |
| --- | --- | --- |
| `tasks-axi` | `fm-board/test/stage-4-writes.sh` 與 `stage-2-deliver.sh` 裡對真的 hold 工具的那一個測試 | 那一個測試印 `ok - skip: tasks-axi not found` |
| `firefox`（在 `PATH` 上） | `fm-board/test/stage-5-page.sh`，用真的瀏覽器走一遍接上 first mate 的頁面 | 印 `skip: firefox not found` 後結束 |

指令（工作目錄是 checkout 的根目錄）：

```
fm-board/test/run.sh                  # 這一側的全部：feed、deliver、tag、setup、--in-home、帶 task 的 split、彙整腳本、session start 的檢查、接上 first mate 的第三到五段、跨 fork 歷史的升級、舊的要你動手、規則、安裝說明、改名前的名字
dispatch-plan/test/run.sh             # order、queues-in、queues-push
bash fm-board/test/stage-4-writes.sh  # 單跑一個腳本
bin/fm-doc-audience-check.sh          # 上游的檢查；新增的檔不能違反
shellcheck -x bin/fm-board.sh bin/fm-board-lib.sh bin/fm-board-io-lib.sh bin/fm-topic-board-read.sh bin/fm-topic-session-start.sh bin/fm-dispatch-plan.sh fm-board/test/*.sh dispatch-plan/test/*.sh
```

- 這一側的測試 source 上游的 `tests/lib.sh`，再 source `fm-board/test/helpers.sh`：它先載入看板的測試套件 `myshape/test/kit/helpers.sh`，再加上建 first mate 的 home 與替身的那幾個（`tb_write_registry`、`tb_seed_unstarted`、`tb_make_fake_root`）。`dispatch-plan/test` 只用測試套件。
- `stage-1-read.sh` 測彙整腳本 `bin/fm-topic-board-read.sh`，`stage-2-startup.sh` 測 session start 的檢查 `bin/fm-topic-session-start.sh`，跑的是真的框架指令。
- 第三到五段（`stage-3-data.sh`、`stage-4-writes.sh`、`stage-5-http.sh`、`stage-5-page.sh`）跑接上真的 `bin/fm-board.sh` 的看板與框架的替身；看板只接替身 aggregator 的版本是看板自己的第七段。`stage-2-topics-tag.sh` 跑看板改過的議題（合併過的 id、開服務時確認的提議）接上 `fm-board.sh tag`。
- `stage-7-upgrade.sh` 從 fork 歷史裡釘住的 commit 起舊版看板，所以只能在有完整歷史的 checkout 裡跑；看板自己的 repo 沒有這些 commit。
- 送訊號：這一側的測試經 `tests/lib.sh` 的 `fm_test_signal`（守門 helper `tests/signal-guard.sh`）、經看板的 `myshape/test/signal-lib.sh` 的 `kill_own_child`（看板的守門 helper `myshape/test/signal-guard.sh`），或直接對自己剛用 `&` 啟動、記下 `$!` 的子程序送。
  `fm-board/test` 與 `dispatch-plan/test` 由上游的 `tests/check-signals.sh` 靜態檢查，`bin/fm-lint.sh` 每一次都跑它；看板自己的 `myshape/test/check-signals.sh` 只檢查 `myshape/test`。
- 範圍：遠端的 home 只跑 `bin/fm-topic-board-read.sh` 與 `bin/fm-board.sh`（`tag`、`setup`），不跑服務也不開頁面，所以在 Mac 上要過的是看板的第一段（`myshape/test/run.sh 1`）、`fm-board/test/stage-1-read.sh` 與 `stage-1-tag.sh`。
- ShellCheck 會對 `tests/lib.sh` 的 source 報 SC1091，可以忽略；其他的要是零。

## 2. 交接之後誰做什麼

- 使用者 2026-11-17 決定：做看板的那個 session 到完工線就停，之後不再從它推送看板的修改。看板的修改與 PR 走 fleet 的流程，和 fork 上其他的修改一樣由使用者經主 first mate 決定要不要合併。
- 看板 handover 第 3 節「還開著」的項目與第 4 節「延後、之後要補的」由 fleet 接手。
- 上游的新版合併進 `carry`：fleet 負責，見 [rollout](rollout.markdown)「之後怎麼更新」。
- 看板的檔案是 `myshape/**` 與 `bin/myshape*.sh`，另外在上游的 `bin/fm-session-start.sh` 裡有一個呼叫點（[adapter](adapter.markdown) 第 9 節），`bin/fm-captain-hold.sh` 裡有兩處（adapter 第 8 節）。改到 adapter 第 7 節列的任何一支框架指令時，跑那一列寫的測試。
- first mate 這一側接看板的檔是 `bin/fm-board.sh`、`bin/fm-board-lib.sh`、`bin/fm-board-io-lib.sh`、`bin/fm-dispatch-plan.sh`、`fm-board/**` 與 `dispatch-plan/**`（[adapter](adapter.markdown)）；改它們走同樣的流程，這一節的規則也適用。
- 規則範本改了要升版本號（`fm-board/rules/captain.block.md.tmpl` 第一行），`fm-board/test/stage-6-rules.sh` 裡的版本與 token 上限跟著改，真的 home 由使用者明講之後重跑 `bin/fm-board.sh install-rules`。
- 看板每次修改（程式、指令、規則範本、需要的工具）都要在同一個修改裡對照新機器的安裝說明 [FORK-SETUP](../../FORK-SETUP.markdown)，改掉不一致的地方。
  PR 說明要寫出那一頁查過了、改了什麼。
  `fm-board/test/check-guide.sh`（`fm-board/test/run.sh` 會跑）只檢查那一頁引用的名稱存在、寫的規則範本版本正確；步驟的順序、每一步的輸出、平台與需要的工具要讀過才知道，清單在那一頁的最後一節。
