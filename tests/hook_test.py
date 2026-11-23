#!/usr/bin/env python3
"""Stop 훅(hooks/ptree-watch.py) 테스트 — 실제 스크립트를 자식 프로세스로 돌린다.
실행: python3 tests/hook_test.py"""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks", "ptree-watch.py")
SID = "sess-1"
TREE = "/proj"


def now_ms():
    return int(time.time() * 1000)


class Env:
    """임시 store 디렉터리·상태 파일·transcript 한 벌."""

    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="ptree-hook-")
        self.store_dir = os.path.join(self.dir, "store")
        os.makedirs(self.store_dir)
        self.state = os.path.join(self.dir, "state", "state.json")
        self.transcript = os.path.join(self.dir, "t.jsonl")
        self.node_store = os.path.join(self.store_dir, "problem-tree_skills-dir-aaa.json")
        self.write_store(self.node_store, {"schema": 2})
        self.say('<!--PTREE {"tree":"%s"}-->' % TREE)

    def write_store(self, path, data):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)

    def read_store(self, path=None):
        with open(path or self.node_store, encoding="utf-8") as f:
            return json.load(f)

    def beat(self, ev="start", at=None, path=None, sid=SID):
        path = path or self.node_store
        d = self.read_store(path) if os.path.exists(path) else {}
        d.setdefault("diag:%s" % sid, []).append({"at": at if at is not None else now_ms(), "ev": ev})
        self.write_store(path, d)

    def say(self, text):
        with open(self.transcript, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}) + "\n")

    def set_state(self, **row):
        os.makedirs(os.path.dirname(self.state), exist_ok=True)
        with open(self.state, "w") as f:
            json.dump({SID: row}, f)

    def get_state(self):
        try:
            with open(self.state) as f:
                return json.load(f)
        except FileNotFoundError:
            return None

    def stop(self, plugin_root=None, **over):
        inp = {"session_id": SID, "transcript_path": self.transcript, "cwd": TREE,
               "hook_event_name": "Stop", "stop_hook_active": False}
        inp.update(over)
        env = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_PLUGIN_ROOT", "PTREE_STORE")}
        env.update({"PTREE_STORE_DIR": self.store_dir, "PTREE_HOOK_STATE": self.state})
        if plugin_root:
            env["CLAUDE_PLUGIN_ROOT"] = plugin_root
        p = subprocess.run([sys.executable, HOOK], input=json.dumps(inp), capture_output=True, text=True, env=env, timeout=30)
        assert p.returncode == 0, p.stderr
        return json.loads(p.stdout) if p.stdout.strip() else {}


