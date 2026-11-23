#!/usr/bin/env python3
"""problem-tree 패널 감시 Stop 훅 — 읽기 전용(플러그인 store에 절대 쓰지 않는다).

settings.json에 등록해 쓴다(플러그인이 내려가도 도는 유일한 자리):
  {"hooks": {"Stop": [{"hooks": [{"type": "command", "timeout": 10,
     "command": "python3 ~/.claude/skills/problem-tree/hooks/ptree-watch.py"}]}]}}

하는 일 두 가지, 둘 다 "조용한 실패를 그 턴에 드러내기":
  1) 패널 생존 감시: 플러그인은 살아 있는 동안 매 턴 시작에 자기 store의 diag:<세션id>에 한 줄을
     쓴다(박동). 직전 Stop 이후 박동이 없으면 패널·MCP 도구가 이 세션에서 죽은 것 →
     systemMessage로 사용자에게 알린다(같은 세션 10분에 한 번, Stop은 안 막는다).
  2) 폐지된 숨김 주석 안내: 예전엔 응답 끝의 <!--PTREE {json}--> 주석을 이 훅이 긁어 store에
     반영했다. 그 경로는 폐지됐다(턴 안에서 MCP 도구를 직접 부른다). 변경이 담긴 주석이 아직
     들어오면 "반영 안 됐다, MCP 도구로 직접 반영하라"고 한 번 되돌려 보낸다(같은 주석은 1회).

신뢰경계: stdin·transcript·store 파일·상태 파일은 전부 신뢰하지 않는 입력으로 다룬다 — 크기 상한,
형식 검사, 예외는 삼키고 Stop 허용. 이 훅이 쓰는 파일은 자기 상태 파일 하나뿐(원자적 교체).
"""
import hashlib
import json
import os
import re
import sys
import time

CONFIG_DIR = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
STORE_DIR = os.environ.get("PTREE_STORE_DIR") or os.path.join(CONFIG_DIR, "plugins", "store")
STATE = os.environ.get("PTREE_HOOK_STATE") or os.path.join(
    CONFIG_DIR, "plugins", "data", "problem-tree-hook", "state.json")

WARN_EVERY_MS = 10 * 60 * 1000      # 같은 세션에 죽음 경고를 다시 띄우는 최소 간격
STATE_KEEP = 100                    # 상태 파일에 남기는 세션 수
STORE_MAX_BYTES = 16 * 1024 * 1024  # 이보다 큰 store 파일은 읽지 않는다($.store 상한은 4 MiB)
TAIL_BYTES = 512 * 1024             # transcript는 꼬리만 읽는다
DIRECTIVE_MAX = 64 * 1024           # 이보다 긴 주석은 무시
SAME_STOP_MS = int(os.environ.get("PTREE_SAME_STOP_MS") or 1500)   # 이 안에 다시 불리면 같은 Stop(훅 중복 등록)
LEGACY_OPS = ("add", "resolve", "rename")

PANEL_DEAD = ("⚠ 문제트리 패널이 이 세션에서 꺼져 있습니다(플러그인이 로드되지 않음 — 화면에 안 보일 뿐 "
              "노드 데이터는 보존됨). 복구: /reload-plugins → 그래도 없으면 `claude plugin list`로 "
              "problem-tree 상태를 확인하고 세션을 다시 시작하세요.")
LEGACY_NOTICE = ("문제트리: 숨김 주석(PTREE) 경로는 폐지돼 방금 주석의 변경은 반영되지 않았다. "
                 "같은 변경을 MCP 도구(add_problem·resolve_problem·rename_problem·move_problem)로 "
                 "지금 직접 반영하고, 앞으로는 주석을 쓰지 말 것.")


def now_ms():
    return int(time.time() * 1000)


# ---------- 상태 파일(이 훅만의 것) ----------

def load_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save_state(st):
    """저장에 성공하면 True. 실패해도 예외는 내지 않는다(Stop을 방해하지 않게)."""
    try:
        if len(st) > STATE_KEEP:
            def stop_at(k):
                v = st[k].get("stopAt") if isinstance(st[k], dict) else None
                return v if isinstance(v, (int, float)) else 0
            st = {k: st[k] for k in sorted(st, key=stop_at)[-STATE_KEEP:]}
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        tmp = "%s.tmp.%d" % (STATE, os.getpid())
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(st, f)
        os.replace(tmp, STATE)          # 원자적 교체: 중단돼도 반쯤 쓴 파일이 남지 않는다
        return True
    except Exception:
        return False


# ---------- 1) 패널 생존 ----------

def store_files():
    """플러그인 store 파일들(설치 식별자마다 1개: problem-tree_<source>-<hash>.json)."""
    try:
        names = sorted(os.listdir(STORE_DIR))
    except Exception:
        return []
    return [os.path.join(STORE_DIR, n) for n in names
            if re.fullmatch(r"problem-tree_[A-Za-z0-9._-]+\.json", n)]


