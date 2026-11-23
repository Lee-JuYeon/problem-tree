#!/usr/bin/env python3
"""Stop 훅: 매 턴 끝에 problem-tree를 '강제·기계적·백그라운드'로 갱신한다.

요구:
  (1) 매 턴 끝 강제 갱신 — 지시가 없으면 Stop을 block해서 갱신을 강제한다.
  (2) 작업 다 끝낸 뒤(=Stop 시점) 그 턴 작업내역을 노드에 반영.
  (3) 메인턴에 프린트 없이 백그라운드 — 모델의 가시 MCP 호출 없이, 모델이 응답 끝에 넣은
      숨김 HTML 주석 지시 <!--PTREE {json}--> 를 이 훅이 읽어 store 파일을 직접 쓴다.

지시 형식(모델이 응답 맨 끝에 1줄, HTML 주석이라 터미널 렌더에 안 보임):
  <!--PTREE {"tree":"<프로젝트 root 경로>",
             "add":[{"id":"ab12","title":"16자내","parent":"<부모id 또는 null>"}],
             "resolve":["id1","id2"],
             "rename":[{"id":"x","title":"새 제목"}]}-->
  변경이 없는 턴이면 빈 지시 <!--PTREE {"tree":"<root>"}--> 로 '확인함'을 표시(block 안 됨).

store(노드만 persist; pointer/turn atom은 세션 런타임 메모리라 외부서 못 건드림):
  ~/.claude/plugins/store/problem-tree_skills-dir-a8b1b87c1491.json
  노드 키 = node:<tree>:<id>  (PtreeNode)
"""
import sys
import os
import re
import json
import time

CONFIG_DIR = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
STORE_DIR = os.environ.get("PTREE_STORE_DIR") or os.path.join(CONFIG_DIR, "plugins", "store")
# 패널 생존 감시 상태(세션별 직전 Stop 시각·마지막 경고 시각). 플러그인 store와 무관한 이 훅만의 파일.
STATE = os.environ.get("PTREE_HOOK_STATE") or os.path.join(
    CONFIG_DIR, "plugins", "data", "problem-tree-hook", "state.json")
WARN_EVERY_MS = 10 * 60 * 1000      # 같은 세션에 경고를 다시 띄우는 최소 간격
STATE_KEEP = 100                    # 상태 파일에 남기는 세션 수


def _store_files():
    """플러그인 store 파일들(설치 식별자마다 1개: problem-tree_<source>-<hash>.json)."""
    import glob
    return sorted(glob.glob(os.path.join(STORE_DIR, "problem-tree_*.json")))


def _resolve_store():
    """problem-tree 노드 store 파일 경로(기기 독립). PTREE_STORE 로 테스트 오버라이드 가능.
    설치/기기마다 파일 해시가 달라서 하드코딩하지 않고 node:/schema 를 가진 파일을 자동 선택."""
    env = os.environ.get("PTREE_STORE")
    if env:
        return env
    cands = _store_files()
    fallback = None
    for c in cands:
        try:
            with open(c, encoding="utf-8") as f:
                d = json.load(f)
        except Exception:
            continue
        if any(str(k).startswith("node:") for k in d):
            return c                     # 노드가 실제로 있는 파일 최우선
        if "schema" in d and fallback is None:
            fallback = c                 # 아직 빈 트리면 schema 가진 노드 store
    return fallback or (cands[0] if cands else os.path.join(STORE_DIR, "problem-tree_store.json"))


STORE = _resolve_store()
DIRECTIVE_RE = re.compile(r"<!--\s*PTREE\s*(.*?)-->", re.S)   # 각 주석 내용을 비탐욕 캡처
TITLE_MAX = 16


def now_ms():
    return int(time.time() * 1000)


SYSTEM_MESSAGE = None               # 사용자 화면에 띄울 경고(있으면 출력 JSON의 systemMessage로 나간다)


def block(reason):
    out = {"decision": "block", "reason": reason}
    if SYSTEM_MESSAGE:
        out["systemMessage"] = SYSTEM_MESSAGE
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)


def done():
    """Stop 허용. 경고가 있으면 그것만 사용자에게 띄운다(모델 턴은 안 늘린다)."""
    if SYSTEM_MESSAGE:
        print(json.dumps({"systemMessage": SYSTEM_MESSAGE}, ensure_ascii=False))
    sys.exit(0)


# ---------- 패널 생존 감시 ----------
# 왜: 이 훅은 settings.json에 등록돼 플러그인이 내려가도 계속 돈다. 그래서 플러그인(패널·MCP 도구)이
# 세션 도중 언로드되면 "데이터는 쌓이는데 화면엔 없음" 상태가 몇 시간씩 아무 신호 없이 이어졌다.
# 플러그인 모듈은 살아 있는 동안 매 턴 시작에 자기 store의 diag:<세션id>에 한 줄을 쓴다(심장박동).
# 직전 Stop 이후 그 박동이 없으면 = 이 세션에서 패널이 죽었다 → 그 턴에 바로 사용자에게 알린다.

