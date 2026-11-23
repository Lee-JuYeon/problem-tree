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

`⚠` = 2일 이상 방치(작업 중이면 안 붙음). 진행중·완료의 `●`는 글자는 같아도 색·굵기·움직임으로 구분된다.

## 쓰는 법

- 패널 열기: `/ptree`
- 커맨드: `/ptree add <제목>` · `resolve <id>` · `reopen <id>` · `focus <id>` · `rename <id> <제목>` · `rm <id>` · `move <id> [부모id]`(생략=루트로) · `note <id> <글>` · `show`(완료 노드 표시 토글) · `list`
- Claude 자동 도구: `add_problem`(새 문제를 '계획만'으로 추가, focus는 안 뺏음. `parentId` 생략=루트, 하위 문제면 `parentId` 명시) · `move_problem`(잘못 붙은 노드를 다른 부모/루트로 옮김, 하위 노드 동행) · `focus_problem`(지금부터 이 노드 작업 선언 → 진행중) · `resolve_problem`(근거 있을 때 해결, 같이 풀린 건 `alsoResolves`) · `reopen_problem` · `rename_problem` · `list_problems`

## 제목 규칙(철칙)

노드 제목은 **16자 이내, 되도록 10자**. 쉬운 말로 요약, 직관적·가독성 높게(트리가 길어지므로). 16자 초과는 도구가 거부한다.

## 저장

작업 디렉터리별로 `$.store` 키 `tree:<cwd>`에 영속 저장된다. 세션이 끝나거나 컨텍스트가 요약돼도 트리가 남아 다음 세션에서 이어진다. 세션 내 반응형 미러는 `$.state`.

## 설치 식별자가 바뀌어도 노드는 남는다(고아 store 흡수)

`$.store` 파일은 Claude Code가 고르는 **로드 식별자**마다 따로다: `~/.claude/skills/problem-tree`에서 자동 로드되면 `problem-tree_skills-dir-<해시>.json`, 마켓으로 설치하면 `problem-tree_<마켓>-<해시>.json`. 같은 이름의 설치본이 생기면 skills-dir 사본은 로드되지 않으므로(`claude plugin list`에 "Not loaded — name already taken"), 설치·제거만으로 store 파일이 바뀌고 옛 노드가 화면에서 사라졌다.

그래서 `session.start`마다 store 디렉터리의 형제 파일(`problem-tree_*.json`)을 읽어 `node:`/`link:` 행을 자기 store로 흡수한다. 같은 id는 `touchedAt`이 더 새 쪽, 파일별 지문(`adopt:<파일명>`=size·mtime)이 같으면 다시 읽지 않는다. 못 읽은 파일(4 MiB 초과·깨진 JSON)은 토스트로 알린다. `diag:`·레거시 `tree:`는 옮기지 않는다.

## 패널 생존 감시(Stop 훅)

플러그인이 세션 도중 언로드되면 패널·MCP 도구는 사라지는데 `settings.json`에 등록된 Stop 훅은 계속 돌아, "데이터는 쌓이는데 화면엔 없음"이 몇 시간씩 신호 없이 이어질 수 있다. `ptree-sync.py`는 매 Stop마다 이 세션의 `diag:<세션id>` 박동(플러그인이 턴 시작마다 씀)이 직전 Stop 이후에 있었는지 보고, 없으면 그 턴에 바로 `systemMessage`로 경고한다(같은 세션 10분에 한 번, Stop은 막지 않음). 플러그인이 직접 돌린 사본(`CLAUDE_PLUGIN_ROOT` 있음)은 판정하지 않는다. 상태 파일: `~/.claude/plugins/data/problem-tree-hook/state.json`.

테스트: `claude plugin test .`(모듈) · `python3 tests/hook_test.py`(Stop 훅).

## 진단 로그(불 꺼짐 추적용, 동작 무관)

세션별 store 키 `diag:<sessionId>`에 최근 50건(session.start마다 가장 오래된 세션부터 최대 100키만 들여다보고, 7일 지난 것·세션 수 100 초과분을 지운다 — 전수 조회 안 함). 턴 시작 항목은 Stop 훅의 패널 생존 감시가 박동으로 읽는다. 항목: `at`(ms), `ev`(start=turn.start·complete=turn.complete·reset=세션교체·sstart=session.start·clobber=loadTree가 읽는 도중 patch가 끼어 캐시를 덮어씀), `turnId`·`agentId`, `before`/`after`(그 훅 전/후 `mainTurnId`, 없으면 생략), `match`(complete의 turnId==before), `ptr`(포인터 노드), `tasks`(백그라운드 작업 수), `note`(complete=reason, reset=`옛sid→새sid`, clobber=`seq a→b`).
읽기: `python3 -c "import json;d=json.load(open('$HOME/.claude/plugins/store/problem-tree_skills-dir-a8b1b87c1491.json'));[print(k,len(v)) for k,v in d.items() if k.startswith('diag:')]"` — 한 세션 상세는 `print(json.dumps(d['diag:<sid>'],indent=1,ensure_ascii=False))`. 범인 후보: 메인 턴 중 `complete`에 `match:false`·에이전트 아닌데 다른 turnId, `reset`/`sstart`가 턴 중간에 찍힘, `clobber`.

## 매 턴 끝 강제 갱신(Stop 훅 — `hooks/ptree-sync.py`)

MCP 도구 호출(`add_problem` 등)은 터미널 렌더를 못 숨긴다. 그래서 **메인 대화에서 가시 MCP 호출을 쓰지 않고**, Claude가 응답 맨 끝에 **숨김 HTML 주석 지시**를 남기면 `hooks.json`의 **Stop command 훅**(`ptree-sync.py`)이 턴 끝에 **백그라운드로** store를 직접 갱신한다. 지시가 없으면 Stop을 **block**해서 매 턴 갱신을 강제한다(한 턴 1회, `stop_hook_active`로 무한루프 방지).

지시 형식(HTML 주석이라 사용자 화면에 안 보임):
```
<!--PTREE {"tree":"<프로젝트 root 절대경로>","add":[{"id":"ab12","title":"16자내","parent":"<부모id|null>"}],"resolve":["id"],"rename":[{"id":"x","title":"새 제목"}]}-->
```
변경 없는 턴은 `<!--PTREE {"tree":"<root>"}-->`만. store 파일은 `~/.claude/plugins/store/problem-tree_*.json`에서 `node:`/`schema`를 가진 파일을 자동 선택(기기 독립). focus/current(●)는 세션 런타임 atom이라 외부서 못 바꾼다 — add/resolve/rename만 백그라운드 가능.

## 설계 메모

- 도구의 입력 타입은 `types/index.d.ts`의 `McpToolInputs`에 **직접 선언**한다(생성 `claude-code-mcp` 스냅샷은 한 리로드 뒤처지므로 거기 기대지 않음). `tool.call` 리터럴 매처가 그 선언으로 `e`를 좁힌다.
- 다음(M2): 한글 2셀 폭 정확 자르기, 해결 노드 아카이브, `staleDays` userConfig.