def last_beat(sid):
    """모든 store 파일에서 이 세션의 마지막 박동 시각(ms). 한 번도 없으면 None.
    'complete'(턴 끝)는 Stop 뒤에 찍힐 수 있어 박동으로 안 센다 — 턴 '시작' 계열만."""
    newest = None
    for path in store_files():
        try:
            if os.path.getsize(path) > STORE_MAX_BYTES:
                continue
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
            if isinstance(at, (int, float)) and not isinstance(at, bool) and (newest is None or at > newest):
                newest = at
    return newest


def panel_alive(row, sid):
    prev = row.get("stopAt")
    beat = last_beat(sid)
    return beat is not None and (not isinstance(prev, (int, float)) or beat > prev)


# ---------- 2) 폐지된 주석 ----------

def trailing_directive(text):
    """글이 PTREE 주석으로 '끝날' 때만 그 JSON 본문을 돌려준다(옛 규약: 응답 맨 끝 1줄).
    글 중간의 주석은 인용·예시일 수 있어 보지 않는다. 정규식 없이 선형 탐색(거대·악성 입력에 2차 시간 금지)."""
    t = text.rstrip()
    if not t.endswith("-->"):
        return None
    start = t.rfind("<!--")
    if start < 0:
        return None
    inner = t[start + 4:-3].strip()
    if not inner.startswith("PTREE"):
        return None
    body = inner[5:].strip()
    if not body.startswith("{") or len(body) > DIRECTIVE_MAX:
        return None
    return body


def last_legacy_directive(transcript_path):
    """transcript 꼬리의 assistant 글 중, 변경이 담긴 PTREE 주석으로 끝나는 마지막 글의 지문. 없으면 None."""
    try:
        size = os.path.getsize(transcript_path)
        with open(transcript_path, "rb") as f:
            f.seek(max(0, size - TAIL_BYTES))
            raw = f.read(TAIL_BYTES)
    except Exception:
        return None
    found = None
    for ln in raw.decode("utf-8", errors="ignore").splitlines():
        if "PTREE" not in ln:
            continue
        try:
            e = json.loads(ln)
        except Exception:
            continue                    # 잘린 첫 줄·깨진 줄
        if not isinstance(e, dict) or e.get("type") != "assistant":
            continue
        msg = e.get("message")
        content = msg.get("content") if isinstance(msg, dict) else None
        if not isinstance(content, list):
            continue
        for b in content:
            if not (isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str)):
                continue
            body = trailing_directive(b["text"])
            if body is None:
                continue
            try:
                obj = json.loads(body)
            except Exception:
                continue
            if isinstance(obj, dict) and any(isinstance(obj.get(k), list) and obj.get(k) for k in LEGACY_OPS):
                found = hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]
    return found


# ---------- main ----------

def decide(inp):
    """Stop 훅 출력(dict). 빈 dict = 아무것도 안 함."""
    if os.environ.get("CLAUDE_PLUGIN_ROOT"):
        return {}                       # 플러그인이 돌린 사본 = 플러그인 로드됨. 판정은 settings 등록분 하나만.
    sid = inp.get("session_id")
    if not isinstance(sid, str) or not sid or inp.get("stop_hook_active"):
        return {}                       # block 뒤 재진입은 같은 턴 → 다시 재지 않는다
    st = load_state()
    row = st.get(sid) if isinstance(st.get(sid), dict) else {}
    now = now_ms()
    prev = row.get("stopAt")
    if isinstance(prev, (int, float)) and 0 <= now - prev < SAME_STOP_MS:
        return {}                       # 같은 Stop에 두 번 불림(중복 등록) → 방금 판정이 유효, 다시 재면 오탐
    out = {}

    alive = panel_alive(row, sid)
    if alive:
        row.pop("warnAt", None)         # 되살아나면 다음에 또 죽을 때 즉시 경고
    else:
        warned = row.get("warnAt")
        if not isinstance(warned, (int, float)) or now - warned >= WARN_EVERY_MS:
            row["warnAt"] = now
            out["systemMessage"] = PANEL_DEAD

    tp = inp.get("transcript_path")
    legacy = last_legacy_directive(tp) if isinstance(tp, str) and tp else None
    if alive and legacy and legacy != row.get("legacy"):
        # 패널이 죽어 있으면(도구 없음) 되돌려 보내도 반영할 길이 없다 → 위 경고만 하고, 되살아난 뒤 알린다.
        row["legacy"] = legacy
        out["decision"] = "block"
        out["reason"] = LEGACY_NOTICE

    row["stopAt"] = now
    st[sid] = row
    if not save_state(st):
        out.pop("decision", None)       # "한 번만"을 기억 못 하면 매 턴 되돌려 보내게 된다 → 안 막는다
        out.pop("reason", None)
    return out


def main():
    try:
        inp = json.load(sys.stdin)
        out = decide(inp) if isinstance(inp, dict) else {}
    except Exception:
        out = {}                        # 무슨 일이 있어도 Stop은 허용
    if out:
        print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