def _load_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _save_state(st):
    try:
        if len(st) > STATE_KEEP:
            keep = sorted(st, key=lambda k: (st[k] or {}).get("stopAt", 0))[-STATE_KEEP:]
            st = {k: st[k] for k in keep}
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        tmp = "%s.tmp.%d" % (STATE, os.getpid())
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(st, f)
        os.replace(tmp, STATE)
    except Exception:
        pass                            # 감시 상태 저장 실패가 Stop을 방해하지 않게


def _last_beat(sid):
    """모든 store 파일에서 이 세션의 마지막 박동 시각(ms). 한 번도 없으면 None.
    'complete'(턴 끝)는 Stop 뒤에 찍힐 수 있어 박동으로 안 센다 — 턴 '시작' 계열만."""
    newest = None
    for path in _store_files():
        try:
            with open(path, encoding="utf-8") as f:
                rows = json.load(f).get("diag:%s" % sid)
        except Exception:
            continue
        if not isinstance(rows, list):
            continue
        for r in rows:
            if not isinstance(r, dict) or r.get("ev") == "complete":
                continue
            at = r.get("at")
            if isinstance(at, (int, float)) and (newest is None or at > newest):
                newest = at
    return newest


def check_panel(inp):
    """패널이 이 세션에서 죽었으면 경고 문구를, 아니면 None을 돌려준다."""
    if os.environ.get("CLAUDE_PLUGIN_ROOT"):
        return None                     # 플러그인이 직접 돌린 사본 = 플러그인이 로드돼 있다(중복 판정 방지)
    sid = inp.get("session_id")
    if not isinstance(sid, str) or not sid or inp.get("stop_hook_active"):
        return None                     # block 뒤 재진입은 같은 턴 → 다시 재지 않는다
    st = _load_state()
    row = st.get(sid) if isinstance(st.get(sid), dict) else {}
    prev = row.get("stopAt")
    beat = _last_beat(sid)
    alive = beat is not None and (not isinstance(prev, (int, float)) or beat > prev)
    now = now_ms()
    msg = None
    if not alive:
        warned = row.get("warnAt")
        if not isinstance(warned, (int, float)) or now - warned >= WARN_EVERY_MS:
            row["warnAt"] = now
            msg = ("⚠ 문제트리 패널이 이 세션에서 꺼져 있습니다(플러그인이 로드되지 않음 — 화면에 안 보일 뿐 "
                   "노드 데이터는 보존됨). 복구: /reload-plugins → 그래도 없으면 `claude plugin list`로 "
                   "problem-tree 상태를 확인하고 세션을 다시 시작하세요.")
    else:
        row.pop("warnAt", None)         # 되살아나면 다음에 또 죽을 때 즉시 경고
    row["stopAt"] = now
    st[sid] = row
    _save_state(st)
    return msg


def read_stdin():
    try:
        return json.load(sys.stdin)
    except Exception:
        return {}


def _tail_entries(transcript_path, max_lines=800, tail_bytes=1_500_000):
    """transcript 꼬리만 읽어 파싱(전체 재파싱 방지 — 재시도 싸게). 현재 턴은 늘 꼬리에 있다."""
    if not transcript_path or not os.path.exists(transcript_path):
        return None
    try:
        size = os.path.getsize(transcript_path)
        with open(transcript_path, "rb") as f:
            start = max(0, size - tail_bytes)
            f.seek(start)
            raw = f.read()
    except Exception:
        return None
    lines = raw.decode("utf-8", errors="ignore").splitlines()
    if start > 0 and lines:
        lines = lines[1:]                # 잘린 첫 줄 버림
    entries = []
    for ln in lines[-max_lines:]:
        ln = ln.strip()
        if not ln:
            continue
        try:
            entries.append(json.loads(ln))
        except Exception:
            pass
    return entries


def assistant_text_this_turn(transcript_path):
    """transcript 꼬리(최근 몇 턴)의 assistant text 전부. 최신 지시를 여기서 찾는다.
    ★마지막 블록은 Stop 훅보다 늦게 flush되므로 '이번 턴 지시'는 못 본다 — 대신 직전 턴
    지시(이미 flush됨)를 집어 멱등 적용한다(±1턴 지연, 오탐 block 제거)."""
    entries = _tail_entries(transcript_path)
    if entries is None:
        return None
    texts = []
    for e in entries:
        if e.get("type") != "assistant":
            continue
        c = (e.get("message") or {}).get("content", [])
        if isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and b.get("type") == "text":
                    texts.append(b.get("text", ""))
    return "\n".join(texts)