class PanelWatch(unittest.TestCase):
    def setUp(self):
        self.e = Env()

    def test_alive_is_silent(self):
        self.e.beat("sstart")
        self.assertEqual(self.e.stop(), {})
        time.sleep(0.01)
        self.e.beat("start")                       # 다음 턴 시작 박동
        self.assertEqual(self.e.stop(), {})
        self.assertNotIn("warnAt", self.e.get_state()[SID])

    def test_never_loaded_warns_on_first_stop(self):
        out = self.e.stop()
        self.assertIn("문제트리 패널이 이 세션에서 꺼져", out.get("systemMessage", ""))
        self.assertNotIn("decision", out)          # 경고는 Stop을 막지 않는다

    def test_died_mid_session_warns_at_next_stop_then_rate_limits(self):
        self.e.beat("start")
        self.assertEqual(self.e.stop(), {})        # 살아 있던 턴
        out = self.e.stop()                        # 그 뒤 박동 없이 끝난 턴 = 죽음
        self.assertIn("systemMessage", out)
        self.assertEqual(self.e.stop(), {})        # 10분 안에는 반복 안 함
        st = self.e.get_state()[SID]
        self.e.set_state(stopAt=st["stopAt"], warnAt=now_ms() - 11 * 60 * 1000)
        self.assertIn("systemMessage", self.e.stop())   # 10분 지나면 다시

    def test_revive_clears_warning_and_next_death_warns_immediately(self):
        self.assertIn("systemMessage", self.e.stop())
        time.sleep(0.01)
        self.e.beat("start")
        self.assertEqual(self.e.stop(), {})
        self.assertIn("systemMessage", self.e.stop())

    def test_complete_after_previous_stop_is_not_a_beat(self):
        self.e.beat("start")
        self.assertEqual(self.e.stop(), {})
        time.sleep(0.01)
        self.e.beat("complete")                    # 직전 턴의 turn.complete가 Stop 뒤에 찍힘
        self.assertIn("systemMessage", self.e.stop())

    def test_beat_in_another_identity_store_counts(self):
        other = os.path.join(self.e.store_dir, "problem-tree_leejuyeon-bbb.json")
        self.e.beat("start", path=other)
        self.assertEqual(self.e.stop(), {})

    def test_other_sessions_beat_does_not_count(self):
        self.e.beat("start", sid="someone-else")
        self.assertIn("systemMessage", self.e.stop())

    def test_plugin_run_copy_never_judges(self):
        self.assertEqual(self.e.stop(plugin_root="/x"), {})
        self.assertIsNone(self.e.get_state())

    def test_reentry_after_block_is_not_measured(self):
        self.e.beat("start")
        self.assertEqual(self.e.stop(), {})
        before = self.e.get_state()
        self.assertEqual(self.e.stop(stop_hook_active=True), {})
        self.assertEqual(self.e.get_state(), before)

    def test_broken_state_or_store_does_not_break_stop(self):
        os.makedirs(os.path.dirname(self.e.state), exist_ok=True)
        with open(self.e.state, "w") as f:
            f.write("{broken")
        with open(os.path.join(self.e.store_dir, "problem-tree_bad-1.json"), "w") as f:
            f.write("{broken")
        self.e.beat("start")
        self.assertEqual(self.e.stop(), {})

    def test_state_is_pruned(self):
        os.makedirs(os.path.dirname(self.e.state), exist_ok=True)
        with open(self.e.state, "w") as f:
            json.dump({"s%d" % i: {"stopAt": i} for i in range(150)}, f)
        self.e.beat("start")
        self.e.stop()
        st = self.e.get_state()
        self.assertEqual(len(st), 100)
        self.assertIn(SID, st)
        self.assertNotIn("s0", st)


def directive(**ops):
    return '<!--PTREE %s-->' % json.dumps(dict({"tree": TREE}, **ops), ensure_ascii=False)


