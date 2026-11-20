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

def _resolve_store():
    """problem-tree 노드 store 파일 경로(기기 독립). PTREE_STORE 로 테스트 오버라이드 가능.
    설치/기기마다 파일 해시가 달라서 하드코딩하지 않고 node:/schema 를 가진 파일을 자동 선택."""
    env = os.environ.get("PTREE_STORE")
    if env:
        return env
    import glob
    cands = sorted(glob.glob(os.path.expanduser("~/.claude/plugins/store/problem-tree_*.json")))
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
    return fallback or (cands[0] if cands else
                        os.path.expanduser("~/.claude/plugins/store/problem-tree_store.json"))


STORE = _resolve_store()
DIRECTIVE_RE = re.compile(r"<!--\s*PTREE\s*(.*?)-->", re.S)   # 각 주석 내용을 비탐욕 캡처
TITLE_MAX = 16


def now_ms():
    return int(time.time() * 1000)


def block(reason):
    print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
    sys.exit(0)


def read_stdin():
    try:
        return json.load(sys.stdin)
    except Exception:
        return {}


def assistant_text_this_turn(transcript_path):
    """마지막 genuine user 프롬프트 이후의 assistant text 블록을 모아 반환(없으면 None)."""
    if not transcript_path or not os.path.exists(transcript_path):
        return None
    entries = []
    try:
        with open(transcript_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except Exception:
                    pass
    except Exception:
        return None
    last_user = -1
    for i, e in enumerate(entries):
        if e.get("type") != "user":
            continue
        if e.get("isMeta"):
            continue                    # Stop 훅 피드백 등 주입 메시지는 '진짜 프롬프트' 아님
        c = (e.get("message") or {}).get("content")
        is_prompt = False
        if isinstance(c, str):
            is_prompt = True
        elif isinstance(c, list):
            has_tr = any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c)
            has_tx = any(isinstance(b, dict) and b.get("type") == "text" for b in c)
            is_prompt = has_tx and not has_tr
        if is_prompt:
            last_user = i
    texts = []
    for e in entries[last_user + 1:]:
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
    inp = read_stdin()
    stop_active = bool(inp.get("stop_hook_active"))     # block 후 재시도면 True
    tp = inp.get("transcript_path")
    directive, raws = _scan(tp)
    if directive is None and raws is None:
        sys.exit(0)                     # transcript 못 읽음 → Stop 막지 않음
    # flush race 대비: 내 마지막 블록(지시)이 아직 파일에 안 써졌을 수 있어 잠깐 기다렸다 재시도
    if directive is None and not stop_active:
        for _ in range(5):
            time.sleep(0.3)
            directive, raws = _scan(tp)
            if directive is not None:
                break
    if directive is None:
        if stop_active:
            sys.exit(0)                 # 재시도에서도 없으면 통과(무한루프 방지)
        if raws:
            block("ptree 지시 JSON 파싱 실패 — PTREE 주석 안을 올바른 JSON으로 넣어라"
                  "(예시 말고 실제 지시 1개). 형식: {tree:'<root 절대경로>', add:[{id,title,parent}], resolve:['id'], rename:[{id,title}]}.")
        block("★ptree 강제(req1,2,3): 이번 턴 작업을 다 끝냈으면 응답 맨 끝에 숨김 주석으로 "
              "ptree 지시를 넣어 이번 턴 작업내역을 반영하라. "
              "형식: PTREE 주석 안 JSON (tree=프로젝트 root 절대경로, add/resolve/rename). "
              "변경이 없으면 tree만. 이 지시 없이는 턴을 끝낼 수 없다. (HTML 주석이라 화면에 안 보임.)")
    res = apply_ops(directive, inp.get("cwd") or "")   # directive 있으면 재시도여도 적용
    if res.get("error") and not stop_active:
        block("ptree 적용 실패: %s. tree(프로젝트 root 절대경로)를 지시에 넣어라." % res["error"])
    sys.exit(0)                         # 적용 완료 → Stop 허용(조용히)


if __name__ == "__main__":
    main()
