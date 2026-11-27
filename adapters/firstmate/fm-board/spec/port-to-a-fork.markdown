# 移植到另一個 Firstmate fork：看板的 port kit

這一頁給一個不跟 `carry` 的 Firstmate fork 的 first mate（例如工作機上的 fork）照著做，讓那個 fork 用上看板與 first mate 這一側。
讀者是 agent，只有公開的 HTTPS 讀取權限；這一頁引用的每個網址都釘在一個 commit 上，或是 raw 網址，不需要登入。
那個 fork 不切換到 `carry`，也不把自我更新指向 `carry`：它照舊跟著自己的 fork 前進，看板經它自己的兩個 PR 進來。
`carry` 的安裝說明是 [FORK-SETUP](https://github.com/guybeju/firstmate/blob/010e1a06302f81e7ce8db9b359e781879949587a/FORK-SETUP.markdown)；第 7 節的表寫出它哪些步驟這裡照做、哪些不做。

## 0. 釘住的版本

| 東西 | 值 |
| --- | --- |
| 產生 patch 的上游 commit（`carry` 與上游 `main` 的 merge-base） | kunchenguid/firstmate [`427056c4181c41074ad24f051f79919330df0fa5`](https://github.com/kunchenguid/firstmate/commit/427056c4181c41074ad24f051f79919330df0fa5)（2026-11-12） |
| patch 的來源 | guybeju/firstmate `carry` [`010e1a06302f81e7ce8db9b359e781879949587a`](https://github.com/guybeju/firstmate/commit/010e1a06302f81e7ce8db9b359e781879949587a)（#77 之後） |
| 演練時上游 `main` | [`2f000eb4301c2d733bef163621e9ac3d740f21cf`](https://github.com/kunchenguid/firstmate/commit/2f000eb4301c2d733bef163621e9ac3d740f21cf)（2026-11-24）；patch 在它與 427056c4 上都 `git apply --check` 通過，兩者之間沒有 commit 改到 patch 碰的檔 |
| 要 vendor 的 guybeju/myshape commit | [`7e03a5a334aa3c4767ea90ae9d8f78736f7ba771`](https://github.com/guybeju/myshape/commit/7e03a5a334aa3c4767ea90ae9d8f78736f7ba771)，`main` 的 first-parent 鏈上；它的 push run [45545973958](https://github.com/guybeju/myshape/actions/runs/45545973958) 的 `Board` 與 `Firstmate adapter` 兩個 job 都是 success |
| vendor 腳本 | 那個 commit 的 [`adapters/firstmate/bin/fm-board-vendor.sh`](https://github.com/guybeju/myshape/blob/7e03a5a334aa3c4767ea90ae9d8f78736f7ba771/adapters/firstmate/bin/fm-board-vendor.sh)，mode 100755，blob `addb3a80c2eb17e83253db3bb44ff830fe93419b` |
| `01-hook-points.patch` | [raw](https://raw.githubusercontent.com/guybeju/myshape/7dc2f9fe84d54aaad86d2a3526301a002bdd7ec7/adapters/firstmate/fm-board/port/01-hook-points.patch)，sha256 `9dbdb8d1f3aaf44228242606706fca4047a712c688119fd721c51ab4526ba997` |
| `02-handoff-queues-push.patch` | [raw](https://raw.githubusercontent.com/guybeju/myshape/7dc2f9fe84d54aaad86d2a3526301a002bdd7ec7/adapters/firstmate/fm-board/port/02-handoff-queues-push.patch)，sha256 `796a8ec139053aee3631b92613c759da3c2daa2222f648499bebd0076f7c3545`；只有遠端 second mate 時才要（第 2.3 節） |

下面的寫法：`<checkout>` 是 worker 自己的那個 fork 的 checkout，停在 fork 的 `main`、工作目錄乾淨，不是 home；`<home>` 是那台機器的主 home（clone 下來的目錄，同時是它的 code root）；`<mb>` 是第 1.1 節算出來的 merge-base。
第 1 節只讀：在 `<checkout>` 裡只有 `git fetch` 會寫（物件與 `FETCH_HEAD`），在 `<home>` 裡什麼都不寫。
先把兩個 patch 下載到 checkout 外面的暫存目錄，並對照上表的 sha256：

```
K=$(mktemp -d)
curl -fsS -o "$K/01-hook-points.patch" https://raw.githubusercontent.com/guybeju/myshape/7dc2f9fe84d54aaad86d2a3526301a002bdd7ec7/adapters/firstmate/fm-board/port/01-hook-points.patch
curl -fsS -o "$K/02-handoff-queues-push.patch" https://raw.githubusercontent.com/guybeju/myshape/7dc2f9fe84d54aaad86d2a3526301a002bdd7ec7/adapters/firstmate/fm-board/port/02-handoff-queues-push.patch
sha256sum "$K"/*.patch        # macOS：shasum -a 256 "$K"/*.patch
```

sha256 不同就停下，不要套用。

## 1. 先查清楚：base、hook 點、fork 自己的舊看板

### 1.1 fork 的 base

```
git -C <checkout> fetch --no-tags https://github.com/kunchenguid/firstmate main
git -C <checkout> rev-parse FETCH_HEAD
git -C <checkout> merge-base HEAD FETCH_HEAD                 # 這就是 <mb>
git -C <checkout> merge-base --is-ancestor 427056c4181c41074ad24f051f79919330df0fa5 HEAD && echo has-427056c4
git -C <checkout> cat-file -t 5c2a7028
git -C <checkout> log --format='%h %cs %s' <mb>..HEAD
```

- 之前回報這個 fork 跟著上游的 `5c2a7028`，但 `5c2a7028` 不是上游的 commit：在 2026-11-25 公開 clone 的 kunchenguid/firstmate（`main` 是 2f000eb4）裡沒有這個物件。
  它可能是 fork 自己的 commit（例如自己合併上游的那一個），所以不要假設它是 base，用 `merge-base` 算出來的 `<mb>`。
- `has-427056c4` 印出來：fork 至少已經合併到 patch 產生的那一點，patch 預期能套上。
- 沒印出來：fork 的 base 比 427056c4 舊，patch 可能套不上某些檔；照第 1.2 節逐檔判斷，套不上的照第 2 節的文字手動移植。
- `cat-file` 印 `commit`：5c2a7028 在這個 fork 的歷史裡，是 fork 自己的 commit；印 `fatal: Not a valid object name` 就表示這個 fork 也沒有它，那個數字記錯了。
  兩種都不影響下面的步驟。
- 最後一行列的是 fork 自己在上游之外的每個 commit；第 1.3 節要從裡面找出舊看板的那幾個。

再確認 first mate 這一側用到的上游介面都在（[adapter](https://github.com/guybeju/myshape/blob/7e03a5a334aa3c4767ea90ae9d8f78736f7ba771/adapters/firstmate/fm-board/spec/adapter.markdown) 第 7 節）；每一行都要印 `ok`：

```
while read -r f w; do
  if git -C <checkout> grep -q -F -e "$w" HEAD -- "$f"; then echo "ok      $f $w"; else echo "MISSING $f $w"; fi
done <<'EOF'
bin/fm-primary-scope-lib.sh fm_root_is_secondmate_home()
bin/fm-secondmate-registry-lib.sh secondmate_registry_field()
bin/fm-secondmate-registry-lib.sh secondmate_registry_parse_line()
bin/fm-wake-lib.sh fm_firstmate_root_home()
bin/fm-config-inherit-lib.sh shared_captain_header_valid()
bin/fm-timeout-lib.sh fm_run_timed()
bin/fm-timeout-lib.sh fm_timed_out()
bin/fm-tasks-axi-lib.sh fm_tasks_axi_backend()
bin/fm-backlog-transition-lib.sh fm_backlog_data_absolute()
bin/fm-backlog-transition-lib.sh fm_backlog_root()
bin/fm-hold-reason-lib.sh fm_hold_reason_encode
bin/fm-on.sh --stdin
bin/fm-send.sh --fire-and-forget
bin/fm-inbox.sh --request-id
bin/fm-captain-hold.sh --source
bin/fm-startup-memory-budget.sh report
bin/fm-check-register.sh fm-check-register
bin/fm-fleet-ledger.sh appended
bin/fm-fleet-snapshot.sh --json
bin/fm-tasks-axi.sh tasks-axi
bin/fm-lock.sh fm-lock
EOF
```

有 `MISSING` 時停下：那個 fork 的上游太舊，先合併較新的上游，或把那一行回報給自己的 captain；這一頁不處理。

### 1.2 四個 hook 點在不在

hook 點是上游檔案裡接看板的地方，vendor 不會帶來，每個 fork 要自己移植一次（第 2 節）。
逐檔用 patch 本身判斷：

```
for f in bin/fm-backlog-archive-lib.sh bin/fm-captain-hold.sh bin/fm-fleet-snapshot.sh bin/fm-session-start.sh; do
  if git -C <checkout> apply --reverse --check --include="$f" "$K/01-hook-points.patch" 2>/dev/null; then echo "present   $f"
  elif git -C <checkout> apply --check --include="$f" "$K/01-hook-points.patch" 2>/dev/null; then echo "absent    $f"
  else echo "different $f"; fi
done
```

- `absent`：fork 沒有這個 hook 點，patch 能直接套上，第 2 節照做。
- `present`：已經和 `carry` 的一樣，這個檔不用再套（套 patch 時用 `--exclude=<檔>`）。
- `different`：fork 的這個檔和 patch 預期的不同，可能是 base 不同，也可能是 fork 自己的舊看板改過它（第 1.3 節）。
  先處理第 1.3 節，再查一次；還是 `different` 就照第 2 節的文字手動移植。

四個 hook 點各自的直接檢查（第 5 節驗收時也用）；在上游 `main` 上四個都沒有輸出：

```
git -C <checkout> grep -n -F fm_backlog_archived_done_ids HEAD -- bin/fm-fleet-snapshot.sh   # 封存 blocker 的修正
git -C <checkout> grep -n -F -e '--on-answer) shift' HEAD -- bin/fm-captain-hold.sh         # hold --on-answer
git -C <checkout> grep -n -F 'record_hold_line "$id"' HEAD -- bin/fm-captain-hold.sh        # 事件紀錄
git -C <checkout> grep -n -F 'fm-topic-session-start.sh' HEAD -- bin/fm-session-start.sh    # session start 的呼叫點
```

第五個是可選的：`git -C <checkout> grep -n -F 'queues-push --to' HEAD -- bin/fm-backlog-handoff.sh`（第 2.3 節）。

### 1.3 fork 自己的舊看板

這個 fork 據報有三個自己的看板修改，用的是改名（myshape）之前的名字 `bin/fm-topic.sh`。
現在的看板指令是 `bin/myshape.sh`，舊名字的提示與搬家指令都已經拿掉（guybeju/firstmate [#75](https://github.com/guybeju/firstmate/commit/763b758ba65ccf0d5d766690c7195c8b39602a29)），舊指令與新指令的對照在 [adapter](https://github.com/guybeju/myshape/blob/7e03a5a334aa3c4767ea90ae9d8f78736f7ba771/adapters/firstmate/fm-board/spec/adapter.markdown) 第 2 節。

在 `<checkout>` 找 fork 裡的舊看板程式：

```
git -C <checkout> diff --name-status <mb> HEAD
git -C <checkout> ls-files -- 'bin/fm-topic*' 'bin/fm-board*' bin/myshape.sh bin/myshape-lib.sh bin/fm-dispatch-plan.sh bin/fm-queue-source-lib.sh topic-board myshape fm-board dispatch-plan myshape.lock
git -C <checkout> grep -n -e fm-topic -e topic-board HEAD -- . ':(exclude)topic-board'
git -C <checkout> log --format='%h %cs %s' <mb>..HEAD -- 'bin/fm-topic*' topic-board .gitignore bin/fm-session-start.sh bin/fm-captain-hold.sh bin/fm-fleet-snapshot.sh
```

會找到的種類與它們的意思：

- `bin/fm-topic.sh`、`bin/fm-topic-lib.sh`、`topic-board/**`：舊看板的程式，第 2.1 節拿掉。
- `bin/` 底下、vendor 清單也有的名字（例如 `bin/fm-topic-board-read.sh`、`bin/fm-topic-session-start.sh`、`bin/fm-dispatch-plan.sh`）：還沒有 `myshape.lock` 時，vendor 只接受和要 vendor 的 commit 位元組相同的追蹤檔，舊版一定不同，所以第 2.1 節也拿掉。
- `.gitignore` 裡的 `/topic-board/`：第 2.1 節拿掉。
- 舊看板在上游檔案裡的修改（例如 `bin/fm-session-start.sh` 叫 `fm-topic.sh` 的地方）：第 2.1 節還原成 `<mb>` 的樣子，再由第 2.2 節的 patch 換成現在的呼叫點。

在 `<home>` 找舊看板的資料（只讀）：

```
ls -ld <home>/state/topic-board <home>/data/topic-board <home>/config/topic-board-port <home>/data/topics.json <home>/data/topics-archive.json
ls -ld <home>/state/myshape <home>/data/myshape <home>/config/myshape-port <home>/config/myshape-aggregator.json
grep -n -e '<!-- topic-board:begin' -e '<!-- topic-board:end' <home>/data/captain.md <home>/data/captain-shared.md
FM_HOME=<home> FM_CREW_STATE_NO_FORGE=1 <home>/bin/fm-fleet-snapshot.sh --json \
  | jq -r '.backlog.records[] | select((.hold_reason // "") | startswith("topic-board：")) | "\(.id)\t\(.hold_reason)"'
GIT_OPTIONAL_LOCKS=0 git -C <home> status --short --ignored -- topic-board
```

- 第一行的五個路徑是舊看板存的東西：`state/topic-board/`（服務的狀態、token、寫入紀錄、規則備份）、`data/topic-board/`（事件與摘要）、`config/topic-board-port`、議題檔 `data/topics.json` 與封存 `data/topics-archive.json`。
- 第二行在還沒有 myshape 的 home 應該全部不存在；有的話先回報，不要往下做。
- `grep` 找的是舊規則的標記區塊（`install-rules` 寫的，標記 `<!-- topic-board:begin …` 到 `<!-- topic-board:end -->`）。
- snapshot 那一行列出原因以 `topic-board：` 開頭的 hold：舊版 `order` 為看板佇列 hold 的項目。
  snapshot 會把 `fm-hold-v1:` 編碼的原因解回原文，所以用它而不是直接 grep `data/backlog.md`。
- `status` 那一行列出 code root 裡 `topic-board/` 底下沒追蹤的東西（例如 `node_modules/`）。

**怎麼判斷：**

- 上面五個路徑、舊標記、`topic-board：` hold、`topic-board/` 的殘留都沒有：直接做第 2 節。
- 有任何一個：**在 vendor 之前停下，問這台機器自己的 captain**，把下面這段原樣給 captain 看，等 captain 明講。

> 這台的舊議題看板（`fm-topic.sh` 那一版）留著資料：<列出第 1.3 節找到的每一項>。
> 現在的看板（guybeju/myshape 7e03a5a）沒有任何把舊版資料搬過來的程式：搬家的 `migrate-myshape` 已經在 guybeju/firstmate #75 拿掉，而它也只走 `carry` 的路，這台不跟 `carry`。
> 照預設做法，看板會從空的開始，頁面上看不到：每個議題與它的佇列和順序、議題的來歷、封存、要你動手的項目、頁面上的寫入歷史。
> backlog 裡的項目本身不會少，captain 的待決事項（captain hold）也都還在 backlog 裡，看板會照常顯示還開著的。
> 原因以 `topic-board：` 開頭的 hold 不會再被 `order` 放行，要一個一個決定放掉或留著。
> 舊的規則區塊要手動拿掉，否則會和新的規則並存。
> 要保留舊議題，得在 guybeju/myshape 另外寫一個搬家程式，經過審查與測試才能用；這一頁不做。
> 預設做法不刪任何東西：舊的檔與目錄都改名成帶日期的 `*.retired-<日期>`，可以隨時看回去。
> 要照預設做嗎？

captain 同意預設做法時（下面的 `<日期>` 是當天，例如 `20261126`；只動存在的那幾個）：

1. 趁 home 還有舊指令時停掉舊服務：`FM_HOME=<home> <home>/bin/fm-topic.sh stop`。
   舊指令的 `--help` 沒有 `stop`、或停不下來時，停下並回報，不要自己殺程序。
2. 把舊的資料改名，不刪：

   ```
   mv <home>/state/topic-board <home>/state/topic-board.retired-<日期>
   mv <home>/data/topic-board <home>/data/topic-board.retired-<日期>
   mv <home>/config/topic-board-port <home>/config/topic-board-port.retired-<日期>
   mv <home>/data/topics.json <home>/data/topics.json.retired-<日期>
   mv <home>/data/topics-archive.json <home>/data/topics-archive.json.retired-<日期>
   ```

   議題檔也移開，因為現在的看板讀的也是 `data/topics.json` 與 `data/topics-archive.json`；舊版寫的這兩個檔能不能被它讀懂沒有測過，所以和其他舊資料一樣移開，看板從空的開始。
3. 列出第 1.3 節找到的每個 `topic-board：` hold（id 與原因），由 captain 一個一個決定；captain 說要放掉的，first mate 跑 `bin/fm-tasks-axi.sh unhold <id>`。
   看板接上之後，新的 `order` 會照新的佇列用 `看板佇列：` 開頭的原因重新 hold 需要的項目。
4. 舊的規則區塊：先備份（`cp -p <home>/data/captain.md <home>/state/captain.md.retired-<日期>`，`captain-shared.md` 也一樣），再用編輯器刪掉從 `<!-- topic-board:begin` 那一行到 `<!-- topic-board:end -->` 那一行（含），區塊外的不動；之後第 1.3 節的 `grep` 要沒有輸出。
5. code root 裡 `topic-board/` 的殘留：等第 2.1 節的 PR 合併、home 更新、追蹤的檔被拿掉之後，把剩下的目錄移到 `state/` 底下（`mv <home>/topic-board <home>/state/topic-board-code.retired-<日期>`），因為 `.gitignore` 不再忽略它，留在原地會讓 checkout 變髒、更新被跳過。

captain 要保留舊議題時：停下，回報需要一個新的搬家程式，由 captain 決定要不要在 guybeju/myshape 開這件工作；這一頁到此為止。

## 2. hook 點的 PR

在 `<checkout>` 從 fork 的 `main` 開一個分支（例如 `board-hook-points`），裡面依序是 2.1 的退役（有舊看板時）與 2.2 的 patch，開一個 base 是 fork `main` 的 PR。
這個 PR 合併、home 更新之前，第 1.3 節的資料要先照 captain 的決定處理好：home 一旦更新到 2.1，就沒有舊指令可以停舊服務了。

### 2.1 拿掉 fork 的舊看板（第 1.3 節找到時）

- 先試著反轉那三個舊看板的 commit，新的先：`git -C <checkout> revert --no-edit <最新的> <中間的> <最舊的>`。
- 有衝突就 `git -C <checkout> revert --abort`，改成一個手動的 commit：`git -C <checkout> rm -r -- <第 1.3 節列出的舊程式路徑>`；上游檔案裡舊看板改的那幾行改回 `<mb>` 的樣子（那個檔在 fork 上只有看板的修改時，`git -C <checkout> checkout <mb> -- <檔>`；還有別的修改時手動只拿掉看板的那幾行）；`.gitignore` 拿掉 `/topic-board/`。
- 做完再跑一次第 1.2 節，四個都要是 `absent` 或 `present`。

### 2.2 套上 hook 點

```
git -C <checkout> apply --check "$K/01-hook-points.patch"
git -C <checkout> apply --index "$K/01-hook-points.patch"
git -C <checkout> commit -m 'Port the board hook points from guybeju/firstmate carry 010e1a06'
```

第 1.2 節是 `present` 的檔加 `--exclude=<檔>`；是 `different` 的檔也加 `--exclude=<檔>`，再照下表的文字手動移植那個檔。
patch 是 `git diff 427056c4..010e1a06`（guybeju/firstmate）在這四個檔上的結果，只留看板需要的 hunk；每一個 hunk 在做什麼：

| 檔 | hunk（patch 裡的行號） | 來自 | 做什麼 |
| --- | --- | --- | --- |
| `bin/fm-backlog-archive-lib.sh` | 新檔，75 行，mode 100644 | [#67](https://github.com/guybeju/firstmate/commit/99ec56013ffcc24d4ba2eba3451c8de8281b4bec) | 只被 source；source `fm-tasks-axi-lib.sh` 與 `fm-backlog-transition-lib.sh`。`fm_backlog_archive_path <data 目錄>` 照 tasks-axi 自己的順序找 Done 封存檔（backlog 根目錄的 `.tasks.toml`、`$HOME/.tasks-axi/config.toml` 的 `[markdown] archive`，都沒有時是 backlog 旁的 `done-archive.md`），backend 不是 markdown 時回 1。`fm_backlog_archived_done_ids <封存檔>` 印出每個打勾的列（`- [x] <id> - …`）的 id 一次，讀不到就什麼都不印 |
| `bin/fm-fleet-snapshot.sh` | `@@ -232` | #67 | 在 source `fm-hold-reason-lib.sh` 之後 source `fm-backlog-archive-lib.sh` |
| | `@@ -390` | #67 | `backlog_json` 用 `fm_backlog_archive_path` 找封存檔（找不到用 `/dev/null`），把 `fm_backlog_archived_done_ids` 的輸出用 `--rawfile archived` 交給 jq |
| | `@@ -553` | #67 | jq 裡把封存的 id 做成一張表；`unresolved_blocker_ids` 對 backlog 裡有紀錄的 blocker 照舊看它是不是 Done，沒有紀錄的看它在不在封存表裡。看板讀之前的能力檢查（adapter 第 3.1 節）找的就是這個檔裡的 `fm_backlog_archived_done_ids` |
| `bin/fm-captain-hold.sh` | `@@ -21` | [#48](https://github.com/guybeju/firstmate/commit/25912f41969175f7caa14ee947e2bb7852c14f72) | 用法那一行加 `[--on-answer close\|release]`；`usage()` 印的就是檔頭，所以這是 `--help` 的內容 |
| | `@@ -58` | #48 | 檔頭（也是 `--help`）一段說明 `--on-answer`：在 hold 內文寫一行 `Captain hold on answer: close\|release`；同一個 hold 重複開而不帶旗標時保留，新的一輪不帶時拿掉上一輪的 |
| | `@@ -283` | [#64](https://github.com/guybeju/firstmate/commit/e01f25fe7d836510cf56293f132154597bb6b04b) | 新函式 `record_hold_line <task-id> <occurrence> <verb>`：在 `state/captain-hold-events.jsonl` 加一行 `{"v":1,"ts":<epoch>,"task":"<id>","occurrence":<n>,"event":"held"\|"resolved"}`，寫不進去時 stderr 印一行 `actionable:`、不影響其他；`publish_parent_hold` 一開始就呼叫它 |
| | `@@ -889` | #48 | `write_hold_origin <id> <body> <origin>` 改成通用的 `write_hold_line <id> <body> <label> <value>`：拿掉內文裡已有的 `Captain hold <label>: ` 那一行，在 hold-set 戳記那一行後面寫新的；值是空的就只拿掉；暫存檔與錯誤訊息跟著用 `<label>` |
| | `@@ -1117` | #48 | `command_hold` 的 local 加 `on_answer=''` |
| | `@@ -1128` | #48 | 解析 `--on-answer <值>`；值只能是空、`close` 或 `release`，否則 `fail "--on-answer must be close or release: <值>"` |
| | `@@ -1226` | #48 | 記 origin 改用 `write_hold_line … origin`，之後重新 `task_show_or_fail` 讀一次；然後帶了 `--on-answer`，或是新的一輪 hold（`preserve_hold_set` 是 0）而內文還有舊的 `Captain hold on answer:` 那一行時，用 `write_hold_line … 'on answer' <值>` 寫上或拿掉 |
| `bin/fm-session-start.sh` | `@@ -1026` | [#47](https://github.com/guybeju/firstmate/commit/8df1dff8e62ba3d99f58881274b005f0eeabaa47) | 在 fleet state 那一段的最後、`# --- 7. network checks` 之前，只有拿到鎖而且不是 `--reemit` 時（`READ_ONLY` 與 `REEMIT` 都是 0）執行 `FM_HOME="$FM_HOME" "$SCRIPT_DIR/fm-topic-session-start.sh" 2>/dev/null \|\| true`，它的輸出原樣印進啟動摘要；那支腳本由 vendor 帶來，還沒 vendor 時這一行什麼都不印 |

`bin/fm-session-start.sh` 在 `carry` 上和上游差 35 行，patch 只取上面 6 行的呼叫點；其餘的 hunk（檔頭與 `--reemit`、唯讀時印的說明提到看板）只是說明，看板不需要，沒有放進 patch。
同樣只是註解、沒有放進 patch 的還有 `bin/fm-fleet-snapshot.sh` 的 `@@ -24`（檔頭說明封存的 blocker 也算已解決）與 `bin/fm-captain-hold.sh` 的 `@@ -874`（`body_hold_origin` 上面的一行註解）；這兩個檔的 `usage()` 不印那些行。

### 2.3 遠端 second mate 才要的 `02-handoff-queues-push.patch`

`data/secondmates.md` 裡有遠端的 second mate 時，也套 `02-handoff-queues-push.patch`（來自 guybeju/firstmate [#60](https://github.com/guybeju/firstmate/commit/0511f0c1c5f319364ad5a3f5a934b770b1aeaa7d)，同一個範圍）：`bin/fm-backlog-handoff.sh` 在把 backlog 項目交給遠端 second mate、傳送之前，先跑 `fm-dispatch-plan.sh queues-push --to <id>` 把看板的佇列副本送過去，結果不影響交接。
patch 只有這個呼叫；`carry` 另外在檔頭加了三行說明，只是註解，沒有放進 patch。
少了它時，佇列副本照樣由主 home 的固定檢查每 5 分鐘送一次（[dispatch-plan](https://github.com/guybeju/myshape/blob/7e03a5a334aa3c4767ea90ae9d8f78736f7ba771/adapters/firstmate/dispatch-plan/spec/dispatch-plan.markdown) 第 5 節），只是剛交出去的項目可能在副本送到之前用舊副本檢查議題。
只有主 home 或只有同機的 second mate 時不用套。

### 2.4 四個 PR 碰過的每個檔

`carry` 的 #47、#48、#64、#67 是看板還在 `carry` 裡開發時的 PR，所以碰到很多看板自己的檔；下表把每個檔分成三類，加上沒放進 patch 的測試。
「vendor 帶來」的檔今天在 guybeju/myshape，第 3 節的 vendor 把 7e03a5a 的版本帶進 fork；舊名字 `topic-board/` 的檔，今天的版本在括號裡的位置。

| PR | 移植（patch 01） | vendor 帶來 | 不需要（fork 專屬，或只在 guybeju/myshape） | 測試，不在 patch 裡 |
| --- | --- | --- | --- | --- |
| #47 | `bin/fm-session-start.sh`（只有呼叫點） | `bin/fm-topic-session-start.sh`；`topic-board/spec/README.markdown`、`contracts.markdown`、`handover.markdown`、`stage-2-service.markdown`（`myshape/spec/`）；`topic-board/test/stage-2-startup.sh`（`fm-board/test/`） | `FORK-SETUP.markdown`；`.agents/skills/session-start-recovery/SKILL.md`（多一句說明啟動摘要裡的 `看板服務：` 那一行）；`bin/fm-topic.sh`（舊名字，#75 拿掉） | - |
| #48 | `bin/fm-captain-hold.sh`（`--on-answer`） | `bin/fm-topic-board-read.sh`；`topic-board/dist/actions.js`、`api.js`、`board-server.js`、`page/board.js`、`page/parts.js`、`report.js`、`view.js`（`myshape/dist/`）；`topic-board/rules/captain-shared.block.md.tmpl`（`fm-board/rules/`）；`topic-board/spec/README.markdown`、`contracts.markdown`、`handover.markdown`、`open-issues.markdown`、`stage-4-writes.markdown`、`stage-5-browser.markdown`、`stage-6-rules.markdown`（`myshape/spec/`）；`topic-board/test/stage-1-read.sh`、`stage-4-writes.sh`、`stage-5-http.sh`、`stage-5-page.mjs`、`stage-5-page.sh`、`stage-6-rules.sh`（`fm-board/test/`） | `FORK-SETUP.markdown`；`bin/fm-topic.sh`；`topic-board/src/actions.ts`、`api.ts`、`board-server.ts`、`page/board.ts`、`page/parts.ts`、`page/state.ts`、`report.ts`、`report.test.ts`、`sending.test.ts`、`view.ts`、`view.test.ts`（看板的原始碼，在 guybeju/myshape 的 `myshape/src/`；fork 只要編譯好的 `dist/`） | `tests/fm-captain-hold-lifecycle.test.sh`（+63 行，`--on-answer` 的測試） |
| #64 | `bin/fm-captain-hold.sh`（事件紀錄） | `bin/fm-board-io-lib.sh`、`bin/fm-board.sh`、`bin/fm-topic-board-read.sh`；`fm-board/spec/adapter.markdown`、`fm-board/test/stage-1-feed.sh`；`myshape/dist/board-server.js`、`commands.js`、`decisions.js`、`journal.js`、`layout.js`、`poller.js`、`records.js`、`report.js`、`store.js`、`todos.js`；`myshape/spec/contracts.markdown`、`handover.markdown`、`open-issues.markdown`；`myshape/spec/rollout.markdown`（今天在 `fm-board/spec/`）；`myshape/test/contract/report-far1.json`、`report-main.json`、`report-sm1.json`、`myshape/test/stub-aggregator/stub-lib.sh` | `myshape/src/board-server.ts`、`commands.ts`、`commands.test.ts`、`decisions.ts`、`decisions.test.ts`、`journal.ts`、`layout.ts`、`poller.ts`、`poller.test.ts`、`records.ts`、`records.test.ts`、`report.ts`、`report.test.ts`、`sending.test.ts`、`storage.test.ts`、`store.ts`、`todos.ts`、`view.test.ts`；`myshape/test/stage-1-read.sh`、`stage-3-data.sh`、`stage-5-http.sh`、`stage-7-standalone.sh`、`stage-7-upgrade.sh`、`state-writers.mjs`（看板自己的測試，在 guybeju/myshape 的 CI 跑） | - |
| #67 | `bin/fm-backlog-archive-lib.sh`、`bin/fm-fleet-snapshot.sh` | `bin/fm-dispatch-plan.sh`；`dispatch-plan/spec/dispatch-plan.markdown`、`dispatch-plan/test/stage-1-order.sh`、`stage-4-queues-push.sh`；`fm-board/spec/adapter.markdown`；`myshape/spec/contracts.markdown`、`stage-1-files.markdown` | - | `tests/fm-fleet-snapshot-view.test.sh`（+90 行，`test_archived_done_blockers_resolve`） |

hook 點不需要那兩個測試也能用，所以沒有放進 patch；fork 要它們時，從 #48 與 #67 自己拿。
patch 以外 `carry` 改過的上游檔還有兩個：`bin/fm-on.sh`（[#22](https://github.com/guybeju/firstmate/commit/636b90b66a0f7529b8330674ca542056e438a1d3)，遠端傳輸的修正，看板不需要）與 `bin/fm-backlog-handoff.sh`（#60，第 2.3 節）。

## 3. 第一次 vendor：board-sync 的 PR

fork 還沒有 `myshape.lock`，所以照 `carry` 第一次 vendor 的做法（guybeju/firstmate [#76](https://github.com/guybeju/firstmate/commit/31c0cb3d168e3d9e7ef7e24a604547290fd1ec32)）：先單獨提交 vendor 腳本，再在乾淨的工作目錄上跑它。
在第 2 節的 PR 合併之後，從 fork 更新過的 `main` 開一個名稱含 `board-sync` 的分支（例如 `board-sync-7e03a5a`）；vendor 腳本在名稱不含 `board-sync` 的分支、detached HEAD 上都拒絕。
git 要 2.32 以上（`git --version`）。

**1. 放 vendor 腳本，單獨一個 commit。
** 它必須是**要 vendor 的那個 commit**的那一份：沒有 lock 時，vendor 只接受位元組相同的追蹤檔，而它自己也在清單上。

```
curl -fsS -o <checkout>/bin/fm-board-vendor.sh https://raw.githubusercontent.com/guybeju/myshape/7e03a5a334aa3c4767ea90ae9d8f78736f7ba771/adapters/firstmate/bin/fm-board-vendor.sh
git -C <checkout> hash-object bin/fm-board-vendor.sh       # 要是 addb3a80c2eb17e83253db3bb44ff830fe93419b
chmod 755 <checkout>/bin/fm-board-vendor.sh
git -C <checkout> add bin/fm-board-vendor.sh
git -C <checkout> ls-files -s bin/fm-board-vendor.sh      # 100755 addb3a80c2eb17e83253db3bb44ff830fe93419b 0	bin/fm-board-vendor.sh
git -C <checkout> commit -m 'Place the board vendor script from guybeju/myshape@7e03a5a'
```

**2. vendor 之前，工作目錄要乾淨。
** `git -C <checkout> status --short --untracked-files=all` 要沒有輸出；vendor 擁有的地方（`myshape/`、`fm-board/`、`dispatch-plan/` 整個目錄、清單列的 `bin/` 檔、`myshape.lock`）有沒提交或沒追蹤的檔時它會拒絕。

**3. vendor 並提交它寫的東西：**

```
<checkout>/bin/fm-board-vendor.sh vendor 7e03a5a334aa3c4767ea90ae9d8f78736f7ba771
git -C <checkout> status --short
git -C <checkout> commit -m 'Vendor guybeju/myshape at 7e03a5a'
<checkout>/bin/fm-board-vendor.sh --check
```

它從公開的 guybeju/myshape 用 https 讀，不需要登入；寫完會 stage 它寫的每個檔與 `myshape.lock`，提交由你做。
預期的輸出（演練時，第 2 節的 patch 套在上游 2f000eb4 上）：

```
ok - 117 files from guybeju/myshape@7e03a5a334aa3c4767ea90ae9d8f78736f7ba771 (on main): 116 written, 0 deleted, myshape.lock staged
ok - 117 files match guybeju/myshape@7e03a5a334aa3c4767ea90ae9d8f78736f7ba771 (on main)
```

演練時實際看到的拒絕與處理：

| 輸出 | 意思 | 處理 |
| --- | --- | --- |
| `not ok - bin/fm-topic-board-read.sh is tracked here with other bytes; with no lock, only identical ones are taken` | fork 還追蹤著舊版的同名檔（第 1.3 節） | 第 2.1 節拿掉它並提交，再 vendor；vendor 腳本本身放錯 commit 的版本時也是這一行，名字是 `bin/fm-board-vendor.sh` |
| `not ok - uncommitted or untracked change in the vendored areas: ?? fm-board/notes` | vendor 擁有的地方有沒追蹤的檔 | 提交、移走或還原它，再 vendor |

其他拒絕的情況與 `--check` 每一行的意思寫在 vendor 腳本的檔頭。

**4. 開 PR**，base 是 fork 的 `main`，說明寫出 vendor 的 commit 與 `--check` 的那一行。

**要用比 7e03a5a 新的 commit 時：** 那個 commit 要在 guybeju/myshape `main` 的 first-parent 鏈上（PR 的合併 commit），而且它自己在 `main` 上的 push run 裡 `Board` 與 `Firstmate adapter` 兩個 job 都是 success（看這兩個 job，不是整個 run）。
第 1 步的 vendor 腳本要改從那個 commit 拿；拿錯版本時 vendor 會照上表第一列拒絕，所以拒絕就表示要重拿。
上面的檔數也會不同。
那個 commit 之後 hook 點有沒有改，看 guybeju/myshape 的 `adapters/firstmate/fm-board/port/` 有沒有新的 patch。

## 4. 自我更新：不指向 `carry`

FORK-SETUP 第 3 步把 `config/self-update-source` 寫成指向 `carry`，**這一步在這台不做**。
這台的 home 照舊跟著自己的 fork：`config/self-update-source` 原本有就照原樣，原本沒有就不要新增；`/updatefirstmate` 照舊從自己的 fork 前進，兩個 PR 合併之後由它把 home 帶到新的 commit。
之後看板或 first mate 這一側有新版時，在這個 fork 再開一個 board-sync 的 PR，跑 `bin/fm-board-vendor.sh vendor <新的 commit>`（有 lock 之後不用再先放 vendor 腳本），合併後 `/updatefirstmate`。
hook 點很少改；改的時候 guybeju/myshape 會有新的 patch，照第 1.2 與 2.2 節再做一次。

## 5. 驗收

兩個 PR 都合併、home 經 `/updatefirstmate` 更新到含它們的 commit、第 1.3 節的資料照 captain 的決定處理好之後，在 `<home>` 做：

1. `<home>/bin/fm-board-vendor.sh --check` 印 `ok - 117 files match guybeju/myshape@7e03a5a334aa3c4767ea90ae9d8f78736f7ba771 (on main)`。
2. 四個 hook 點：第 1.2 節的四行 `grep` 把 `<checkout>` 換成 `<home>` 再跑，每一行都要有輸出：`fm-fleet-snapshot.sh` 一行 `--rawfile archived <(fm_backlog_archived_done_ids "$archive")`；`fm-captain-hold.sh` 一行 `--on-answer) shift; on_answer=${1:-} ;;` 與 `publish_parent_hold` 裡的 `record_hold_line "$id" "$occurrence" "$verb"`；`fm-session-start.sh` 兩行（註解與呼叫）。
3. 能力檢查本身（看板讀之前跑的同一個函式），要印 `no gap`：

   ```
   bash -c 'cd "$1" && . bin/myshape-lib.sh && . bin/fm-board-lib.sh && tb_capability_gap "$1/bin" && echo "no gap"' _ <home>
   ```

   印的是「這個 home 的 first mate 缺少封存 blocker 的修正：…」時，`bin/fm-fleet-snapshot.sh` 的修正沒進來，回第 2.2 節。
4. 照 FORK-SETUP 第 5 步開帳本、打開看板：`bin/fm-board.sh setup`、`bin/myshape.sh open`，在這台的瀏覽器打開它印的網址停一分鐘以上，再 `bin/myshape.sh status`。
   每一行的預期輸出與不對時的處理寫在那一步。
   要看到的：`aggregator：已接上（first mate）`，每個 `home <id>：` 都是 `相同`，沒有 `無法回報`；頁面上沒有「這個 home 的 first mate 缺少封存 blocker 的修正」的橫幅。
5. `--on-answer` 與事件紀錄：之後第一個經 `bin/fm-captain-hold.sh hold … --on-answer close|release` 開的待決事項，內文有 `Captain hold on answer: <值>` 那一行，`tail -1 <home>/state/captain-hold-events.jsonl` 是那個 task 的 `"event":"held"`；回答之後多一行 `"event":"resolved"`。
6. session start 的那一行：看板第一次成功啟動之後，下一次開 session 的啟動摘要在 fleet state 那一段的最後有一行 `看板服務：在跑`（或 FORK-SETUP 第 5 步列的其他四種之一）。

然後是 captain 的步驟（FORK-SETUP 第 6 步）：每個 home 都是 `相同` 之後，由 captain 跑或明講之後跑 `bin/fm-board.sh install-rules`，輸出有 `captain.md：新增（v15）` 與 `captain-shared.md：新增（v5）`，`bin/fm-board.sh rules` 印 `規則：captain.md 和範本相同（v15）；captain-shared.md 和範本相同（v5）`；裝完重開主 first mate 的 session，規則從下一個 session 生效。
有 second mate 時，順序與多出來的步驟照 FORK-SETUP 第 8 節，但其中把 code root 指向 `carry` 的部分不做：每台遠端的 code root 照它自己的更新方式跟到同一個 fork commit。

## 6. 測試

可以跑的測試套件：first mate 這一側的 `fm-board/test/run.sh` 與 `dispatch-plan/test/run.sh`（vendor 帶來，怎麼跑與需要的工具在 [handover](https://github.com/guybeju/myshape/blob/7e03a5a334aa3c4767ea90ae9d8f78736f7ba771/adapters/firstmate/fm-board/spec/handover.markdown) 第 1 節），以及上游自己的 `tests/`（patch 改到的 `bin/fm-captain-hold.sh`、`bin/fm-fleet-snapshot.sh`、`bin/fm-session-start.sh` 各有上游的測試）。
看板自己的套件（`myshape/test/run.sh` 與單元測試）不 vendor，在 guybeju/myshape 的 CI 跑；7e03a5a 的那一次就是第 0 節的 run，`Board` 與 `Firstmate adapter` 兩個 job 都通過。
寫這一頁的 fleet 沒有跑任何一個套件：演練只做了 `git apply`、vendor、`--check`、`grep` 與能力檢查函式。
這台的 first mate 照這台機器自己的規則決定跑哪些、怎麼跑；這台沒有這種規則時，在 captain 決定之前不要跑。

## 7. FORK-SETUP 哪些照做

| FORK-SETUP（[010e1a06](https://github.com/guybeju/firstmate/blob/010e1a06302f81e7ce8db9b359e781879949587a/FORK-SETUP.markdown)） | 這台 |
| --- | --- |
| 第 0 節「為什麼用 fork」「怎麼跟著 `carry`」 | 不照做：這台不跟 `carry`。照做的只有它說的「`carry` 以外的 fork 要先移植封存 blocker 的修正」，就是第 2 節 |
| 第 3 步 `config/self-update-source` 指向 `carry` 與那次更新 | 不做（第 4 節）。照做的只有它的 `bin/fm-board-vendor.sh --check` 確認與「不對時」裡關於 `--check` 的兩點 |
| 第 4 步開 session | 這台早就在用，不用重做 |
| 第 5 步開帳本、打開看板 | 照做（第 5 節第 4 點） |
| 第 6 步裝規則、重開 session | 照做，是 captain 的步驟 |
| 第 7 節「之後怎麼更新」 | 只照做「同步 PR 用 `vendor <commit>`」那一點，在這個 fork 上開；其餘講 `carry`、`carry-lint.yml`、規則集與上游合併進 `carry` 的部分都不適用 |

## 8. 沒有驗證的

- 這個 fork 的真正 base、它的三個舊看板修改的內容，以及第 1.3 節在那台實際找到什麼：從這裡讀不到那個 fork。
- 那個 fork 的 CI 會不會接受 vendor 進來的檔與 patch：演練只在上游 2f000eb4 的本機 clone 上做，沒有跑上游的 CI 或 lint。
- 舊版的 `fm-topic.sh` 有沒有 `stop`，以及舊版寫的 `data/topics.json` 能不能被現在的看板讀懂。

## 9. captain 在那台機器上要做的

1. 在那台開 first mate 的 session，把這一頁的網址給它，請它照著做。
2. 它在第 1.3 節停下來問時，決定舊看板的資料怎麼處理（預設是移開、看板從空的開始），並一個一個決定 `topic-board：` 的 hold 要不要放掉。
3. 看過並合併那個 fork 上的兩個 PR：先是 hook 點的 PR，再是 board-sync 的 PR；之後讓 first mate 跑 `/updatefirstmate`。
4. 看板打開、每個 home 都是 `相同` 之後，跑 `bin/fm-board.sh install-rules`（或明講讓 first mate 跑），再重開主 first mate 的 session。
