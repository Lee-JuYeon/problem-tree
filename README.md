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
- 커맨드: `/ptree add <제목>` · `resolve <id>` · `reopen <id>` · `focus <id>` · `rename <id> <제목>` · `rm <id>` · `note <id> <글>` · `show`(완료 노드 표시 토글) · `list`
- Claude 자동 도구: `add_problem`(새 문제를 '계획만'으로 추가, focus는 안 뺏음) · `focus_problem`(지금부터 이 노드 작업 선언 → 진행중) · `resolve_problem`(근거 있을 때 해결, 같이 풀린 건 `alsoResolves`) · `reopen_problem` · `rename_problem` · `list_problems`

## 제목 규칙(철칙)

노드 제목은 **16자 이내, 되도록 10자**. 쉬운 말로 요약, 직관적·가독성 높게(트리가 길어지므로). 16자 초과는 도구가 거부한다.

## 저장

작업 디렉터리별로 `$.store` 키 `tree:<cwd>`에 영속 저장된다. 세션이 끝나거나 컨텍스트가 요약돼도 트리가 남아 다음 세션에서 이어진다. 세션 내 반응형 미러는 `$.state`.

## 설계 메모

- 도구의 입력 타입은 `types/index.d.ts`의 `McpToolInputs`에 **직접 선언**한다(생성 `claude-code-mcp` 스냅샷은 한 리로드 뒤처지므로 거기 기대지 않음). `tool.call` 리터럴 매처가 그 선언으로 `e`를 좁힌다.
- 다음(M2): 한글 2셀 폭 정확 자르기, 해결 노드 아카이브, `staleDays` userConfig.
