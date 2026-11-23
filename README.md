# problem-tree

Claude Code 세션 옆에 상주하는 **문제해결 노드트리** 패널. 긴 작업 중 문제가 여러 개 생겼다가 하나에만 집중하면서 나머지가 "잊혀져" 사라지는 것을 구조적으로 막는다. git DAG처럼 문제를 노드로 쌓고, 미해결 노드를 항상 눈에 보이게 한다.

## 설치

```
/plugin install problem-tree --marketplace Lee-JuYeon/problem-tree
```

또는 2단계로:

```
/plugin marketplace add Lee-JuYeon/problem-tree
/plugin install problem-tree@leejuyeon
```

설치하면 모든 세션에서 자동 로드된다. 열기: `/ptree`.

## 핵심 원칙 — 패널은 읽기 전용, 관리는 자동

노드 관리(추가/해결/재개/이름변경/삭제/작업전환)는 **사용자 몫이 아니다.** 대화의 진행에 따라 **Claude가 자동으로** 하거나, 사용자가 슬래시 커맨드로 한다. 패널에는 **버튼·입력이 전혀 없다**(승인/반려 같은 "멈춰 선 대기" 상태 없음).

## 4가지 상태

| 마커 | 상태 | 뜻 |
|---|---|---|
| `○` | 계획만 | 노드만 만들어졌고 아직 착수 전 |
| `○→◐→●` (애니) | 진행중(current) | 메인 턴이 도는 동안 지금 작업 중인 노드 |
| `◐` | 멈춤 | 일단락됐지만 마무리 안 된 채 멈춤 |
| `●` | 완료 | 해결됨(원이 다 채워짐). `→nX` = 다른 노드 해결로 함께 닫힘(merge) |

진행중·완료의 `●`는 글자는 같아도 색·굵기·움직임으로 구분된다. 백그라운드 작업이 붙은 노드는 `◇→◈→◆`로 돈다. 멈춘 지 며칠인지는 목록(`list_problems`·`/ptree list`)의 `paused Nd`로 본다.

## 쓰는 법

- 패널 열기: `/ptree`
- 커맨드: `/ptree add <제목>` · `resolve <id>` · `reopen <id>` · `focus <id>` · `rename <id> <제목>` · `rm <id>` · `move <id> [부모id]`(생략=루트로) · `note <id> <글>` · `link <경로>`(빈 root에서만: 다른 root의 트리를 같이 봄) · `unlink` · `list`
- Claude 도구(턴 안에서 직접 호출 — 유일한 갱신 경로): `add_problem`(새 문제를 '계획만'으로 추가, focus는 안 뺏음. `parentId` 생략=루트, 하위 문제면 `parentId` 명시) · `move_problem`(잘못 붙은 노드를 다른 부모/루트로 옮김, 하위 노드 동행) · `focus_problem`(지금부터 이 노드 작업 선언 → 진행중) · `resolve_problem`(근거 있을 때 해결, 같이 풀린 건 `alsoResolves`) · `reopen_problem` · `rename_problem` · `list_problems`

## 제목 규칙(철칙)

노드 제목은 **16자 이내, 되도록 10자**. 쉬운 말로 요약, 직관적·가독성 높게(트리가 길어지므로). 16자 초과는 도구가 거부한다.

## 저장

영구 데이터는 **노드 행뿐**이다: 플러그인 `$.store`의 키 `node:<tree>:<id>` 하나가 노드 하나(`types/index.d.ts`의 `PtreeNode`). 쓰기는 "그 행만 읽고 고쳐 쓰기"라 통째 덮어쓰기가 없다. `<tree>`는 세션의 프로젝트 root(`$.session.root()`, 셸 `cd`로 안 변함) — 다른 root에서 같은 트리를 보려면 `/ptree link <경로>`.

"지금 도는 중"·작업 포인터·백그라운드 작업 같은 **휘발 사실은 저장하지 않는다**(세션 atom에만 있고 렌더 때 계산). 세션이 끝나거나 컨텍스트가 요약돼도 노드는 남아 다음 세션에서 이어진다. 완료된 묶음은 다음 턴부터 접히고, 삭제(묘비)·완료 후 30일이 지나면 물리 삭제된다.

## 설치 식별자가 바뀌어도 노드는 남는다(고아 store 흡수)

`$.store` 파일은 Claude Code가 고르는 **로드 식별자**마다 따로다: `~/.claude/skills/problem-tree`에서 자동 로드되면 `problem-tree_skills-dir-<해시>.json`, 마켓으로 설치하면 `problem-tree_<마켓>-<해시>.json`. 같은 이름의 설치본이 생기면 skills-dir 사본은 로드되지 않으므로(`claude plugin list`에 "Not loaded — name already taken"), 설치·제거만으로 store 파일이 바뀌고 옛 노드가 화면에서 사라졌다.

