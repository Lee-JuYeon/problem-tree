#!/usr/bin/env python3
"""소스 글자 그대로 보는 불변식 검사(가드 '가'의 보강).
tests/guards.test.tsx는 테스트 런타임에 파일을 못 읽어 export된 함수의 toString만 본다 → 비export
헬퍼 안의 주입은 못 잡는다. 이 스크립트는 파일 전체를 읽고(StaticGuard), 호스트 자신의 스캔 결과도 본다
(HostScan). 정규식을 피하는 철자(`const {store} = $`·`$?.store`·`$['store']`·`$.fs['write']`)는 호스트가
모듈 로드 자체를 거부하므로(`claude plugin test`가 "did not load"로 전부 실패) 여기서 따로 막지 않는다.
실행: python3 tests/static_guard.py"""
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


class HostScan(unittest.TestCase):
    """호스트 자신의 정적 스캔(`claude plugin validate`의 calls 줄)으로 본다 — 위 정규식과 달리
    구조분해·옵셔널 체이닝·대괄호 접근 같은 우회가 통하지 않는다(호스트가 그렇게 읽는 대로가 곧 사실)."""

    # 이 플러그인이 `$`로 닿는 것 전부(권한 표면). 늘리려면 여기를 고치며 이유를 남긴다.
    ALLOWED = {
        "$.clock.every", "$.clock.now", "$.command.register", "$.env.get", "$.fs.list", "$.fs.read",
        "$.session.id", "$.session.root", "$.state.get", "$.state.set",
        "$.store.delete", "$.store.get", "$.store.keys", "$.store.set",
        "$.tool.register", "$.ui.invalidate", "$.ui.open", "$.ui.resolve", "$.ui.toast",
    }

    @classmethod
    def setUpClass(cls):
        import shutil
        import subprocess
        exe = shutil.which("claude")
        if not exe:
            raise unittest.SkipTest("claude CLI 없음")
        out = subprocess.run([exe, "plugin", "validate", ROOT], capture_output=True, text=True, timeout=120).stdout
        cls.calls = {}
        for ln in out.splitlines():
            if "register.tsx calls:" not in ln:
                continue
            for m in re.finditer(r"(\$\.[A-Za-z.]+)(?: \(via ([^)]*)\))?", ln.split("calls:", 1)[1]):
                cls.calls.setdefault(m.group(1), set()).update(
                    x.strip() for x in (m.group(2) or "<register 직접>").split(","))
        if not cls.calls:
            raise unittest.SkipTest("validate 출력에 calls 줄 없음(형식 변경?)")

    def test_capability_surface_is_pinned(self):
        self.assertEqual(set(self.calls), self.ALLOWED)

    def test_store_writes_come_only_from_store_ts_functions(self):
        with open(os.path.join(ROOT, STORE), encoding="utf-8") as f:
            defined = set(re.findall(r"(?:function|const)\s+([A-Za-z_]\w*)", f.read()))
        elsewhere = set()
        for p, src in sources():
            if p != STORE:
                elsewhere |= set(re.findall(r"(?:function|const)\s+([A-Za-z_]\w*)", src))
        for call in ("$.store.set", "$.store.delete"):
            via = self.calls[call]
            self.assertNotIn("<register 직접>", via, call)
            self.assertEqual(via - defined, set(), "%s: store.ts 밖 함수 경유" % call)
            self.assertEqual(via & elsewhere, set(), "%s: 같은 이름이 store.ts 밖에도 있어 판별 불가" % call)


if __name__ == "__main__":
    unittest.main(verbosity=1)