def load_store():
    with open(STORE, encoding="utf-8") as f:
        return json.load(f)


def save_store(d):
    tmp = "%s.tmp.%d" % (STORE, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, STORE)


def apply_ops(directive, default_tree):
    """지시를 store에 적용. 반환=적용 요약 dict 또는 {'error':...}."""
    tree = directive.get("tree") or default_tree
    if not tree:
        return {"error": "no tree key"}
    d = load_store()
    at = now_ms()

    def nk(i):
        return "node:%s:%s" % (tree, i)

    added, resolved, renamed = [], [], []
    for a in directive.get("add", []) or []:
        i = (a.get("id") or "").strip()
        t = (a.get("title") or "").strip()[:TITLE_MAX]
        if not i or not t or nk(i) in d:
            continue
        node = {"id": i, "title": t, "status": "open", "createdAt": at,
                "touchedAt": at, "reopenCount": 0,
                "history": [{"at": at, "event": "add", "by": "claude"}]}
        p = a.get("parent")
        if p and nk(p) in d:
            node["parent"] = p
        d[nk(i)] = node
        added.append(i)
    for i in directive.get("resolve", []) or []:
        n = d.get(nk(i))
        if n and n.get("status") != "resolved":
            n["status"] = "resolved"
            n["touchedAt"] = at
            n["resolvedAt"] = at
            n.setdefault("history", []).append({"at": at, "event": "resolve", "by": "claude"})
            resolved.append(i)
    for r in directive.get("rename", []) or []:
        i = (r.get("id") or "").strip()
        t = (r.get("title") or "").strip()[:TITLE_MAX]
        n = d.get(nk(i))
        if n and t:
            n["title"] = t
            n["touchedAt"] = at
            n.setdefault("history", []).append({"at": at, "event": "rename", "by": "claude"})
            renamed.append(i)
    save_store(d)
    return {"tree": tree, "added": added, "resolved": resolved, "renamed": renamed}


def _scan(transcript_path):
    """(directive_dict|None, raws|None). raws is None 이면 transcript 자체를 못 읽음.
    본문에 PTREE 주석이 여러 개(예시 포함)면 전부 찾아 '마지막 유효 JSON dict'를 고른다."""
    text = assistant_text_this_turn(transcript_path)
    if text is None:
        return None, None
    raws = DIRECTIVE_RE.findall(text)
    for raw in reversed(raws):
        try:
            obj = json.loads(raw.strip())
        except Exception:
            continue
        if isinstance(obj, dict):
            return obj, raws
    return None, raws


def main():
    global SYSTEM_MESSAGE
    inp = read_stdin()
    try:
        SYSTEM_MESSAGE = check_panel(inp)
    except Exception:
        SYSTEM_MESSAGE = None           # 감시 실패가 기존 갱신 동작을 막지 않게
    stop_active = bool(inp.get("stop_hook_active"))     # block 후 재시도면 True
    tp = inp.get("transcript_path")
    directive, raws = _scan(tp)
    if directive is None and raws is None:
        done()                          # transcript 못 읽음 → Stop 막지 않음
    # flush race 대비: 내 마지막 블록(지시)이 아직 파일에 안 써졌을 수 있어 잠깐 기다렸다 재시도
    if directive is None and not stop_active:
        for _ in range(4):              # 꼬리에 최근 지시가 없을 때만 — 짧게 flush 대기
            time.sleep(0.5)
            directive, raws = _scan(tp)
            if directive is not None:
                break
    if directive is None:
        if stop_active:
            done()                      # 재시도에서도 없으면 통과(무한루프 방지)
        block("★ptree 강제: 최근 여러 턴 동안 ptree 지시가 없다. 응답 맨 끝에 숨김 주석으로 "
              "지시를 넣어 작업내역을 반영하라. 형식: PTREE 주석 안 JSON "
              "(tree=프로젝트 root 절대경로, add:[{id,title,parent}]/resolve:['id']/rename:[{id,title}]). "
              "변경 없으면 tree만. (HTML 주석이라 화면에 안 보이고, 훅이 백그라운드로 store에 반영한다.)")
    res = apply_ops(directive, inp.get("cwd") or "")   # directive 있으면 재시도여도 적용
    if res.get("error") and not stop_active:
        block("ptree 적용 실패: %s. tree(프로젝트 root 절대경로)를 지시에 넣어라." % res["error"])
    done()                              # 적용 완료 → Stop 허용(패널이 살아 있으면 조용히)


if __name__ == "__main__":
    main()
