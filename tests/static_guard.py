#!/usr/bin/env python3
"""소스 글자 그대로 보는 불변식 검사(가드 '가'의 보강).
tests/guards.test.tsx는 테스트 런타임에 파일을 못 읽어 export된 함수의 toString만 본다 → 비export
헬퍼 안의 주입은 못 잡는다. 이 스크립트는 파일 전체를 읽는다. 실행: python3 tests/static_guard.py"""
import os
import re
import sys
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
HOOKS = os.path.join(ROOT, "hooks")
STORE = os.path.join("hooks", "lib", "store.ts")
SESSION = os.path.join("hooks", "lib", "session.ts")


def sources():
    for d, _, files in os.walk(HOOKS):
        for f in files:
            if f.endswith((".ts", ".tsx")):
                p = os.path.join(d, f)
                with open(p, encoding="utf-8") as fh:
                    yield os.path.relpath(p, ROOT), fh.read()


def strip_comments(src):
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return "\n".join(ln.split("//")[0] if "://" not in ln else ln for ln in src.splitlines())


class StaticGuard(unittest.TestCase):
    def offenders(self, pattern, allow=()):
        rx = re.compile(pattern)
        return [(p, m.group(0)) for p, src in sources() if p not in allow
                for m in rx.finditer(strip_comments(src))]

    def test_store_writes_only_in_store_ts(self):
        # $.store.set / .delete / 대괄호 접근 / store 객체를 꺼내 쓰는 꼴
        self.assertEqual(self.offenders(r"\.store\s*(\.\s*(set|delete)\b|\[)", allow=(STORE,)), [])
        self.assertEqual(self.offenders(r"=\s*\$\.store\b(?!\.)", allow=()), [])
        self.assertEqual(self.offenders(r"\bnodesAtom\b", allow=(STORE,)), [])

    def test_the_check_is_not_vacuous(self):
        self.assertTrue(self.offenders(r"\.store\s*\.\s*set\b"))      # store.ts에는 실제로 있다
        self.assertGreaterEqual(len(list(sources())), 8)

    def test_no_file_writes_or_processes(self):
        # 플러그인 모듈은 파일을 쓰지도 프로세스를 띄우지도 네트워크를 타지도 않는다(읽기 $.fs.list/read만).
        self.assertEqual(self.offenders(r"\$\.fs\s*\.\s*(write|remove|rename|mkdir)\b"), [])
        self.assertEqual(self.offenders(r"\$\.(process|http)\b"), [])

    def test_session_atoms_only_in_session_ts(self):
        self.assertEqual(self.offenders(r"\b(turnAtom|pointerAtom|agentBindAtom|tasksAtom)\b", allow=(SESSION,)), [])

    def test_hook_matchers_are_literals_in_register(self):
        # 호스트가 훅을 정적으로 읽는다: 매처에 상수·식을 쓰면 `tool=?`가 된다.
        with open(os.path.join(HOOKS, "register.tsx"), encoding="utf-8") as f:
            src = strip_comments(f.read())
        for m in re.finditer(r"\{\s*(tool|command|requestId)\s*:\s*([^,}\s][^,}]*)", src):
            self.assertRegex(m.group(2).strip(), r"^'[^']+'$", m.group(0))
        self.assertEqual(len(re.findall(r"tool: 'mcp__problem-tree__\w+'", src)), 7)
        self.assertIn("command: 'ptree'", src)
        self.assertIn("requestId: 'problem-tree'", src)
        self.assertIn("name: 'ptree'", src)


if __name__ == "__main__":
    unittest.main(verbosity=1)