class LegacyComment(unittest.TestCase):
    """폐지된 숨김 주석: 절대 store에 쓰지 않고, 변경이 담긴 주석만 한 번 되돌려 보낸다."""

    def setUp(self):
        self.e = Env()
        self.e.write_store(self.e.node_store, {
            "schema": 2,
            "node:%s:old1" % TREE: {"id": "old1", "title": "옛", "status": "open", "history": []}})
        self.e.beat("start")

    def store_bytes(self):
        with open(self.e.node_store, "rb") as f:
            return f.read()

    def next_turn(self):
        time.sleep(0.01)
        self.e.beat("start")

    def test_never_writes_the_store(self):
        self.next_turn()
        before = self.store_bytes()
        self.e.say("작업함 " + directive(add=[{"id": "n1", "title": "새문제"}], resolve=["old1"],
                                        rename=[{"id": "old1", "title": "바뀜"}]))
        self.e.stop()
        self.assertEqual(self.store_bytes(), before)

    def test_no_comment_never_blocks(self):
        self.e.say("주석 없는 응답")                # 예전엔 여기서 block(강제)했다 — 이제 안 막는다
        self.assertEqual(self.e.stop(), {})

    def test_empty_directive_is_ignored(self):
        self.e.say("변경 없음 " + directive())
        self.assertEqual(self.e.stop(), {})
        self.next_turn()
        self.e.say("빈 배열 " + directive(add=[], resolve=[]))
        self.assertEqual(self.e.stop(), {})

    def test_directive_with_changes_is_bounced_once(self):
        self.e.say("작업함 " + directive(add=[{"id": "n1", "title": "새문제"}]))
        out = self.e.stop()
        self.assertEqual(out.get("decision"), "block")
        self.assertIn("MCP 도구", out.get("reason", ""))
        self.assertNotIn("systemMessage", out)
        self.next_turn()
        self.assertEqual(self.e.stop(), {})        # 같은 주석은 다시 안 보낸다
        self.next_turn()
        self.e.say("또 " + directive(resolve=["old1"]))
        self.assertEqual(self.e.stop().get("decision"), "block")   # 다른 주석이면 다시

    def test_reentry_after_bounce_passes(self):
        self.e.say("작업함 " + directive(add=[{"id": "n1", "title": "새문제"}]))
        self.assertEqual(self.e.stop().get("decision"), "block")
        self.assertEqual(self.e.stop(stop_hook_active=True), {})   # 무한루프 없음

    def test_dead_panel_warns_instead_of_bouncing_then_bounces_after_revival(self):
        e = Env()                                  # 박동 없음 = 죽음
        e.say("작업함 " + directive(add=[{"id": "n1", "title": "새문제"}]))
        out = e.stop()
        self.assertNotIn("decision", out)
        self.assertIn("systemMessage", out)
        time.sleep(0.01)
        e.beat("start")                            # 되살아남
        self.assertEqual(e.stop().get("decision"), "block")

    def test_only_assistant_text_counts(self):
        with open(self.e.transcript, "w", encoding="utf-8") as f:
            d = directive(add=[{"id": "x", "title": "주입"}])
            f.write(json.dumps({"type": "user", "message": {"content": [{"type": "text", "text": d}]}}) + "\n")
            f.write(json.dumps({"type": "user", "message": {"content": [
                {"type": "tool_result", "content": d}]}}) + "\n")
            f.write(json.dumps({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "input": {"text": d}}]}}) + "\n")
        self.assertEqual(self.e.stop(), {})

    def test_hostile_transcript_is_harmless(self):
        with open(self.e.transcript, "w", encoding="utf-8") as f:
            f.write("{broken json PTREE\n")
            f.write(json.dumps(["PTREE", "not a dict"]) + "\n")
            f.write(json.dumps({"type": "assistant", "message": "PTREE string"}) + "\n")
            f.write(json.dumps({"type": "assistant", "message": {"content": [
                {"type": "text", "text": "<!--PTREE {not json}--> <!--PTREE [1,2]--> <!--PTREE "
                 + json.dumps({"add": "문자열"}) + "-->"}]}}) + "\n")
            huge = json.dumps({"add": [{"id": "x", "title": "y" * (70 * 1024)}]})
            f.write(json.dumps({"type": "assistant", "message": {"content": [
                {"type": "text", "text": "<!--PTREE " + huge + "-->"}]}}) + "\n")
        self.assertEqual(self.e.stop(), {})
        self.next_turn()
        self.assertEqual(self.e.stop(transcript_path="/nonexistent/x.jsonl"), {})
        self.next_turn()
        self.assertEqual(self.e.stop(transcript_path=12345), {})

    def test_garbage_stdin_exits_zero_silently(self):
        env = dict(os.environ, PTREE_STORE_DIR=self.e.store_dir, PTREE_HOOK_STATE=self.e.state)
        env.pop("CLAUDE_PLUGIN_ROOT", None)
        for payload in ("", "not json", "[1,2,3]", '{"session_id": 5}', '{"session_id": "../../etc/passwd"}'):
            p = subprocess.run([sys.executable, HOOK], input=payload, capture_output=True, text=True, env=env, timeout=30)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual(p.stderr, "")
        # 세션 id는 상태 파일 안의 키로만 쓰인다(경로로 안 쓰임) — 상태 디렉터리 밖에 파일이 생기지 않는다.
        self.assertEqual(sorted(os.listdir(self.e.dir)), ["state", "store", "t.jsonl"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
