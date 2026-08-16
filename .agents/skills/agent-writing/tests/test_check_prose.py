import importlib.util
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).parents[1] / "scripts" / "check_prose.py"
SPEC = importlib.util.spec_from_file_location("check_prose", SCRIPT_PATH)
assert SPEC and SPEC.loader
CHECK_PROSE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK_PROSE)


class CheckProseTests(unittest.TestCase):
    def test_flags_prose_but_ignores_code_and_quoted_source(self):
        findings = CHECK_PROSE.check_lines(
            Path("sample.md"),
            [
                "A prohibited—mark appears here.",
                "A banned seam appears here.",
                "`seam` and `—` are code.",
                "> Quoted seam — remains exact.",
                "```text",
                "seam — inside a fence",
                "```",
            ],
        )

        self.assertEqual(len(findings), 2)
        self.assertIn("em dash", findings[0])
        self.assertIn("banned word", findings[1])

    def test_repository_markdown_passes(self):
        repository_root = Path(__file__).parents[2]
        findings = CHECK_PROSE.check_paths(CHECK_PROSE.markdown_paths(repository_root))

        self.assertEqual(findings, [])


if __name__ == "__main__":
    unittest.main()