그래서 `session.start`마다 store 디렉터리의 형제 파일(`problem-tree_*.json`)을 읽어 `node:`/`link:` 행을 자기 store로 흡수한다. 병합 규칙:
- **내 쪽에 없는 행은 항상 가져온다.** 단 ①GC 규칙상 곧 지워질 행(30일 넘은 묘비·완료 단위)과 ②내가 GC로 지운 뒤 형제 쪽에서 바뀌지 않은 행은 안 가져온다 — GC는 지운 id를 `gone:<tree>`에 1년 기록해 두므로, 오래 쉬던 형제의 낡은 열린 사본도 지운 노드를 되살리지 못한다.
- **양쪽에 있는 행은 합친다.** 바탕은 **행 버전**이 새 쪽(동률은 내용 글자순 — 어느 쪽에서 합쳐도 같은 답이라 수렴한다) — 행 버전은 쓰기 창구(`store.ts`)가 모든 변경마다 올리는 `modAt`이다(`touchedAt`은 "작업이 닿은 시각"이라 rm·move는 안 올린다 → 병합 기준으로 못 쓴다). 상태 묶음(status·resolvedAt·removedAt…)만은 **상태가 앞선 쪽**: 삭제 > 재개 횟수 큰 쪽 > 해결 > 열림. 형제 세션이 내 해결/삭제를 모른 채 뒤늦게 focus·rename 해도 되돌아가지 않는다.
- unlink는 묘비(`link:<root>`=false)로 남아 옛 연결이 되살아나지 않는다(연결 상태 자체는 식별자마다 따로다).
- 미이관 레거시 `tree:`는 그 트리의 `node:` 행이 양쪽 어디에도 없을 때만 통째로 가져온다. `diag:`는 안 옮긴다.
- 파일별 지문 `adopt:<파일명>`={size,mtimeMs,ver}가 같으면 다시 읽지 않는다(`ver`는 이미 합친 행의 get을 아끼는 용도일 뿐).
- 못 읽은 파일(4 MiB 초과·깨진 JSON·쓰기 거부)과 같은 id의 다른 노드(따로 만들어진 것)는 덮지 않고 토스트로 알린다.

알려진 한계: 흡수는 `session.start`에만 일어난다. 두 식별자가 **동시에** 살아 있는 동안(옛 세션이 아직 떠 있을 때) 한쪽의 변경은 다른 쪽의 다음 세션 시작까지 안 보인다.

## 패널 감시 Stop 훅(`hooks/ptree-watch.py`, 선택·읽기 전용)

플러그인이 세션 도중 언로드되면 패널·MCP 도구가 사라지는데 아무 신호가 없다. 플러그인 자신의 훅은 같이 내려가므로, 이 감시는 **`settings.json`에 직접 등록**해야 한다:

```json
{"hooks": {"Stop": [{"hooks": [{"type": "command", "timeout": 10,
  "command": "python3 ~/.claude/skills/problem-tree/hooks/ptree-watch.py"}]}]}}
```

- **패널 생존:** 플러그인은 살아 있는 동안 매 턴 시작에 `diag:<세션id>`에 한 줄을 쓴다(박동). 직전 Stop 이후 박동이 없으면 그 턴에 바로 `systemMessage`로 경고한다(같은 세션 10분에 한 번, Stop은 막지 않음).
- **폐지된 숨김 주석:** 응답이 변경(add/resolve/rename)이 담긴 `<!--PTREE …-->` 주석으로 **끝나면**(중간 인용은 무시) "반영 안 됐다, MCP 도구로 직접 반영하라"고 한 번 되돌려 보낸다(같은 주석은 1회, 빈 주석·주석 없음은 무시).
- 플러그인 store에는 **절대 쓰지 않는다.** 쓰는 파일은 자기 상태 파일 `~/.claude/plugins/data/problem-tree-hook/state.json` 하나(원자적 교체).

### 왜 숨김 주석 + 백그라운드 훅 동기화를 없앴나

예전엔 Claude가 응답 끝에 숨김 주석을 남기면 Stop 훅이 transcript를 긁어 store 파일을 직접 고쳤고, 주석이 없으면 Stop을 막아 강제했다. 폐지 사유:
- **flush race:** 마지막 응답 블록은 Stop 훅보다 늦게 transcript에 써진다 → 그 턴의 지시를 못 보고 ±1턴 늦게, 때로는 영영 반영 안 됨(조용한 실패).
- **두 번째 쓰기 주체:** 훅이 `$.store` 파일을 밖에서 통째로 다시 썼다 → 플러그인의 행 단위 쓰기와 경합(나중 쓴 쪽이 이김), 훅은 "노드가 있는 첫 파일"을 골라 플러그인이 보는 store와 다른 파일에 쓸 수 있었다.
- **신뢰경계:** assistant 글에 인용된 주석(읽은 파일·웹 내용)도 지시로 실행됐다.

지금은 **턴 안에서 MCP 도구를 직접 부른다**(`add_problem`·`resolve_problem`·…). 즉시·가시·단일 쓰기 경로(`store.ts`)다.

테스트(셋을 항상 같이 돌린다): `claude plugin test .`(모듈) · `python3 tests/hook_test.py`(Stop 훅) · `python3 tests/static_guard.py`(소스 불변식 — 호스트가 로드를 거부하는 철자는 첫째가 잡는다).

## 진단 로그(불 꺼짐 추적용, 동작 무관)

세션별 store 키 `diag:<sessionId>`에 최근 50건(session.start마다 가장 오래된 세션부터 최대 100키만 들여다보고, 7일 지난 것·세션 수 100 초과분을 지운다 — 전수 조회 안 함). 턴 시작 항목은 패널 감시 Stop 훅이 박동으로 읽는다. 항목: `at`(ms), `ev`(start=turn.start·complete=turn.complete·reset=세션교체·sstart=session.start·clobber=loadTree가 읽는 도중 patch가 끼어 캐시를 덮어씀), `turnId`·`agentId`, `before`/`after`(그 훅 전/후 `mainTurnId`, 없으면 생략), `match`(complete의 turnId==before), `ptr`(포인터 노드), `tasks`(백그라운드 작업 수), `note`(complete=reason, reset=`옛sid→새sid`, clobber=`seq a→b`).
읽기: `python3 -c "import json;d=json.load(open('$HOME/.claude/plugins/store/problem-tree_skills-dir-a8b1b87c1491.json'));[print(k,len(v)) for k,v in d.items() if k.startswith('diag:')]"` — 한 세션 상세는 `print(json.dumps(d['diag:<sid>'],indent=1,ensure_ascii=False))`. 범인 후보: 메인 턴 중 `complete`에 `match:false`·에이전트 아닌데 다른 turnId, `reset`/`sstart`가 턴 중간에 찍힘, `clobber`.

## 구조

```
hooks/register.tsx     훅 배선만(session/turn/spawn/tool/Stop/command/render)
hooks/pane.tsx         패널 그리기(읽기 전용)
hooks/lib/tools.ts     MCP 도구 선언표 + 실행
hooks/lib/command.ts   /ptree 해석·실행
hooks/lib/ops.ts       노드 조작(add/resolve/reopen/focus/rename/move/remove/note/list)
hooks/lib/store.ts     영속 창구 — $.store 쓰기는 여기에만(노드·link·migrate·gc·adopt·diag)
hooks/lib/session.ts   세션 테이블 창구(turn/pointer/agentBind/runningTasks atom)
hooks/lib/view.ts      순수 계산($ 없음: 숨김·레이아웃·불·목록·검증·id)
hooks/ptree-watch.py   패널 감시 Stop 훅(선택, settings.json에 등록, 읽기 전용)
```

의존은 한 방향: register → tools/command/pane → ops → store/session → view. 불변식은 `tests/guards.test.tsx`(행동: 렌더·타이머 쓰기 0, 이벤트별 쓰기 테이블, Stop 핸들러는 절대 안 막음)와 `tests/static_guard.py`(소스: store 쓰기는 store.ts에만, 세션 atom은 session.ts에만, 파일 쓰기·프로세스·네트워크 0, 훅 매처는 register.tsx에 리터럴)가 지킨다.

## 설계 메모

- 도구의 입력 타입은 `types/index.d.ts`의 `McpToolInputs`에 **직접 선언**한다(생성 `claude-code-mcp` 스냅샷은 한 리로드 뒤처지므로 거기 기대지 않음). `hooks/lib/tools.ts`의 `TOOLS`와 짝이다.
- 플랫폼 규칙 둘: ①`$`는 정적으로 보이는 호출에만 넘길 수 있다(표에 담은 클로저로는 못 넘김) → 도구 실행은 이름으로 가르는 `runTool` switch. ②호스트가 훅 매처를 정적으로 읽는다 → `command`/`tool`/`requestId`와 커맨드 `name`은 `register.tsx`에 문자열 리터럴로(상수·루프면 `claude plugin validate`에 `tool=?`로 나온다).
- 같은 이름의 플러그인은 한 벌만 로드된다. `~/.claude/skills/problem-tree`(자동 로드, `@skills-dir`)와 마켓 설치본(`@<마켓>`)이 둘 다 있으면 설치본이 이기고 store 파일도 달라진다 — 위 "고아 store 흡수"가 노드를 이어 준다.
